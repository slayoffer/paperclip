import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { standardImageDigest, resolveStandardImageDigest } from "./standard-image-contract.mjs";
import { isNode24ImageTag } from "./node-image-policy.mjs";

const nodeImageDigest = `@sha256:${"a".repeat(64)}`;

test("Node image policy scans suffix Dockerfiles and platform-qualified FROM", (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "node-image-policy-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  mkdirSync(join(fixture, ".github/workflows"), { recursive: true });
  for (const file of [
    ".nvmrc",
    "docker/agent-runtime/Dockerfile.base",
    "packages/adapter-utils/src/sandbox-install-command.ts",
    "packages/plugins/sandbox-providers/exe-dev/src/plugin.ts",
    "packages/plugins/sandbox-providers/modal/src/manifest.ts",
    "packages/plugins/sdk/src/bundlers.ts",
    "packages/shared/src/node-version.ts",
    "cli/esbuild.config.mjs",
    "scripts/check-node-version-policy.mjs",
    "scripts/generate-npm-package-json.mjs",
    "scripts/install.sh",
    "scripts/node-image-policy.mjs",
  ]) {
    const destination = join(fixture, file);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(new URL(`../${file}`, import.meta.url), destination);
  }
  const runPolicy = () => spawnSync(process.execPath, [join(fixture, "scripts/check-node-version-policy.mjs")], {
    encoding: "utf8",
  });
  for (const [file, instruction] of [
    ["context.Dockerfile", "FROM node:"],
    ["Dockerfile.platform", "FROM --platform=linux/amd64 node:"],
    ["Dockerfile.lowercase", "from node:"],
    ["context.dOcKeRfIlE", "from --platform=linux/amd64 node:"],
  ]) {
    const dockerfile = join(fixture, file);
    writeFileSync(dockerfile, `${instruction}24-slim${nodeImageDigest}\n`);
    const rejected = runPolicy();
    assert.equal(rejected.status, 1, `${file}: ${rejected.stderr}`);
    assert.ok(rejected.stderr.includes(`${file}: Node base image requires`), rejected.stderr);
    writeFileSync(dockerfile, `${instruction}24.22.1-bookworm-slim${nodeImageDigest}\n`);
    const accepted = runPolicy();
    assert.equal(accepted.status, 0, accepted.stderr);
  }
});

test("Node image policy rejects oversized minor and patch components", () => {
  const oversized = "9".repeat(320);
  assert.equal(isNode24ImageTag(`24.${oversized}.1-bookworm-slim${nodeImageDigest}`), false);
  assert.equal(isNode24ImageTag(`24.22.${oversized}-bookworm-slim${nodeImageDigest}`), false);
});

for (const tag of [
  `24.22.1-trixie-slim${nodeImageDigest}`,
  `24.22.2-bookworm${nodeImageDigest}`,
  `24.23.0-alpine3.24${nodeImageDigest}`,
]) {
  test(`Node image policy accepts ${tag.split("@")[0]} with a digest`, () => {
    assert.equal(isNode24ImageTag(tag), true);
  });
}

for (const tag of [
  `24.11.0-trixie-slim${nodeImageDigest}`,
  `24.22.0-trixie-slim${nodeImageDigest}`,
  "24.22.1-trixie-slim",
  "24-trixie-slim",
  `24-trixie-slim${nodeImageDigest}`,
  `24.22-trixie-slim${nodeImageDigest}`,
  "24.22.1-trixie-slim@sha256:short",
  `24.22.1-trixie-slim${nodeImageDigest}junk`,
  `25.22.1-trixie-slim${nodeImageDigest}`,
  `24.022.1-trixie-slim${nodeImageDigest}`,
  `24.22.1-${nodeImageDigest}`,
]) {
  test(`Node image policy rejects ${tag}`, () => {
    assert.equal(isNode24ImageTag(tag), false);
  });
}

const descriptor = architecture => ({ platform: { os: "linux", architecture }, digest: `sha256:${"a".repeat(64)}`, size: 100 });
const index = manifests => Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests }));
test("signs the exact registry bytes, including both supported platforms", () => {
  const bytes = index([descriptor("amd64"), descriptor("arm64")]);
  assert.equal(standardImageDigest(bytes), `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
});
test("rejects incomplete, ambiguous, or malformed platform manifests", () => {
  for (const manifests of [[descriptor("amd64")], [descriptor("amd64"), descriptor("amd64"), descriptor("arm64")],
    [{ ...descriptor("amd64"), digest: "mutable-tag" }, descriptor("arm64")],
    [{ ...descriptor("amd64"), size: -1 }, descriptor("arm64")]]) assert.throws(() => standardImageDigest(index(manifests)));
});


test("lookup hashes registry bytes and rejects formatting or header mismatches", async () => {
  const raw = index([descriptor("amd64"), descriptor("arm64")]);
  const expected = standardImageDigest(raw);
  let appendNewline = false;
  const fetchImpl = async (url, options) => {
    assert.equal(options.redirect, "error");
    if (url.includes("/token?")) return Response.json({ token: "public-fixture" });
    assert.ok(url.endsWith(`sha-${"a".repeat(40)}`));
    assert.equal(options.headers.authorization, "Bearer public-fixture");
    return new Response(appendNewline ? Buffer.concat([raw, Buffer.from("\n")]) : raw, { headers: { "docker-content-digest": expected } });
  };
  assert.equal(await resolveStandardImageDigest("a".repeat(40), fetchImpl), expected);
  appendNewline = true;
  await assert.rejects(resolveStandardImageDigest("a".repeat(40), fetchImpl), /Registry digest/);
});


test("bounded retries cover token failures, propagation lag and rate limits", async () => {
  const raw = index([descriptor("amd64"), descriptor("arm64")]);
  const expected = standardImageDigest(raw);
  const waits = [];
  let tokens = 0, manifests = 0;
  const fetchImpl = async url => {
    if (url.includes("/token?")) {
      if (++tokens === 1) throw new Error("transient connection reset");
      if (tokens === 2) return new Response(null, { status: 503 });
      return Response.json({ token: "public-fixture" });
    }
    if (++manifests === 1) return new Response(null, { status: 404 });
    if (manifests === 2) return new Response(null, { status: 429, headers: { "retry-after": "120" } });
    return new Response(raw, { headers: { "docker-content-digest": expected } });
  };
  assert.equal(await resolveStandardImageDigest("a".repeat(40), fetchImpl, { sleep: async ms => { waits.push(ms); } }), expected);
  assert.deepEqual(waits, [1000, 2000, 1000, 30000]);
  assert.equal(tokens, 3); assert.equal(manifests, 3);
});

test("permanent registry errors fail immediately and transient errors exhaust a finite budget", async () => {
  for (const [status, expectedCalls] of [[401, 1], [403, 1], [503, 5]]) {
    let calls = 0;
    await assert.rejects(resolveStandardImageDigest("a".repeat(40), async () => { calls++; return new Response(null, { status }); }, { sleep: async () => {} }), /Registry lookup failed/);
    assert.equal(calls, expectedCalls);
  }
});

test("optional lookup falls back only for a missing manifest", async () => {
  for (const status of [401, 403, 404, 503]) {
    let calls = 0;
    const lookup = resolveStandardImageDigest("a".repeat(40), async url => {
      if (url.includes("/token?")) return Response.json({ token: "public-fixture" });
      calls++;
      return new Response(null, { status });
    }, { missing: "return-null", sleep: async () => {} });
    if (status === 404) assert.equal(await lookup, null);
    else await assert.rejects(lookup, /Registry lookup failed/);
    assert.equal(calls, status === 503 ? 5 : 1);
  }
});
