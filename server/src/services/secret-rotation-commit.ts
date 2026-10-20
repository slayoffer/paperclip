import { and, eq, ne, sql } from "drizzle-orm";
import { companySecrets, companySecretVersions, type Db } from "@paperclipai/db";
import { conflict, notFound } from "../errors.js";
import { invalidateRotatedConnectionHealth } from "./connection-health-credentials.js";

type RotationDb = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export async function commitSecretRotation(db: RotationDb, options: {
  secret: typeof companySecrets.$inferSelect;
  input: { expectedLatestVersion?: number; preserveAiSessionEpoch?: boolean; preserveConnectionHealth?: boolean };
  nextVersion: number;
  externalRef: string | null;
  providerConfigId: string | null;
  staleMessage: string;
}) {
  const { secret, input, nextVersion, externalRef, providerConfigId, staleMessage } = options;
  // Lock the secret before its versions. Preserve the credential write-back lock order.
  return await db.transaction(async (tx) => {
    const updated = await tx
      .update(companySecrets)
      .set({
        latestVersion: nextVersion,
        aiSessionEpoch: input.preserveAiSessionEpoch ? secret.aiSessionEpoch : sql`${companySecrets.aiSessionEpoch} + 1`,
        externalRef,
        providerConfigId,
        lastRotatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(
        eq(companySecrets.id, secret.id),
        // The compare-and-set guard. It matches the latest version, so a
        // concurrent rotation that already bumped it fails this predicate.
        input.expectedLatestVersion === undefined
          ? undefined
          : eq(companySecrets.latestVersion, input.expectedLatestVersion),
      ))
      .returning()
      .then((rows) => rows[0] ?? null);

    if (!updated) {
      // The predicate matched no row. A supplied expected version means a
      // concurrent rotation won the race; return the stale conflict. An
      // unguarded rotation means the secret is gone. Neither version row
      // has been touched yet, so there is nothing to undo here.
      throw input.expectedLatestVersion === undefined
        ? notFound("Secret not found")
        : conflict(staleMessage);
    }

    await tx
      .update(companySecretVersions)
      .set({ status: "previous" })
      .where(and(
        eq(companySecretVersions.secretId, secret.id),
        ne(companySecretVersions.version, nextVersion),
      ));
    await tx
      .update(companySecretVersions)
      .set({ status: "current" })
      .where(and(
        eq(companySecretVersions.secretId, secret.id),
        eq(companySecretVersions.version, nextVersion),
      ));

    // A provider-issued OAuth refresh is not a credential change that needs a new health test.
    if (!input.preserveConnectionHealth) await invalidateRotatedConnectionHealth(tx, secret.companyId, secret.id);
    return updated;
  });
}
