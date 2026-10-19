import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inspectImage, plan, pushImage, receipt } from "../synthiq-image.mjs";

const revision = "58280d4c573d01a9a4b5d4adfe7a1db389f3ad6f";
const version = "2026.1012.0-synthiq.19";
const image = `registry.synthiq.ru/paperclip:${version}`;
const labels = {
  "org.opencontainers.image.source": "https://github.com/slayoffer/paperclip",
  "org.opencontainers.image.revision": revision,
  "org.opencontainers.image.version": version,
};
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const config = JSON.stringify({ config: { Labels: labels } });
const image_id = hash(config);
const spec = { revision, version, image, image_id };
const env = { REF_NAME: "synthiq/2026.1012.0", RUN_NUMBER: "20", GITHUB_SHA: "b".repeat(40) };

test("normal builds use the run number and current revision", () => {
  assert.deepEqual(plan(env), {
    version: "2026.1012.0-synthiq.20", image: "registry.synthiq.ru/paperclip:2026.1012.0-synthiq.20",
    revision: env.GITHUB_SHA, image_id: "",
  });
});

test("recovery preserves the old version, revision, and configuration digest", () => {
  assert.deepEqual(plan({ ...env, EXISTING_VERSION: version, EXISTING_REVISION: revision, EXISTING_ID: image_id }), spec);
});

test("reject partial recovery, other branches, and shell text", () => {
  for (const change of [
    { EXISTING_VERSION: version }, { EXISTING_REVISION: revision }, { EXISTING_ID: image_id },
    { REF_NAME: "review/example" }, { REF_NAME: "2026.1012.0" }, { RUN_NUMBER: "1\nother=value" },
    { EXISTING_VERSION: "2026.1001.0-synthiq.19", EXISTING_REVISION: revision, EXISTING_ID: image_id },
    { EXISTING_VERSION: version, EXISTING_REVISION: "$(command)", EXISTING_ID: image_id },
    { EXISTING_VERSION: version, EXISTING_REVISION: revision, EXISTING_ID: "sha256:wrong" },
  ]) assert.throws(() => plan({ ...env, ...change }));
});

test("record and check the local image without rebuilding or retagging", () => {
  const exec = (command, args) => {
    assert.equal(command, "docker");
    assert.deepEqual(args, ["image", "inspect", image]);
    return JSON.stringify([{ Id: image_id, Config: { Labels: labels } }]);
  };
  assert.deepEqual(inspectImage({ ...spec, image_id: "" }, exec), spec);
  assert.deepEqual(inspectImage(spec, exec), spec);
  assert.throws(() => inspectImage({ ...spec, image_id: `sha256:${"f".repeat(64)}` }, exec), /identity changed/);
  assert.throws(() => inspectImage({ ...spec, revision: "a".repeat(40) }, exec), /labels/);
  assert.throws(() => inspectImage(spec, () => { throw new Error("No such image"); }), /No such image/);
});

test("a successful publication stops after one attempt", () => {
  let checks = 0;
  let attempts = 0;
  pushImage(spec, {
    inspect: () => { checks++; },
    run: (command, args) => {
      attempts++;
      assert.equal(command, "timeout");
      assert.deepEqual(args, ["--signal=TERM", "--kill-after=30s", "5400", "docker", "push", image]);
      return { status: 0 };
    },
  });
  assert.equal(attempts, 1);
  assert.equal(checks, 1);
});

test("timeout retries retain the image and stop at the attempt limit", () => {
  for (const statuses of [[124, 0], [1, 124, 0], [124, 124, 124]]) {
    let checks = 0;
    let attempts = 0;
    const run = () => ({ status: statuses[attempts++] });
    const execute = () => pushImage(spec, { inspect: () => { checks++; }, run });
    if (statuses.at(-1) === 0) execute();
    else assert.throws(execute, /three attempts/);
    assert.equal(attempts, statuses.length);
    assert.equal(checks, attempts);
  }
});

