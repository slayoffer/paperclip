import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { runInNewContext } from "node:vm";

const workflow = readFileSync(new URL("../../workflows/synthiq-ssh-workspace.yml", import.meta.url), "utf8");

function job(name) {
  const source = workflow.split(`  ${name}:\n`)[1]?.split(/^  [\w-]+:\n/m)[0];
  assert.ok(source, `Missing job: ${name}`);
  return source;
}

test("verification covers all six shards on the exact PR head with typecheck and build", () => {
  const source = job("repository-verification-shards");
  assert.match(source, /fail-fast: false/);
  assert.match(source, /shard: \[1, 2, 3, 4, 5, 6\]/);
  assert.match(source, /ref: \$\{\{ github.event.pull_request.head.sha \}\}/);
  assert.match(source, /persist-credentials: false/);
  assert.match(source, /TEST_SHARD: \$\{\{ matrix.shard \}\}\/6/);
  assert.match(source, /name: Check all package types\n        if: matrix.shard == 1\n        run: corepack pnpm -r typecheck/);
  assert.match(source, /name: Build the repository\n        if: matrix.shard == 1\n        run: corepack pnpm build/);
  assert.match(source, /corepack pnpm run preflight:workspace-links/);
  assert.match(source, /corepack pnpm exec vitest run --shard="\$TEST_SHARD" --exclude '\*\*\/dist\/\*\*' --no-file-parallelism --maxWorkers=1 --pool=forks --isolate/);
  assert.doesNotMatch(source, /corepack pnpm test:run|continue-on-error:/);
  assert.match(source, /export PAPERCLIP_CONFIG="\$PAPERCLIP_HOME\/config.json"/);
  assert.match(source, /if ! unshare --user --map-root-user --net true 2>\/dev\/null; then export PAPERCLIP_TEST_NO_USERNS_SANDBOX=1; fi/);
  assert.match(source, /node --test \.github\/scripts\/tests\/ssh-workspace-verification.test.mjs/);
  assert.match(workflow, /paths:\n(?:[^\n]*\n)*?      - "\.github\/scripts\/tests\/ssh-workspace-verification.test.mjs"/);
});

test("the stable required check waits for every shard and runs after failure or cancellation", () => {
  const source = job("repository-verification");
  assert.match(source, /needs: \[repository-verification-shards\]/);
  assert.doesNotMatch(source, /strategy:|continue-on-error:/);
  const condition = source.match(/^    if: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.ok(condition);
  assert.equal(runInNewContext(condition, { always: () => true,
    github: { repository: "slayoffer/paperclip" } }), true);
  assert.equal(runInNewContext(condition, { always: () => true,
    github: { repository: "paperclipai/paperclip" } }), false);
  assert.match(source, /SHARDS_RESULT: \$\{\{ needs.repository-verification-shards.result \}\}/);
});

for (const result of ["success", "failure", "cancelled", "skipped", ""]) {
  test(`required check accepts only successful shards: ${result || "absent"}`, () => {
    const source = job("repository-verification");
    const gateStep = source.split("      - name: Require every verification shard\n")[1];
    assert.ok(gateStep, "The required check must have a shard result gate");
    const script = gateStep.split("        run: |\n")[1];
    assert.ok(script, "The required check must execute a result gate");
    const run = spawnSync("bash", ["-e", "-c", script], {
      env: { ...process.env, SHARDS_RESULT: result },
      encoding: "utf8",
    });
    assert.equal(run.status, result === "success" ? 0 : 1, run.stderr);
  });
}
