import { EventEmitter } from "node:events";
import { PassThrough, Transform, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({ spawn: vi.fn(), sink: null as unknown }));
vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(), spawn: transport.spawn,
}));
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  createWriteStream: () => transport.sink,
}));
import { streamSshToLocalFile } from "./ssh-download.js";

const spec = { host: "fixture", username: "fixture", port: 22, remoteWorkspacePath: "/unused",
  privateKey: null, knownHosts: null, strictHostKeyChecking: false };

describe("SSH download completion", () => {
  afterEach(() => vi.clearAllMocks());

  function process() {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    transport.spawn.mockReturnValue(child);
    return child;
  }

  it("drains a slow sink after SSH closes with buffered progress chunks", async () => {
    const child = process();
    const chunks: Buffer[] = [];
    const sink = new Writable({ highWaterMark: 1, write(chunk, _encoding, callback) {
      setTimeout(() => { chunks.push(Buffer.from(chunk)); callback(); }, 2);
    } });
    transport.sink = sink;
    const counter = new Transform({ highWaterMark: 1, transform(chunk, _encoding, callback) {
      callback(null, chunk);
    } });
    const download = streamSshToLocalFile({ spec, localFile: "/unused", remoteScript: "unused", progress: { counter } });
    await vi.waitFor(() => expect(transport.spawn).toHaveBeenCalledOnce());
    const expected = Buffer.alloc(64 * 1024, 42);
    for (let i = 0; i < 32; i += 1) child.stdout.write(expected.subarray(i * 2048, (i + 1) * 2048));
    child.stdout.end();
    child.emit("close", 0);
    await download;
    expect(sink.writableFinished).toBe(true);
    expect(Buffer.concat(chunks).length).toBe(expected.length);
    expect(Buffer.concat(chunks).equals(expected)).toBe(true);
  });

  it("rejects a sink failure after SSH closes", async () => {
    const child = process();
    transport.sink = new Writable({ write(_chunk, _encoding, callback) {
      setTimeout(() => callback(new Error("disk failed after SSH close")), 5);
    } });
    const download = streamSshToLocalFile({ spec, localFile: "/unused", remoteScript: "unused" });
    const result = expect(download).rejects.toThrow("disk failed after SSH close");
    await vi.waitFor(() => expect(transport.spawn).toHaveBeenCalledOnce());
    child.stdout.end("bytes");
    child.emit("close", 0);
    await result;
  });

  it("waits for SSH after the sink finishes", async () => {
    const child = process();
    const sink = new PassThrough();
    transport.sink = sink;
    let resolved = false;
    const download = streamSshToLocalFile({ spec, localFile: "/unused", remoteScript: "unused" })
      .then(() => { resolved = true; });
    await vi.waitFor(() => expect(transport.spawn).toHaveBeenCalledOnce());
    child.stdout.end("bytes");
    await new Promise<void>((resolve) => sink.on("finish", resolve));
    expect(resolved).toBe(false);
    child.emit("close", 0);
    await download;
  });

  it.each([1, null])("rejects an unsuccessful SSH exit: %s", async (code) => {
    const child = process();
    transport.sink = new PassThrough();
    const result = expect(streamSshToLocalFile({ spec, localFile: "/unused", remoteScript: "unused" }))
      .rejects.toThrow("remote failure");
    await vi.waitFor(() => expect(transport.spawn).toHaveBeenCalledOnce());
    child.stderr.write("remote failure");
    child.stdout.end();
    child.emit("close", code);
    await result;
  });
});
