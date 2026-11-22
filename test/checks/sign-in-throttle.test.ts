import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/server.js";

/**
 * The brute-force brakes on the routes that check a secret without a
 * session: sign-in, setup and password reset share 10 attempts per address
 * every 10 minutes; the routines tick allows 20 wrong secrets. Both sides:
 * the attempts under the limit are answered, the ones over it are not, even
 * with the right secret.
 */

const servers: { close(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function start() {
  const dir = await mkdtemp(join(tmpdir(), "army-checks-throttle-"));
  const made = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-acme-123", RUNNER: "local" });
  const server = made.app.listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { post, routines: made.routines };
}

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
});
