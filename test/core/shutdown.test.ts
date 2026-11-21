import { mkdtemp } from "node:fs/promises";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drain } from "../../src/core/shutdown.js";
import { createApp } from "../../src/server.js";

/** One request on its own connection: its status, or the error when the connection fails. */
const get = (port: number, path = "/") =>
  new Promise<{ status?: number; body?: string; error?: string }>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path, agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body }));
      res.on("error", (e) => resolve({ error: e.message }));
    });
    req.on("error", (e) => resolve({ error: (e as NodeJS.ErrnoException).code ?? e.message }));
    req.end();
  });

describe("stopping the web service", () => {
  const closers: (() => void)[] = [];
  afterEach(() => {
    for (const c of closers.splice(0)) c();
    vi.restoreAllMocks();
  });

  /** A server whose /slow answers after `ms`, and /never never does. */
  async function slowServer(ms: number) {
    const server = createServer((req, res) => {
      if (req.url === "/never") return;
      setTimeout(() => res.end("done"), req.url === "/slow" ? ms : 0);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    closers.push(() => server.closeAllConnections());
    return { server, port: (server.address() as AddressInfo).port };
  }

  it("lets the requests in flight finish, refuses new connections, then resolves", async () => {
    const { server, port } = await slowServer(300);
    const order: string[] = [];
    const inFlight = get(port, "/slow");
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    const drained = drain({
      server,
      stopAccepting: () => order.push("stop accepting"),
      finish: [{ run: async () => order.push("lease released"), timeoutMs: 1000 }],
      graceMs: 5000,
    }).then(() => order.push("drained"));
    expect(order[0]).toBe("stop accepting");
    expect((await get(port)).error).toBe("ECONNREFUSED");
    expect(await inFlight).toEqual({ status: 200, body: "done" });
    await drained;
    expect(order).toEqual(["stop accepting", "lease released", "drained"]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("cuts what is still open after the grace period", async () => {
    const { server, port } = await slowServer(0);
    const stuck = get(port, "/never");
    await new Promise((r) => setTimeout(r, 50));
    const started = Date.now();
    await drain({ server, stopAccepting: () => {}, graceMs: 200 });
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(Date.now() - started).toBeLessThan(2000);
    expect((await stuck).error).toBeDefined();
  });

  it("waits for the finishing work only within its own limit, and never fails", async () => {
    const { server } = await slowServer(0);
    const started = Date.now();
    await drain({
      server,
      stopAccepting: () => {},
      finish: [
        { run: () => new Promise(() => {}), timeoutMs: 100 },
        { run: () => Promise.reject(new Error("lease store down")), timeoutMs: 1000 },
      ],
      graceMs: 5000,
    });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("answers 503 to new requests and starts no more workers once it stops accepting work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-shutdown-"));
    const stop = vi.fn();
    const { app, stopAcceptingWork } = await createApp(
      { DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" },
      { runner: { kind: "local", launch: async () => undefined, stop } },
    );
    const server = app.listen(0);
    closers.push(() => server.close());
    const port = (server.address() as AddressInfo).port;
    expect((await get(port, "/healthz")).status).toBe(200);
    stopAcceptingWork();
    expect(stop).toHaveBeenCalledOnce();
    for (const path of ["/healthz", "/api/state", "/slack/events"]) {
      const res = await get(port, path);
      expect(res.status, path).toBe(503);
      expect(JSON.parse(res.body!).error).toMatch(/restarting/);
    }
  });
});
