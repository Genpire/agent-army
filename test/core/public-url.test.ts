import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectPublicUrl, publicOrigin, publicUrlWarning } from "../../src/core/public-url.js";
import { FsStore } from "../../src/core/store.js";
import { consoleBaseUrl, rememberConsoleUrl } from "../../src/integrations/tickets/ticket-sync.js";
import { createApp } from "../../src/server.js";

describe("publicOrigin", () => {
  it("keeps http(s) addresses without a path, as origins", () => {
    expect(publicOrigin("https://army.example.com")).toBe("https://army.example.com");
    expect(publicOrigin(" https://Army.Example.com/ ")).toBe("https://army.example.com");
    expect(publicOrigin("https://army.example.com//")).toBe("https://army.example.com");
    expect(publicOrigin("http://localhost:8080")).toBe("http://localhost:8080");
    expect(publicOrigin("https://army.example.com:443")).toBe("https://army.example.com");
    expect(publicOrigin("https://10.0.0.5:8443/")).toBe("https://10.0.0.5:8443");
  });

  it("refuses anything else", () => {
    for (const value of [
      undefined,
      "",
      "   ",
      "army.example.com",
      "ftp://army.example.com",
      "javascript:alert(1)",
      "https://army.example.com/army",
      "https://army.example.com/slack/events",
      "https://army.example.com/?a=1",
      "https://army.example.com/#x",
      "https://user:pass@army.example.com",
      "https://",
      "https://exa mple.com",
    ]) {
      expect(publicOrigin(value), String(value)).toBeUndefined();
    }
  });
});

describe("detectPublicUrl", () => {
  it("is undefined with nothing set, or only empty values", () => {
    expect(detectPublicUrl({})).toBeUndefined();
    expect(
      detectPublicUrl({ PUBLIC_URL: "", RENDER_EXTERNAL_URL: " ", RAILWAY_PUBLIC_DOMAIN: "", FLY_APP_NAME: "", KOYEB_PUBLIC_DOMAIN: "", CONTAINER_APP_NAME: "" }),
    ).toBeUndefined();
  });

  it("reads each platform's variable", () => {
    expect(detectPublicUrl({ PUBLIC_URL: "https://army.example.com/" })).toBe("https://army.example.com");
    expect(detectPublicUrl({ RENDER_EXTERNAL_URL: "https://agent-army.onrender.com" })).toBe("https://agent-army.onrender.com");
    expect(detectPublicUrl({ RAILWAY_PUBLIC_DOMAIN: "agent-army-production.up.railway.app" })).toBe("https://agent-army-production.up.railway.app");
    expect(detectPublicUrl({ FLY_APP_NAME: "agent-army" })).toBe("https://agent-army.fly.dev");
    expect(detectPublicUrl({ KOYEB_PUBLIC_DOMAIN: "agent-army-acme.koyeb.app" })).toBe("https://agent-army-acme.koyeb.app");
    expect(detectPublicUrl({ CONTAINER_APP_NAME: "agent-army", CONTAINER_APP_ENV_DNS_SUFFIX: "blue-sea-123.eastus.azurecontainerapps.io" })).toBe(
      "https://agent-army.blue-sea-123.eastus.azurecontainerapps.io",
    );
    // Azure needs both parts.
    expect(detectPublicUrl({ CONTAINER_APP_NAME: "agent-army" })).toBeUndefined();
  });

  it("takes them in order: PUBLIC_URL, Render, Railway, Fly.io, Koyeb, Azure", () => {
    const all = {
      PUBLIC_URL: "https://army.example.com",
      RENDER_EXTERNAL_URL: "https://a.onrender.com",
      RAILWAY_PUBLIC_DOMAIN: "a.up.railway.app",
      FLY_APP_NAME: "a",
      KOYEB_PUBLIC_DOMAIN: "a.koyeb.app",
      CONTAINER_APP_NAME: "a",
      CONTAINER_APP_ENV_DNS_SUFFIX: "x.azurecontainerapps.io",
    };
    const order = ["https://army.example.com", "https://a.onrender.com", "https://a.up.railway.app", "https://a.fly.dev", "https://a.koyeb.app", "https://a.x.azurecontainerapps.io"];
    const keys = Object.keys(all) as (keyof typeof all)[];
    for (const [i, expected] of order.entries()) {
      const env: NodeJS.ProcessEnv = { ...all };
      for (const k of keys.slice(0, i)) delete env[k];
      expect(detectPublicUrl(env)).toBe(expected);
    }
  });

  it("skips an invalid PUBLIC_URL, and says so", () => {
    expect(detectPublicUrl({ PUBLIC_URL: "https://army.example.com/console" })).toBeUndefined();
    expect(detectPublicUrl({ PUBLIC_URL: "army.example.com", FLY_APP_NAME: "army" })).toBe("https://army.fly.dev");
    expect(publicUrlWarning({ PUBLIC_URL: "army.example.com", FLY_APP_NAME: "army" })).toMatch(/PUBLIC_URL .* ignored; using https:\/\/army\.fly\.dev instead/);
    expect(publicUrlWarning({ PUBLIC_URL: "https://army.example.com/console" })).toMatch(/each request's own address/);
    expect(publicUrlWarning({ PUBLIC_URL: "https://army.example.com/" })).toBeUndefined();
    expect(publicUrlWarning({ PUBLIC_URL: "" })).toBeUndefined();
    expect(publicUrlWarning({})).toBeUndefined();
  });
});

describe("the public address in use", () => {
  const servers: { close(): void }[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  async function eventsUrl(env: NodeJS.ProcessEnv) {
    const dir = await mkdtemp(join(tmpdir(), "army-public-url-"));
    const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-123", RUNNER: "local", ...env });
    const server = app.listen(0);
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const setup = await fetch(`${base}/api/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setupToken: "setup-123", password: "longpassword1" }),
    });
    const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    const state = await (await fetch(`${base}/api/state`, { headers: { cookie } })).json();
    return { base, url: state.eventsUrl as string };
  }

  it("is the platform's address on the server, else the request's", async () => {
    expect((await eventsUrl({ RENDER_EXTERNAL_URL: "https://agent-army.onrender.com" })).url).toBe("https://agent-army.onrender.com/slack/events");
    expect((await eventsUrl({ RAILWAY_PUBLIC_DOMAIN: "army.up.railway.app" })).url).toBe("https://army.up.railway.app/slack/events");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fallback = await eventsUrl({ PUBLIC_URL: "https://army.example.com/console" });
    expect(fallback.url).toBe(`${fallback.base}/slack/events`);
    expect(warn.mock.calls.map((c) => String(c[0])).some((l) => l.includes("PUBLIC_URL is not an http(s) address"))).toBe(true);
    warn.mockRestore();
  });

  it("is the platform's address in ticket links, before the saved one", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-public-url-")));
    await rememberConsoleUrl(store, "https://saved.example.com");
    expect(await consoleBaseUrl(store, { FLY_APP_NAME: "army" })).toBe("https://army.fly.dev");
    expect(await consoleBaseUrl(store, { PUBLIC_URL: "" })).toBe("https://saved.example.com");
    expect(await consoleBaseUrl(store, { PUBLIC_URL: "https://army.example.com/console" })).toBe("https://saved.example.com");
  });
});
