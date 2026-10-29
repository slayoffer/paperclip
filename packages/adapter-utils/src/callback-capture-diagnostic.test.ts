import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const repository = fileURLToPath(new URL("../../../", import.meta.url));

// The fork's release workflow runs Vitest. Keep the operator-script suite in that path.
it("runs the callback diagnostic safety and process tests", async () => {
  const { stdout } = await execute(process.execPath, [
    "--test", "--test-reporter=tap", ".github/scripts/tests/callback-capture.test.mjs",
  ], { cwd: repository, timeout: 20_000, maxBuffer: 256 * 1024 }).catch((error) => {
    // Vitest otherwise hides the child assertions when execFile rejects.
    throw new Error(`${error.message}\n${error.stdout ?? ""}\n${error.stderr ?? ""}`, { cause: error });
  });
  expect(stdout).toMatch(/^# tests 26$/m);
  expect(stdout).toMatch(/^# pass 26$/m);
  expect(stdout).toMatch(/^# fail 0$/m);
}, 25_000);
