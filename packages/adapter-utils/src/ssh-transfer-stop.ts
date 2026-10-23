import type { ChildProcess } from "node:child_process";

/** Register before a child can close. Cleanup must wait for every child. */
export function createSshTransferStopper(children: ChildProcess[]): () => Promise<void> {
  const closed = children.map((child) => new Promise<void>((resolve) => {
    child.once("close", () => resolve());
  }));

  return async () => {
    const escalation = setTimeout(() => {
      for (const child of children) child.kill("SIGKILL");
    }, 5_000);
    escalation.unref();
    try {
      for (const child of children) child.kill("SIGTERM");
      await Promise.all(closed);
    } finally {
      clearTimeout(escalation);
    }
  };
}
