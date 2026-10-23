import { execFileSync } from "node:child_process";
import { randomUUID, X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, Agent, type RequestOptions } from "node:https";
import type { TLSSocket } from "node:tls";
import { once } from "node:events";
import type { Db } from "@paperclipai/db";
import type { PublicationDecision } from "@paperclipai/shared";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { authorityFixture } from "./publication-authority.test-fixture.js";
import { createPublicationAuthorityListener } from "./publication-authority-listener.js";
import { certificateFingerprint, type PublicationRegistration, type PublicationTrustSnapshot } from "./publication-authority-trust.js";

interface Material { key: string; cert: string }

/** Temporary, synthetic keys only. No fixture key or certificate enters the repository. */
export function syntheticCertificates() {
  const directory = mkdtempSync(join(tmpdir(), "paperclip-synthetic-certificates-"));
  const file = (name: string) => join(directory, name);
  const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
  function issuer(name: string) {
    openssl("req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", file(`${name}.key`), "-out", file(`${name}.pem`), "-subj", `/CN=${name}`,
      "-days", "2", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
    return readFileSync(file(`${name}.pem`), "utf8");
  }
  function leaf(name: string, ca: string, server = false): Material {
    openssl("req", "-new", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-keyout", file(`${name}.key`), "-out", file(`${name}.csr`), "-subj", `/CN=${name}`);
    writeFileSync(file(`${name}.ext`), ["basicConstraints=critical,CA:FALSE", "keyUsage=critical,digitalSignature",
      `extendedKeyUsage=${server ? "serverAuth" : "clientAuth"}`,
      `subjectAltName=DNS:${server ? "authority.synthetic" : name}`, ""].join("\n"));
    openssl("x509", "-req", "-in", file(`${name}.csr`), "-CA", file(`${ca}.pem`), "-CAkey", file(`${ca}.key`),
      "-set_serial", `0x${randomUUID().replaceAll("-", "")}`, "-out", file(`${name}.pem`), "-days", "1", "-extfile", file(`${name}.ext`));
    return { key: readFileSync(file(`${name}.key`), "utf8"), cert: readFileSync(file(`${name}.pem`), "utf8") };
  }
  try {
    const ca = issuer("synthetic-issuer"), otherCa = issuer("untrusted-issuer");
    return {
      ca, otherCa, server: leaf("authority", "synthetic-issuer", true),
      broker: leaf("host-one", "synthetic-issuer"), replacement: leaf("host-one-renewed", "synthetic-issuer"),
      unknown: leaf("unregistered-host", "synthetic-issuer"), other: leaf("wrong-issuer-host", "untrusted-issuer"),
      wrongPurpose: leaf("server-only", "synthetic-issuer", true),
      dispose: () => rmSync(directory, { recursive: true, force: true }),
    };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

export async function transportFixture(db: Db, material: ReturnType<typeof syntheticCertificates>) {
  const fixture = await authorityFixture(db, Date.now());
  const now = (await fixture.clock()).wallMs;
  const { companyId, brokerId, certificateId, issuerId } = fixture.identity;
  const registration: PublicationRegistration = {
    companyId, brokerId, certificateId, issuerId,
    fingerprint: certificateFingerprint(new X509Certificate(material.broker.cert)),
    hostId: "synthetic-host-one", validFromMs: now - 1_000, validUntilMs: now + 60_000,
    state: "active", overlapEndsAtMs: null,
  };
  let snapshot: PublicationTrustSnapshot | null = { registrations: [registration], revokedIssuerIds: [] };
  let unavailable = false;
  let beforeTrustRead: ((count: number) => void) | undefined;
  let trustReads = 0;
  const server = createPublicationAuthorityListener({
    enabled: true, db, key: material.server.key, cert: material.server.cert,
    issuers: [{ id: fixture.identity.issuerId, certificatePem: material.ca }], clock: fixture.clock,
    readTrust: async () => {
      beforeTrustRead?.(++trustReads);
      if (unavailable) throw new Error("Synthetic trust outage");
      return snapshot;
    },
  })!;
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a fixture TCP endpoint");
  const port = address.port;
  const token = createLocalAgentJwt(fixture.identity.agentId, fixture.identity.companyId, "codex_local", fixture.identity.runId)!;
  const agents: Agent[] = [];
  function client(certificates: Material | null = material.broker, overrides: RequestOptions & { session?: Buffer } = {}) {
    const agent = new Agent({ keepAlive: true, maxCachedSessions: 0 });
    agents.push(agent);
    let socket: TLSSocket | undefined;
    let session: Buffer | undefined;
    return {
      get socket() { return socket; },
      get session() { return session; },
      post(path: string, body: unknown = fixture.bindings, headers: Record<string, string> = {}) {
        return new Promise<{ status: number; decision: PublicationDecision }>((resolve, reject) => {
          const data = JSON.stringify(body);
          const req = request({
            hostname: "127.0.0.1", port, servername: "authority.synthetic", ca: material.ca,
            ...certificates, agent, method: "POST", path, ...overrides,
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
          }, (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => {
              try { resolve({ status: res.statusCode!, decision: JSON.parse(Buffer.concat(chunks).toString()) }); }
              catch (error) { reject(error); }
            });
          });
          req.on("socket", (connected) => {
            socket = connected as TLSSocket;
            socket.on("session", (value) => { session = value; });
          });
          req.on("error", reject);
          req.setTimeout(4_000, () => req.destroy(new Error("Synthetic request timeout")));
          req.end(data);
        });
      },
    };
  }
  return {
    ...fixture, server, client, token, registration,
    get snapshot() { return snapshot!; },
    setTrust: (value: PublicationTrustSnapshot | null) => { snapshot = value; },
    failTrust: () => { unavailable = true; },
    beforeTrustRead: (callback: (count: number) => void) => { trustReads = 0; beforeTrustRead = callback; },
    close: async () => {
      for (const agent of agents) agent.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
