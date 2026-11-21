import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server.js";

/**
 * An empty SETUP_TOKEN (Docker Compose passes "" for a variable left empty in
 * .env) must never let anyone create the admin account or reset its password
 * with an empty token. Nor may an empty PUBLIC_URL replace the request's address.
 */
describe("an empty setup token", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
    vi.restoreAllMocks();
  });

  /** A fresh server with these variables, and the setup token it printed (none when SETUP_TOKEN was set). */
  async function start(env: NodeJS.ProcessEnv) {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = await mkdtemp(join(tmpdir(), "army-setup-token-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", RUNNER: "local", ...env });
    const printed = logs.mock.calls
      .map((c) => c.map(String).join(" "))
      .map((line) => line.match(/setup token: (\S+)/)?.[1])
      .find(Boolean);
    logs.mockRestore();
    const server = app.listen(0);
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = (path: string, body: unknown, cookie?: string) =>
      fetch(base + path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const state = async (cookie?: string) => (await fetch(base + "/api/state", { headers: cookie ? { cookie } : {} })).json();
    return { base, post, state, printed };
  }

  for (const [label, value] of [
    ["empty", ""],
    ["blank", "   "],
    ["unset", undefined],
  ] as const) {
    it(`cannot set up or reset with an empty token when SETUP_TOKEN is ${label}`, async () => {
      const { post, state, printed } = await start(value === undefined ? {} : { SETUP_TOKEN: value });

      // A token is generated and printed: never empty.
      expect(printed).toMatch(/^[A-Za-z0-9_-]{20,}$/);
      for (const setupToken of ["", " ", "   \t"]) {
        expect((await post("/api/setup", { setupToken, password: "longpassword1" })).status).toBe(403);
      }
      expect((await state()).setupRequired).toBe(true);

      // The printed token works; an empty one still cannot reset the password afterwards.
      const ok = await post("/api/setup", { setupToken: printed, password: "longpassword1" });
      expect(ok.status).toBe(200);
      for (const setupToken of ["", " "]) {
        expect((await post("/api/reset-password", { setupToken, password: "attacker-password" })).status).toBe(403);
      }
      expect((await post("/api/login", { password: "attacker-password" })).status).toBe(403);
      expect((await post("/api/login", { password: "longpassword1" })).status).toBe(200);
    });
  }

  it("refuses an empty token even next to a configured one, and trims the configured one", async () => {
    const { post, printed } = await start({ SETUP_TOKEN: "  setup-xyz  " });
    expect(printed).toBeUndefined();
    expect((await post("/api/setup", { setupToken: "", password: "longpassword1" })).status).toBe(403);
    expect((await post("/api/setup", { setupToken: "setup-xyz", password: "longpassword1" })).status).toBe(200);
    expect((await post("/api/reset-password", { setupToken: "", password: "another-password" })).status).toBe(403);
    expect((await post("/api/reset-password", { setupToken: " setup-xyz ", password: "another-password" })).status).toBe(200);
  });

  it("treats an empty PUBLIC_URL as unset: the request's address is used", async () => {
    const { base, post, state } = await start({ SETUP_TOKEN: "setup-xyz", PUBLIC_URL: "  " });
    const ok = await post("/api/setup", { setupToken: "setup-xyz", password: "longpassword1" });
    const cookie = ok.headers.get("set-cookie")!.split(";")[0]!;
    const view = await state(cookie);
    expect(view.eventsUrl).toBe(`${base}/slack/events`);
    expect(view.githubWebhookUrl).toBe(`${base}/github/webhook`);
  });
});
