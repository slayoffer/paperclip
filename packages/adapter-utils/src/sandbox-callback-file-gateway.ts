import { sandboxCallbackQueueLifecycleSource } from "./sandbox-callback-queue-lifecycle.js";

/** Source embedded in the standalone sandbox gateway. Host globals supply I/O and limits. */
export function sandboxCallbackFileGatewaySource(): string {
  return `${sandboxCallbackQueueLifecycleSource()}
async function runFileGateway() {
  const requestsDir = path.posix.join(queueDir, "requests");
  const responsesDir = path.posix.join(queueDir, "responses");
  const logsDir = path.posix.join(queueDir, "logs");
  const readyFile = path.posix.join(queueDir, "ready.json");
  const lifecycle = createSandboxCallbackQueueLifecycle({ fs, path, requestsDir, responseTimeoutMs,
    maxEnvelopeBytes: sandboxBridgeEnvelopeLimit(maxBodyBytes) });

  async function queueDepth() {
    const entries = await fs.readdir(requestsDir, { withFileTypes: true }).catch(() => []);
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).length;
  }

  // Delete request files older than the response deadline. Every live caller
  // cleans its own request file when it times out, so a file this old is an
  // orphan: its writer was killed mid-wait, or a previous gateway process died
  // and left its queue behind. Orphans otherwise count toward the queue-depth
  // cap forever and wedge the gateway at a permanent 503.
  async function sweepStaleRequests() {
    if (queueV2Enabled) return lifecycle.sweep();
    const staleBefore = Date.now() - responseTimeoutMs - 2000;
    const entries = await fs.readdir(requestsDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = path.posix.join(requestsDir, entry.name);
      const stats = await fs.stat(filePath).catch(() => null);
      if (stats && stats.mtimeMs < staleBefore) {
        await fs.rm(filePath, { force: true }).catch(() => undefined);
      }
    }
  }

  async function waitForResponse(requestId, reserveResponse, expiresAt) {
    const responsePath = path.posix.join(responsesDir, \`\${requestId}.json\`);
    const deadline = expiresAt || Date.now() + responseTimeoutMs;
    while (Date.now() < deadline) {
      const handle = await fs.open(responsePath, "r").catch(error => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (handle) {
        try {
          const stat = await handle.stat();
          if (stat.size > sandboxBridgeEnvelopeLimit(maxBodyBytes)) throw new Error("Bridge response envelope exceeded the configured size limit.");
          reserveResponse(6 * stat.size + 1);
          const bytes = Buffer.alloc(stat.size + 1);
          let length = 0;
          while (length < bytes.length) {
            const read = await handle.read(bytes, length, bytes.length - length, length);
            if (!read.bytesRead) break;
            length += read.bytesRead;
          }
          if (length !== stat.size) throw new Error("Bridge response envelope changed while reading.");
          const response = JSON.parse(bytes.subarray(0, length).toString("utf8"));
          decodeSandboxBridgeBody(response, maxBodyBytes);
          if (queueV2Enabled) await lifecycle.acknowledge(requestId);
          return response;
        } finally {
          await handle.close();
          await fs.rm(responsePath, { force: true }).catch(() => undefined);
        }
      }
      await sleep(pollIntervalMs);
    }
    throw new Error("Timed out waiting for host bridge response.");
  }

  const server = createServer(async (req, res) => {
    // readBodyBytes reserves the body's bytes against the process ledger and
    // hands back a release function; this holds it so the finally below
    // releases those bytes exactly once no matter how this handler ends —
    // its normal completion, a thrown error, a client abort, or a deadline
    // timeout all reach the same finally.
    let releaseBodyReservation = null;
    let envelopeReservation = 0;
    let dispatched = false;
    try {
      const auth = req.headers.authorization || "";
      const receivedToken = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
      if (!tokensMatch(receivedToken)) {
        writeJsonResponse(res, 401, { error: "Invalid bridge token." });
        return;
      }

      if (await queueDepth() >= maxQueueDepth) {
        // Reclaim orphaned request files before rejecting; only a queue that
        // is genuinely full of live requests gets the 503.
        await sweepStaleRequests();
        if (await queueDepth() >= maxQueueDepth) {
          writeJsonResponse(res, 503, { error: "Bridge request queue is full." });
          return;
        }
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
      const multipartAttachment = req.method === "POST"
        && /^\\/api\\/companies\\/[^/]+\\/issues\\/[^/]+\\/attachments$/.test(url.pathname)
        && /^multipart\\/form-data(?:;|$)/i.test(contentType);
      if (req.method && req.method !== "GET" && req.method !== "HEAD" && !/json/i.test(contentType) && !multipartAttachment) {
        writeJsonResponse(res, 415, { error: "Bridge only accepts JSON request bodies." });
        return;
      }
      const requestId = randomUUID();
      // Reserve encoded envelopes and response decoding separately from the
      // incoming byte buffers. Capacity rejection precedes dispatch, hence 503.
      const { body: requestBody, release } = await readBodyBytes(req);
      releaseBodyReservation = release;
      const reserveBytes = 4 * sandboxBridgeEnvelopeLimit(requestBody.length);
      if (!processBodyLedger.reserve(reserveBytes)) throw new BridgeProcessCapacityError();
      envelopeReservation = reserveBytes;
      const payload = {
        id: requestId,
        method: req.method || "GET",
        path: url.pathname,
        query: url.search,
        headers: normalizeHeaders(req.headers),
        ...encodeSandboxBridgeBody(multipartAttachment ? requestBody : requestBody.toString("utf8"), maxBodyBytes),
        createdAt: new Date().toISOString(),
      };
      const requestPath = path.posix.join(requestsDir, \`\${requestId}.json\`);
      const tempPath = \`\${requestPath}.tmp\`;
      let expiresAt;
      // A failed rename can still leave an uncertain dispatch. Preserve the write fence.
      dispatched = true;
      if (queueV2Enabled) {
        expiresAt = await lifecycle.publish(requestId, payload);
      } else {
        await fs.writeFile(tempPath, \`\${JSON.stringify(payload)}\\n\`, "utf8");
        await fs.rename(tempPath, requestPath);
      }

      let response;
      try {
        response = await waitForResponse(requestId, bytes => {
          if (!processBodyLedger.reserve(bytes)) throw new BridgeProcessCapacityError();
          envelopeReservation += bytes;
        }, expiresAt);
      } catch (error) {
        // The host never delivered a response inside the deadline. Remove this
        // request's file so it cannot pile up toward the queue-depth cap. The
        // host's normal response write is guarded on the request file, so the
        // removal also tells the host that no caller waits anymore. Without
        // this cleanup a stalled host wedges the gateway at the cap and every
        // later request gets an immediate 503 until run end.
        if (queueV2Enabled) await lifecycle.expire(requestId).catch(() => undefined);
        else await fs.rm(requestPath, { force: true }).catch(() => undefined);
        throw error;
      }
      const responseHeaders = response.headers || {};
      // The host marks a possibly-committed mutation with an indeterminate outcome.
      // The host cannot cancel a host operation that is in flight, so the mutation
      // may have committed before the worker aborted the handler. A 5xx status is
      // retryable by convention, so a caller that retries 5xx would apply the
      // mutation twice. Map the indeterminate outcome to a non-retryable 409, so a
      // standard retry policy does not repeat the request. The outcome header and
      // body stay, so a caller that reads them still sees the indeterminate result.
      const bridgeOutcome = responseHeaders["x-paperclip-bridge-outcome"];
      if (bridgeOutcome === "indeterminate") {
        res.statusCode = 409;
      } else {
        res.statusCode = typeof response.status === "number" ? response.status : 200;
      }
      for (const [key, value] of Object.entries(responseHeaders)) {
        if (typeof value !== "string" || key.toLowerCase() === "content-length") continue;
        res.setHeader(key, value);
      }
      res.end(decodeSandboxBridgeBody(response, maxBodyBytes));
    } catch (error) {
      // Capacity rejection before dispatch is retryable. After a mutation was
      // dispatched, a missing or corrupt receipt cannot prove that it failed.
      const uncertainWrite = dispatched && !["GET", "HEAD", "OPTIONS", "TRACE"].includes(req.method || "GET");
      const status = uncertainWrite ? 409 : error instanceof BridgeProcessCapacityError ? 503 : 502;
      if (uncertainWrite) res.setHeader("x-paperclip-bridge-outcome", "indeterminate");
      writeJsonResponse(res, status, {
        error: error instanceof Error ? error.message : String(error),
        ...(uncertainWrite ? { outcome: "indeterminate", retryable: false } : {}),
      });
    } finally {
      releaseBodyReservation?.();
      processBodyLedger.release(envelopeReservation);
    }
  });

  let sweeping = false;
  const sweepTimer = queueV2Enabled ? setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void lifecycle.sweep().catch(error => {
      process.stderr.write("[paperclip-bridge] queue cleanup failed: " + error.message + "\\n");
    }).finally(() => { sweeping = false; });
  }, Math.max(50, Math.min(responseTimeoutMs, 1000))) : null;
  sweepTimer?.unref();

  async function shutdown() {
    if (sweepTimer) clearInterval(sweepTimer);
    server.close(() => {
      process.exit(0);
    });
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  await fs.mkdir(requestsDir, { recursive: true });
  await fs.mkdir(responsesDir, { recursive: true });
  await fs.mkdir(logsDir, { recursive: true });

  // Newer Node runtimes do not reliably surface a failed bind through
  // uncaughtException here: with nothing else keeping the event loop alive,
  // the process can drain and exit 0 before the error event is delivered
  // (observed on Node 24/25; Node 22 delivered it). Attach an explicit error
  // listener and pin the loop with a keepalive until the bind settles, so a
  // startup failure exits 1 with the fault on stderr on every runtime.
  const bindKeepalive = setInterval(() => {}, 1000);
  server.once("error", (error) => {
    clearInterval(bindKeepalive);
    process.stderr.write(
      "[paperclip-bridge] server error: " + (error && error.stack ? error.stack : String(error)) + "\\n",
    );
    if (!gatewayReady) {
      process.exit(1);
    }
  });
  server.listen(port, host, async () => {
    clearInterval(bindKeepalive);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Bridge server did not expose a TCP address.");
    }
    const ready = {
      pid: process.pid,
      host,
      port: address.port,
      baseUrl: \`http://\${host}:\${address.port}\`,
      startedAt: new Date().toISOString(),
    };
    const tempReadyFile = \`\${readyFile}.tmp\`;
    await fs.writeFile(tempReadyFile, JSON.stringify(ready), "utf8");
    await fs.rename(tempReadyFile, readyFile);
    // The readiness file is on disk, so the host will adopt this process.
    // From here on an uncaught fault must not kill the listener.
    gatewayReady = true;
  });
}`;
}
