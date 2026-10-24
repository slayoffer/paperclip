import { X509Certificate } from "node:crypto";
import { z } from "zod";
import type { PublicationIdentity } from "@paperclipai/shared";
import type { PublicationTransaction } from "./publication-authority-context.js";

const fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const time = z.number().int().nonnegative().safe();
const registrationSchema = z.object({
  fingerprint, issuerId: z.string().min(1), certificateId: z.string().min(1),
  brokerId: z.string().uuid(), companyId: z.string().uuid(), hostId: z.string().min(1),
  validFromMs: time, validUntilMs: time,
  state: z.enum(["active", "retiring", "revoked"]),
  overlapEndsAtMs: time.nullable(),
}).strict().refine((r) => r.validFromMs < r.validUntilMs
  && (r.state !== "retiring" || (r.overlapEndsAtMs !== null
    && r.validFromMs < r.overlapEndsAtMs && r.overlapEndsAtMs <= r.validUntilMs)));
const snapshotSchema = z.object({
  registrations: z.array(registrationSchema), revokedIssuerIds: z.array(z.string().min(1)),
}).strict();

export type PublicationRegistration = z.infer<typeof registrationSchema>;
export type PublicationTrustSnapshot = z.infer<typeof snapshotSchema>;
export interface PublicationIssuer { id: string; certificatePem: string }
/** Protected code supplies this reader. It must use the authority transaction and broker locking protocol.
 * No route accepts registrations. Null or a failed read supplies no authority.
 */
export type PublicationTrustReader = (tx: PublicationTransaction) => Promise<PublicationTrustSnapshot | null>;

export function certificateFingerprint(certificate: X509Certificate) {
  return certificate.fingerprint256.replaceAll(":", "").toLowerCase();
}

export function publicationTrust(issuers: readonly PublicationIssuer[], read: PublicationTrustReader) {
  const authorities = issuers.map((issuer) => ({ id: issuer.id, certificate: new X509Certificate(issuer.certificatePem) }));
  if (!authorities.length || authorities.some((issuer) => !issuer.id || !issuer.certificate.ca)
    || new Set(authorities.map((issuer) => issuer.id)).size !== authorities.length
    || new Set(authorities.map((issuer) => certificateFingerprint(issuer.certificate))).size !== authorities.length) {
    throw new Error("An explicit, unambiguous issuer bundle is required");
  }

  async function registration(tx: PublicationTransaction, peer: X509Certificate) {
    const parsed = snapshotSchema.safeParse(await read(tx));
    if (!parsed.success) return null;
    const snapshot = parsed.data;
    const records = snapshot.registrations;
    // Reject ambiguous snapshots, including aliases across companies or hosts.
    if (new Set(records.map((r) => r.fingerprint)).size !== records.length) return null;
    for (const r of records) {
      const sameBroker = records.filter((other) => other.brokerId === r.brokerId);
      if (sameBroker.some((other) => ["companyId", "hostId", "certificateId", "issuerId"].some(
        (key) => other[key as keyof PublicationRegistration] !== r[key as keyof PublicationRegistration]))
        || sameBroker.filter((other) => other.state === "active").length > 1) return null;
    }
    const record = records.find((r) => r.fingerprint === certificateFingerprint(peer));
    if (!record || record.state === "revoked" || snapshot.revokedIssuerIds.includes(record.issuerId)) return null;
    const issuer = authorities.find((a) => a.id === record.issuerId)?.certificate;
    // Direct issuer pinning supplements the verified TLS chain. Names and serial numbers cannot substitute for a fingerprint.
    if (!issuer || peer.ca || !peer.checkIssued(issuer) || !peer.verify(issuer.publicKey)
      || !peer.keyUsage?.includes("1.3.6.1.5.5.7.3.2")) return null;
    return { record, issuer };
  }

  return {
    registration,
    async check(tx: PublicationTransaction, peer: X509Certificate, identity: PublicationIdentity, nowMs: number, hostId: string) {
      const current = await registration(tx, peer);
      if (!current) return null;
      const { record, issuer } = current;
      if (record.hostId !== hostId || ["companyId", "brokerId", "certificateId", "issuerId"].some((key) =>
        record[key as keyof PublicationRegistration] !== identity[key as keyof PublicationIdentity])) return null;
      const start = Math.max(record.validFromMs, Date.parse(peer.validFrom), Date.parse(issuer.validFrom));
      const end = Math.min(record.validUntilMs, Date.parse(peer.validTo), Date.parse(issuer.validTo),
        record.state === "retiring" ? record.overlapEndsAtMs! : Infinity);
      return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start <= nowMs && nowMs < end ? end : null;
    },
  };
}
