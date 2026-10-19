import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../workflows/fork-release-tests.yml", import.meta.url), "utf8");
const commands = ["pnpm -r typecheck", "pnpm test:run", "pnpm build"];
const guard = "${{ !cancelled() && steps.install.outcome == 'success' }}";
const actions = [
  "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  "actions/setup-node@6044e13b5dc448c55e2357c09f80417699197238",
];

// This check protects this small workflow's explicit structure. actionlint
// separately validates YAML and GitHub's workflow schema before handoff.
function checkContract(source) {
  const lines = source.split("\n").filter((line) => !line.trimStart().startsWith("#"));
  const text = lines.join("\n");
  assert.match(text, /^on:\n  pull_request:\n    branches: \["synthiq\/\*"\]\n    types: \[opened, synchronize, reopened, ready_for_review, labeled\]$/m);
  assert.deepEqual(lines.filter((line) => /^\S[^:]*:/.test(line)).map((line) => line.split(":")[0]),
    ["name", "on", "permissions", "concurrency", "jobs"]);
  assert.match(text, /^permissions:\n  contents: read\n/m);
  assert.equal(lines.filter((line) => /\bpermissions:/.test(line)).length, 1);
  assert.doesNotMatch(text, /\b(write|write-all|read-all|secrets|environment|pull_request_target|workflow_run)\b/);
  assert.equal(lines.filter((line) => /^  [\w-]+:$/.test(line) && text.indexOf(line) > text.indexOf("jobs:")).length, 1);
  assert.match(text, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(text, /^    timeout-minutes: 180$/m);
  assert.match(text, /^  cancel-in-progress: true$/m);
  assert.ok(lines.includes("  group: fork-release-tests-${{ github.event.pull_request.number }}-${{ github.event.action == 'labeled' && github.event.label.name != 'fork-release-tests' && github.run_id || 'checks' }}"));
  assert.doesNotMatch(text, /continue-on-error:|working-directory:|needs:|strategy:|container:|services:/);
  assert.doesNotMatch(text, /\|\|\s*(?:true|:)|set \+e|exit 0/);
  assert.doesNotMatch(text, /^    uses:/m);
  assert.ok(lines.includes("    if: ${{ github.event.action != 'labeled' || github.event.label.name == 'fork-release-tests' }}"));
  assert.deepEqual(lines.filter((line) => /uses:/.test(line)).map((line) => line.trim().split(/\s+/)[1]), actions);
  assert.match(text, /^          persist-credentials: false$/m);
  assert.doesNotMatch(text, /^          (?:token|ref|repository):/m);
  assert.match(text, /^          node-version: 24$/m);
  assert.match(text, /^          package-manager-cache: false$/m);
  assert.match(text, /^        run: npm install --global pnpm@9\.15\.4$/m);
  assert.match(text, /^        id: install\n        run: pnpm install --no-frozen-lockfile$/m);
  assert.match(text, /^        run: node --test \.github\/scripts\/tests\/fork-release-tests\.test\.mjs$/m);
  const steps = text.split(/^      - name: /m).slice(1);
  for (const command of commands) {
    const step = steps.find((step) => step.split("\n").includes(`        run: ${command}`));
    assert.ok(step, `Missing command: ${command}`);
    assert.ok(step.split("\n").includes(`        if: ${guard}`), `Unsafe check condition: ${command}`);
    const timeout = command === "pnpm test:run" ? 150 : 20;
    assert.ok(step.split("\n").includes(`        timeout-minutes: ${timeout}`), `Incorrect time limit: ${command}`);
    assert.equal(step.split("\n").filter((line) => line.trimStart().startsWith("run:")).length, 1);
  }
  assert.match(text, /PR_HEAD: \$\{\{ github.event.pull_request.head.sha \}\}/);
  assert.match(text, /Tested merge commit: \$GITHUB_SHA/);
  assert.match(text, /\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY\/actions\/runs\/\$GITHUB_RUN_ID/);
  assert.match(text, /TYPECHECK_RESULT: \$\{\{ steps.typecheck.outcome \}\}/);
  assert.match(text, /TEST_RESULT: \$\{\{ steps.tests.outcome \}\}/);
  assert.match(text, /Runner limit: one GitHub-hosted job, 180 minutes per run\./);
  assert.match(text, /BUILD_RESULT: \$\{\{ steps.build.outcome \}\}/);
  // Event data enters shell commands through environment variables.
  for (const step of steps) {
    const script = step.split(/^        run: /m)[1];
    if (script) assert.doesNotMatch(script, /\$\{\{/);
  }
}

test("fork workflow satisfies the release-test contract", () => checkContract(workflow));

for (const command of commands) {
  test(`reject a missing executable command: ${command}`, () => {
    assert.throws(() => checkContract(workflow.replace(`        run: ${command}\n`, `        # run: ${command}\n`)));
  });
}

for (const [name, before, after] of [
  ["a different target", 'branches: ["synthiq/*"]', 'branches: ["master"]'],
  ["cancellation by an unrelated label", "&& github.run_id || 'checks'", "&& 'checks' || 'checks'"],
  ["a skipped job", "    if: ${{ github.event.action != 'labeled' || github.event.label.name == 'fork-release-tests' }}", "    if: ${{ false }}"],
  ["a privileged event", "  pull_request:", "  pull_request_target:"],
  ["write permission", "contents: read", "contents: write"],
  ["a nested permission override", "    steps:", "    permissions: write-all\n    steps:"],
  ["secret access", "    steps:", "    env:\n      TOKEN: ${{ secrets.TOKEN }}\n    steps:"],
  ["a self-hosted runner", "runs-on: ubuntu-24.04", "runs-on: self-hosted"],
  ["an unlimited job", "    timeout-minutes: 180\n", ""],
  ["the old job limit", "    timeout-minutes: 180\n", "    timeout-minutes: 60\n"],
  ["the old test limit", "        timeout-minutes: 150\n", "        timeout-minutes: 30\n"],
  ["an unlimited test step", "        timeout-minutes: 150\n", ""],
  ["an incorrect limit summary", "180 minutes per run.", "60 minutes per run."],
  ["a mutable action", actions[0], "actions/checkout@main"],
  ["an upstream workflow", "    steps:", "    uses: paperclipai/paperclip/.github/workflows/pr-trusted.yml@master\n    steps:"],
  ["an additional action", "    steps:", "    steps:\n      - uses: other/action@" + "a".repeat(40)],
  ["persisted credentials", "persist-credentials: false", "persist-credentials: true"],
  ["a moving checkout", "          persist-credentials: false", "          ref: master\n          persist-credentials: false"],
  ["an ignored check failure", "        id: tests", "        continue-on-error: true\n        id: tests"],
  ["a masked exit status", "run: pnpm test:run", "run: pnpm test:run || true"],
  ["a check skipped after failure", `if: ${guard}`, "if: ${{ success() }}"],
  ["an unconditional check", `if: ${guard}`, "if: ${{ always() }}"],
  ["a changed working directory", "    steps:", "    working-directory: unrelated\n    steps:"],
  ["event text in a shell", 'echo "Pull request head: $PR_HEAD"', 'echo "${{ github.event.pull_request.title }}"'],
]) {
  test(`reject ${name}`, () => {
    assert.notEqual(workflow.replace(before, after), workflow, "Mutation must change the fixture");
    assert.throws(() => checkContract(workflow.replace(before, after)));
  });
}
