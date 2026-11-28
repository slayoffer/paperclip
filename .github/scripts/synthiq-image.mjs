import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const registry = "https://registry.synthiq.ru";
const source = "https://github.com/slayoffer/paperclip";
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const revisionPattern = /^[0-9a-f]{40}$/;
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function plan(env) {
  const base = env.REF_NAME?.replace(/^synthiq\//, "");
  if (!env.REF_NAME?.startsWith("synthiq/") || !/^\d+\.\d+\.\d+$/.test(base)) {
    throw new Error("Select a synthiq/<upstream version> branch.");
  }
  const recovery = [env.EXISTING_VERSION, env.EXISTING_REVISION, env.EXISTING_ID].filter(Boolean).length;
  if (recovery !== 0 && recovery !== 3) throw new Error("Supply all three existing-image fields.");
  if (!/^\d+$/.test(env.RUN_NUMBER)) throw new Error("Invalid run number.");
  const version = env.EXISTING_VERSION || `${base}-synthiq.${env.RUN_NUMBER}`;
  if (!version.startsWith(`${base}-synthiq.`) || !/^\d+\.\d+\.\d+-synthiq\.\d+$/.test(version)) {
    throw new Error("The image version must match the selected release branch.");
  }
  return validate({
    version,
    image: `registry.synthiq.ru/paperclip:${version}`,
    revision: env.EXISTING_REVISION || env.GITHUB_SHA,
    image_id: env.EXISTING_ID || "",
  });
}

export function validate(spec, requireId = false) {
  if (!/^\d+\.\d+\.\d+-synthiq\.\d+$/.test(spec.version)) throw new Error("Invalid image version.");
  if (spec.image !== `registry.synthiq.ru/paperclip:${spec.version}`) throw new Error("Invalid image destination.");
  if (!revisionPattern.test(spec.revision)) throw new Error("Invalid source revision.");
  if ((requireId || spec.image_id) && !digestPattern.test(spec.image_id)) throw new Error("Invalid image identity.");
  return spec;
}

function checkLabels(labels, spec) {
  if (labels?.["org.opencontainers.image.revision"] !== spec.revision
    || labels?.["org.opencontainers.image.version"] !== spec.version
    || labels?.["org.opencontainers.image.source"] !== source) {
    throw new Error("Image labels do not match the selected artifact.");
  }
}

export function inspectImage(spec, exec = execFileSync) {
  validate(spec);
  const [image] = JSON.parse(exec("docker", ["image", "inspect", spec.image], { encoding: "utf8" }));
  if (!digestPattern.test(image?.Id) || (spec.image_id && image.Id !== spec.image_id)) {
    throw new Error("The original image is absent or its identity changed. Do not rebuild it.");
  }
  checkLabels(image.Config?.Labels, spec);
  return { ...spec, image_id: image.Id };
}

export function pushImage(spec, { inspect = inspectImage, run = spawnSync } = {}) {
  validate(spec, true);
  for (let attempt = 1; attempt <= 3; attempt++) {
    inspect(spec);
    const result = run("timeout", ["--signal=TERM", "--kill-after=30s", "5400", "docker", "push", spec.image], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status === 0) return;
    console.error(`Publication attempt ${attempt} failed (${result.status ?? result.signal}).`);
  }
  throw new Error("Publication failed after three attempts.");
}

export async function receipt(spec, fetcher = fetch) {
  validate(spec, true);
  async function get(path, accept) {
    const response = await fetcher(`${registry}/v2/paperclip/${path}`, {
      headers: { Accept: accept }, redirect: "error", signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Registry read failed (${response.status}).`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 2 * 1024 * 1024) throw new Error("Registry metadata exceeds the size limit.");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    return { bytes, digest: hash(bytes), header: response.headers.get("docker-content-digest") };
  }
  const manifest = await get(`manifests/${spec.version}`, "application/vnd.docker.distribution.manifest.v2+json");
  if (manifest.header !== manifest.digest) throw new Error("The manifest digest does not match its registry header.");
  const parsed = JSON.parse(manifest.bytes);
  if (parsed.schemaVersion !== 2 || parsed.config?.digest !== spec.image_id) {
    throw new Error("The published manifest does not name the original image configuration.");
  }
  const config = await get(`blobs/${spec.image_id}`, "application/octet-stream");
  if (config.digest !== spec.image_id) throw new Error("The image configuration digest does not match.");
  checkLabels(JSON.parse(config.bytes).config?.Labels, spec);
  return { ...spec, digest: manifest.digest, immutable: `registry.synthiq.ru/paperclip@${manifest.digest}` };
}

async function main() {
  const command = process.argv[2];
  if (command === "plan") {
    const spec = plan(process.env);
    for (const [key, value] of Object.entries(spec)) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    return;
  }
  const spec = validate({ image: process.env.IMAGE, version: process.env.VERSION,
    revision: process.env.REVISION, image_id: process.env.IMAGE_ID || "" });
  if (command === "inspect") {
    const result = inspectImage(spec);
    appendFileSync(process.env.GITHUB_OUTPUT, `image_id=${result.image_id}\n`);
  } else if (command === "push") {
    pushImage(spec);
  } else if (command === "receipt") {
    const result = await receipt(spec);
    writeFileSync("publication.json", `${JSON.stringify(result, null, 2)}\n`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `Published: ${result.immutable}\n\nVersion: ${result.version}\n\nRevision: ${result.revision}\n`);
  } else throw new Error("Unknown publication command.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