test("changed local identity prevents the next publication attempt", () => {
  let attempts = 0;
  let checks = 0;
  assert.throws(() => pushImage(spec, {
    inspect: () => { if (++checks === 2) throw new Error("identity changed"); },
    run: () => { attempts++; return { status: 124 }; },
  }), /identity changed/);
  assert.equal(attempts, 1);
});

function registry({ remoteConfig = config, configDigest = image_id, header, status = 200 } = {}) {
  const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: configDigest } });
  const calls = [];
  return {
    manifest, calls,
    fetcher: async (url, options) => {
      calls.push(url);
      assert.equal(options.redirect, "error");
      assert.ok(options.signal);
      if (url.includes("/manifests/")) {
        return new Response(manifest, { status, headers: { "docker-content-digest": header ?? hash(manifest) } });
      }
      assert.equal(url, `https://registry.synthiq.ru/v2/paperclip/blobs/${image_id}`);
      return new Response(remoteConfig);
    },
  };
}

test("receipt checks exact registry bytes and configuration labels", async () => {
  const r = registry();
  const result = await receipt(spec, r.fetcher);
  assert.equal(result.digest, hash(r.manifest));
  assert.equal(result.immutable, `registry.synthiq.ru/paperclip@${hash(r.manifest)}`);
  assert.equal(result.revision, revision);
  assert.equal(r.calls.length, 2);
});

test("receipt rejects a missing manifest, wrong digest, replacement, or changed configuration", async () => {
  for (const options of [
    { status: 404 }, { header: `sha256:${"f".repeat(64)}` },
    { configDigest: `sha256:${"f".repeat(64)}` }, { remoteConfig: "changed" },
  ]) await assert.rejects(receipt(spec, registry(options).fetcher));
  const changedConfig = JSON.stringify({ config: { Labels: { ...labels, "org.opencontainers.image.revision": "a".repeat(40) } } });
  const changedId = hash(changedConfig);
  const r = registry({ remoteConfig: changedConfig, configDigest: changedId });
  await assert.rejects(receipt({ ...spec, image_id: changedId }, async (url, options) => {
    if (url.includes("/blobs/")) return new Response(changedConfig);
    return r.fetcher(url, options);
  }), /labels/);
});

test("receipt limits registry metadata while it streams", async () => {
  await assert.rejects(receipt(spec, async () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1))), /size limit/);
});

test("publication rejects an absent identity and command failures", () => {
  assert.throws(() => pushImage({ ...spec, image_id: "" }), /identity/);
  assert.throws(() => pushImage(spec, {
    inspect: () => {}, run: () => ({ error: new Error("No timeout command") }),
  }), /No timeout command/);
});

test("publication has its own complete retry budget and no build command", () => {
  const workflow = readFileSync(new URL("../../workflows/synthiq-image.yml", import.meta.url), "utf8");
  const publish = workflow.split("\n  publish:\n")[1];
  assert.match(publish, /needs: build/);
  assert.match(publish, /timeout-minutes: 285/);
  assert.match(publish, /timeout-minutes: 275/);
  assert.match(publish, /test "\$RUNNER_NAME" = "\$EXPECTED_RUNNER"/);
  assert.match(publish, /needs.build.outputs.image_id/);
  assert.doesNotMatch(publish, /docker build|docker tag|pull_request/);
  assert.equal((workflow.match(/if: inputs.existing_version == ''/g) || []).length, 2);
});

test("provider pack permissions change before the final image copy", () => {
  const dockerfile = readFileSync(new URL("../../../Dockerfile", import.meta.url), "utf8");
  const pack = dockerfile.split("FROM build AS runner-provider-pack")[1].split("FROM base AS production")[0];
  const production = dockerfile.split("FROM base AS production")[1].split("FROM build AS cloud-plugins")[0];
  assert.match(pack, /build-provider-pack\.mjs.*[\s\S]*chmod -R a\+rX \/provider-pack/);
  assert.doesNotMatch(production, /chmod -R.*provider-pack/);
  assert.match(production, /gosu 65534:65534 node/);
});
