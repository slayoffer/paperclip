/** The standalone gateway embeds this source. Tests execute the same function with local I/O. */
export function sandboxCallbackQueueLifecycleSource(): string {
  return `function createSandboxCallbackQueueLifecycle({ fs, path, requestsDir, responseTimeoutMs, maxEnvelopeBytes }) {
  const requestPath = id => path.posix.join(requestsDir, id + ".json");
  let sweepInFlight = null;

  async function removeExpired(filePath) {
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats) return;
    let expiresAt = stats.mtimeMs + responseTimeoutMs + 2000;
    const handle = await fs.open(filePath, "r").catch(() => null);
    if (!handle) return;
    try {
      // New entries put the deadline first. Cleanup never allocates or parses a request body.
      const bytes = Buffer.alloc(Math.min(128, maxEnvelopeBytes));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const match = bytes.subarray(0, bytesRead).toString("utf8").match(/^\\{"expiresAt":(-?\\d+(?:\\.\\d+)?)(?:,|\\})/);
      if (match && Number.isFinite(Number(match[1]))) expiresAt = Number(match[1]);
    } finally { await handle.close(); }
    if (Date.now() >= expiresAt) await fs.rm(filePath, { force: true });
  }

  return {
    async publish(id, payload) {
      const target = requestPath(id);
      const temporary = target + ".tmp";
      const expiresAt = Date.now() + responseTimeoutMs;
      try {
        const entry = { ...payload };
        delete entry.expiresAt;
        await fs.writeFile(temporary, JSON.stringify({ expiresAt, ...entry }) + "\\n", "utf8");
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
      return expiresAt;
    },
    async acknowledge(id) {
      // The caller reads and validates the response before this acknowledgement.
      // Rename removes the pending entry atomically. Only acked entries need no deadline.
      const target = requestPath(id);
      const acknowledged = target + ".acked";
      await fs.rename(target, acknowledged).catch(error => {
        if (error.code !== "ENOENT") throw error;
      });
      await fs.rm(acknowledged, { force: true });
    },
    expire(id) { return removeExpired(requestPath(id)); },
    sweep() {
      if (sweepInFlight) return sweepInFlight;
      sweepInFlight = (async () => {
        const entries = await fs.readdir(requestsDir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isFile()) continue;
          const filePath = path.posix.join(requestsDir, entry.name);
          if (entry.name.endsWith(".json.acked")) {
            await fs.rm(filePath, { force: true });
          } else if (entry.name.endsWith(".json")) {
            await removeExpired(filePath);
          }
        }
      })().finally(() => { sweepInFlight = null; });
      return sweepInFlight;
    },
  };
}`;
}
