import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { attemptThrottle, createApp, trustProxySetting } from "../../src/server.js";

/**
 * The brute-force brakes on the routes that check a secret without a
 * session: sign-in, setup and password reset share 10 attempts per address
 * every 10 minutes; the routines tick allows 20 wrong secrets. Both sides:
 * the attempts under the limit are answered, the ones over it are not, even
 * with the right secret. The address is the one the proxy in front saw
 * (TRUST_PROXY, one hop by default), so a made-up X-Forwarded-For does not
 * start a new count, and the addresses kept are capped.
 */

const servers: { close(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function start(env: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "army-checks-throttle-"));
  const made = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-acme-123", RUNNER: "local", ...env });
  // On 127.0.0.1 itself: a server listening on every address can lose 127.0.0.1 on its port to another process.
  const server = await new Promise<ReturnType<typeof made.app.listen>>((resolve) => {
    const s = made.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { post, routines: made.routines };
}

/** A request through one proxy: the client made up `spoofed`, the proxy added the address it saw. */
const via = (spoofed: string, client: string) => ({ "x-forwarded-for": `${spoofed}, ${client}` });

describe("sign-in throttle", () => {
  it("answers ten attempts, then refuses the next one even with the right password", async () => {
    const { post } = await start();
    // The setup is the first attempt.
    expect((await post("/api/setup", { setupToken: "setup-acme-123", password: "longpassword1" })).status).toBe(200);
    for (let i = 0; i < 9; i++) expect((await post("/api/login", { password: "wrong-password" })).status, `attempt ${i + 2}`).toBe(403);
    const blocked = await post("/api/login", { password: "longpassword1" });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toEqual({ error: "Too many attempts. Try again later." });
  });

  it("counts sign-in, setup and reset attempts together", async () => {
    const { post } = await start();
    for (let i = 0; i < 10; i++) expect((await post("/api/setup", { setupToken: "wrong-token", password: "longpassword1" })).status).toBe(403);
    expect((await post("/api/reset-password", { setupToken: "setup-acme-123", password: "longpassword2" })).status).toBe(429);
    expect((await post("/api/setup", { setupToken: "setup-acme-123", password: "longpassword1" })).status).toBe(429);
    expect((await post("/api/login", { password: "longpassword1" })).status).toBe(429);
  });

  it("lets a right password through on a fresh server", async () => {
    const { post } = await start();
    expect((await post("/api/setup", { setupToken: "setup-acme-123", password: "longpassword1" })).status).toBe(200);
    expect((await post("/api/login", { password: "longpassword1" })).status).toBe(200);
  });

  it("does not start a new count for a made-up X-Forwarded-For: the entry the proxy added counts", async () => {
    const { post } = await start();
    const setup = await post("/api/setup", { setupToken: "setup-acme-123", password: "longpassword1" }, via("198.51.100.200", "203.0.113.7"));
    expect(setup.status).toBe(200);
    for (let i = 0; i < 9; i++) {
      expect((await post("/api/login", { password: "wrong-password" }, via(`198.51.100.${i}`, "203.0.113.7"))).status, `attempt ${i + 2}`).toBe(403);
    }
    expect((await post("/api/login", { password: "longpassword1" }, via("198.51.100.99", "203.0.113.7"))).status).toBe(429);
    // Another client behind the same proxy has its own count.
    expect((await post("/api/login", { password: "longpassword1" }, via("198.51.100.99", "203.0.113.8"))).status).toBe(200);
  });

  it("counts by the socket's address with TRUST_PROXY=false, whatever X-Forwarded-For says", async () => {
    const { post } = await start({ TRUST_PROXY: "false" });
    for (let i = 0; i < 10; i++) {
      expect((await post("/api/login", { password: "wrong-password" }, { "x-forwarded-for": `203.0.113.${i}` })).status, `attempt ${i + 1}`).toBe(403);
    }
    expect((await post("/api/login", { password: "wrong-password" }, { "x-forwarded-for": "203.0.113.99" })).status).toBe(429);
  });

  it("counts by the address the second proxy saw with TRUST_PROXY=2", async () => {
    const { post } = await start({ TRUST_PROXY: "2" });
    for (let i = 0; i < 10; i++) {
      const headers = { "x-forwarded-for": `198.51.100.${i}, 203.0.113.7, 10.0.0.${i}` };
      expect((await post("/api/login", { password: "wrong-password" }, headers)).status, `attempt ${i + 1}`).toBe(403);
    }
    expect((await post("/api/login", { password: "wrong-password" }, { "x-forwarded-for": "198.51.100.99, 203.0.113.7, 10.0.0.99" })).status).toBe(429);
  });

  it("warns at start about a TRUST_PROXY it cannot use, and trusts one hop", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { post } = await start({ TRUST_PROXY: "not-an-address" });
    expect(warn.mock.calls.map((c) => String(c[0])).some((line) => line.startsWith("[server] TRUST_PROXY "))).toBe(true);
    for (let i = 0; i < 10; i++) expect((await post("/api/login", { password: "wrong-password" }, via(`198.51.100.${i}`, "203.0.113.7"))).status).toBe(403);
    expect((await post("/api/login", { password: "wrong-password" }, via("198.51.100.99", "203.0.113.7"))).status).toBe(429);
  });
});

describe("TRUST_PROXY", () => {
  const setting = (value: string | undefined) => trustProxySetting(value === undefined ? {} : { TRUST_PROXY: value });

  it("trusts one hop when unset or blank", () => {
    expect(setting(undefined)).toEqual({ value: 1 });
    expect(setting("")).toEqual({ value: 1 });
    expect(setting("  ")).toEqual({ value: 1 });
  });

  it("takes a hop count, false, or addresses and names Express trusts", () => {
    expect(setting("2")).toEqual({ value: 2 });
    expect(setting(" 0 ")).toEqual({ value: 0 });
    expect(setting("false")).toEqual({ value: false });
    expect(setting("FALSE")).toEqual({ value: false });
    expect(setting("loopback, uniquelocal")).toEqual({ value: "loopback, uniquelocal" });
    expect(setting("10.0.0.0/8, 203.0.113.7")).toEqual({ value: "10.0.0.0/8, 203.0.113.7" });
  });

  it("falls back to one hop, with a warning, for true, too many hops and what Express cannot read", () => {
    for (const value of ["true", "11", "-1", "1.5", "not-an-address", "loopback,"]) {
      const result = setting(value);
      expect(result.value, value).toBe(1);
      expect(result.warning, value).toMatch(/^TRUST_PROXY[ =].*, so it is ignored: one proxy hop is trusted\.$/);
    }
    expect(setting("true").warning).toContain("any client");
  });
});

describe("throttle's addresses", () => {
  /** Calls the throttle as `ip`: "next" when it lets the request through, else the status it answered. */
  const call = (throttle: ReturnType<typeof attemptThrottle>, ip: string) => {
    let answer: number | "next" = "next";
    const res = {
      status(code: number) {
        answer = code;
        return res;
      },
      json: () => res,
    };
    throttle({ ip } as Request, res as unknown as Response, (() => undefined) as NextFunction);
    return answer;
  };

  it("keeps at most 10 000 addresses", () => {
    const throttle = attemptThrottle();
    for (let i = 0; i < 10_050; i++) call(throttle, `2001:db8::${i.toString(16)}`);
    expect(throttle.size()).toBe(10_000);
  });

  it("drops the oldest address when full, and keeps counting the others", () => {
    const throttle = attemptThrottle({ max: 2, maxAddresses: 3 });
    for (const ip of ["a", "b", "c", "d"]) expect(call(throttle, ip)).toBe("next");
    expect(throttle.size()).toBe(3);
    expect(call(throttle, "d")).toBe("next");
    expect(call(throttle, "d")).toBe(429);
    // "a" was the oldest: dropped, it starts again.
    expect(call(throttle, "a")).toBe("next");
    expect(throttle.size()).toBe(3);
  });

  it("starts an address's count again once its ten minutes ended", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const throttle = attemptThrottle({ max: 2 });
    expect([call(throttle, "a"), call(throttle, "a"), call(throttle, "a")]).toEqual(["next", "next", 429]);
    vi.setSystemTime(new Date("2026-01-01T00:10:00Z"));
    expect(call(throttle, "a")).toBe(429);
    vi.setSystemTime(new Date("2026-01-01T00:10:01Z"));
    expect(call(throttle, "a")).toBe("next");
    expect(throttle.size()).toBe(1);
  });

  it("drops the addresses whose ten minutes ended, before the map is full", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const throttle = attemptThrottle();
    call(throttle, "a");
    call(throttle, "b");
    vi.setSystemTime(new Date("2026-01-01T00:05:00Z"));
    call(throttle, "c");
    expect(throttle.size()).toBe(3);
    vi.setSystemTime(new Date("2026-01-01T00:10:01Z"));
    call(throttle, "d");
    expect(throttle.size()).toBe(2);
  });
});

describe("routines tick throttle", () => {
  it("answers twenty wrong secrets, then refuses even the right one", async () => {
    const { post, routines } = await start();
    const secret = await routines.repo.tickSecret();
    // Right secrets are not counted.
    for (let i = 0; i < 3; i++) expect((await post("/routines/tick", {}, { "x-routines-secret": secret })).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await post("/routines/tick", {}, { "x-routines-secret": `wrong-${i}` })).status, `wrong ${i + 1}`).toBe(401);
    expect((await post("/routines/tick", {}, { "x-routines-secret": secret })).status).toBe(429);
  });

  it("does not start a new count for a made-up X-Forwarded-For", async () => {
    const { post, routines } = await start();
    const secret = await routines.repo.tickSecret();
    for (let i = 0; i < 20; i++) {
      expect((await post("/routines/tick", {}, { "x-routines-secret": `wrong-${i}`, ...via(`198.51.100.${i}`, "203.0.113.7") })).status).toBe(401);
    }
    expect((await post("/routines/tick", {}, { "x-routines-secret": secret, ...via("198.51.100.99", "203.0.113.7") })).status).toBe(429);
  });
});
