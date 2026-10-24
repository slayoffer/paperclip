/** The standalone gateway embeds this source. Tests execute the same function with local I/O. */
export function sandboxCallbackQueueLifecycleSource(): string {
  return `function createSandboxCallbackQueueLifecycle({ fs, path, requestsDir, responseTimeoutMs, maxEnvelopeBytes }) {
  const requestPath = id => path.posix.join(requestsDir, id + ".json");

  async function removeExpired(filePath) {
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats) return;
    let expiresAt = stats.mtimeMs + responseTimeoutMs + 2000;
    if (stats.size <= maxEnvelopeBytes) {
      const raw = await fs.readFile(filePath, "utf8").catch(() => null);
      if (raw === null) return;
      try {
        const request = JSON.parse(raw);
        if (Number.isFinite(request.expiresAt)) expiresAt = request.expiresAt;
      } catch { /* Legacy or corrupt entries use the bounded age fallback. */ }
    }
    if (Date.now() >= expiresAt) await fs.rm(filePath, { force: true });
  }

  return {
    async publish(id, payload) {
      const target = requestPath(id);
      const temporary = target + ".tmp";
      const expiresAt = Date.now() + responseTimeoutMs;
      try {
        await fs.writeFile(temporary, JSON.stringify({ ...payload, expiresAt }) + "\\n", "utf8");
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
    async sweep() {
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
    },
  };
}`;
}
