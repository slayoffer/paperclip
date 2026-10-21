import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const root = new URL("../../../", import.meta.url);
const workflow = readFileSync(new URL(".github/workflows/synthiq-issue-read.yml", root), "utf8");

function checkCheckout(source) {
  const checkout = source.match(/      - uses: actions\/checkout@[^\n]+\n([\s\S]*?)(?=      - |$)/)?.[1];
  assert.ok(checkout, "Missing checkout step");
  // An explicit head excludes newer suites from the release target.
  assert.doesNotMatch(checkout, /^\s*(?:ref|repository|token):/m);
  assert.match(checkout, /^          persist-credentials: false$/m);
}

test("issue read checks use the pull request merge commit", () => checkCheckout(workflow));

for (const ref of ["${{ github.event.pull_request.head.sha }}", "master"]) {
  test(`reject a checkout override: ${ref}`, () => {
    const source = workflow.replace(/^\s*ref:.*\n/gm, "")
      .replace("          persist-credentials: false", `          ref: ${ref}\n          persist-credentials: false`);
    assert.throws(() => checkCheckout(source));
  });
}

test("every requested issue read suite exists in the tested source", () => {
  const suites = [...workflow.matchAll(/(server\/src\/[\w/.-]+\.test\.ts)/g)].map(([path]) => path);
  assert.equal(suites.length, 10);
  assert.equal(new Set(suites).size, suites.length);
  assert.ok(suites.includes("server/src/__tests__/issue-read-performance.test.ts"));
  for (const suite of suites) {
    assert.ok(existsSync(new URL(suite, root)), `Missing suite: ${suite}`);
  }
});

test("the job requires benchmark evidence after the tests", () => {
  assert.match(workflow, /PAPERCLIP_ISSUE_READ_BENCHMARK_OUTPUT: \$\{\{ runner.temp \}\}\/issue-read-benchmark\.json/);
  const benchmarkCheck = workflow.indexOf('test -s "$PAPERCLIP_ISSUE_READ_BENCHMARK_OUTPUT"');
  assert.ok(benchmarkCheck > workflow.indexOf("corepack pnpm exec vitest run"));
  assert.doesNotMatch(workflow, /continue-on-error:|\|\|\s*(?:true|:)|set \+e/);
});

test("the workflow executes its contract and accepts contract changes", () => {
  assert.match(workflow, /^      - \.github\/scripts\/tests\/issue-read-workflow\.test\.mjs$/m);
  assert.match(workflow, /^        run: node --test \.github\/scripts\/tests\/issue-read-workflow\.test\.mjs$/m);
});
