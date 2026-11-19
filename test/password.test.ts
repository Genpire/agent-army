import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/server.js";

/** The admin password: reset with the setup token, change while signed in, and old sessions signed out. */
describe("admin password", () => {
  let base = "";
  let close: () => void;
  const post = (path: string, body: unknown, cookie?: string) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const sessionOf = (res: Response) => res.headers.get("set-cookie")!.split(";")[0]!;
  const authed = async (cookie: string) => (await (await fetch(base + "/api/state", { headers: { cookie } })).json()).authed as boolean;

  // A fresh server per test: the sign-in routes allow 10 attempts per address every 10 minutes.
  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), "army-password-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local" });
    const server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  afterEach(() => close());

  it("cannot be reset before the admin account exists", async () => {
    expect((await post("/api/reset-password", { setupToken: "setup-123", password: "brand-new-password" })).status).toBe(409);
  });

  it("is reset with the setup token, which signs out the old sessions", async () => {
    const first = sessionOf(await post("/api/setup", { setupToken: "setup-123", password: "first-password" }));
    expect(await authed(first)).toBe(true);

    expect((await post("/api/reset-password", { setupToken: "wrong", password: "second-password" })).status).toBe(403);
    expect((await post("/api/reset-password", { setupToken: "setup-123", password: "short" })).status).toBe(400);
    const reset = await post("/api/reset-password", { setupToken: " setup-123 ", password: "second-password" });
    expect(reset.status).toBe(200);
    const second = sessionOf(reset);

    expect(await authed(second)).toBe(true);
    expect(await authed(first)).toBe(false);
    expect((await post("/api/login", { password: "first-password" })).status).toBe(403);
    expect((await post("/api/login", { password: "second-password" })).status).toBe(200);
  });

  it("is changed while signed in only with the current password", async () => {
    const session = sessionOf(await post("/api/setup", { setupToken: "setup-123", password: "second-password" }));
    const other = sessionOf(await post("/api/login", { password: "second-password" }));

    expect((await post("/api/password", { currentPassword: "second-password", password: "third-password" })).status).toBe(401);
    expect((await post("/api/password", { currentPassword: "nope", password: "third-password" }, session)).status).toBe(403);
    const changed = await post("/api/password", { currentPassword: "second-password", password: "third-password" }, session);
    expect(changed.status).toBe(200);

    expect(await authed(sessionOf(changed))).toBe(true);
    expect(await authed(other)).toBe(false);
    expect((await post("/api/login", { password: "third-password" })).status).toBe(200);
  });
});
