import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Config, ConfigRepo } from "../../src/core/config.js";
import { deriveKey } from "../../src/core/crypto.js";
import { FsStore } from "../../src/core/store.js";
import { createApp } from "../../src/server.js";

/**
 * GitLab deliveries are only read while GitLab is connected: a webhook
 * secret left in a config without a token (an older or hand-edited one)
 * answers 404 even to the right secret. With the token, the same delivery
 * gets past the gate.
 */

const SECRET = "acme-placeholder-gitlab-hook-secret";
const servers: { close(): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function serverWith(patch: (c: Config) => void) {
  const dir = await mkdtemp(join(tmpdir(), "army-checks-gitlab-hook-"));
  await new ConfigRepo(new FsStore(dir), deriveKey("m"), 0).update(patch);
  const { app } = await createApp({ DATA_DIR: dir, MASTER_KEY: "m", SETUP_TOKEN: "setup-acme-123", RUNNER: "local" });
  const server = app.listen(0);
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // No X-Gitlab-Event header: past the gate this is a 400, before it a 404.
  return () => fetch(`${base}/gitlab/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-gitlab-token": SECRET }, body: "{}" });
}

describe("GitLab webhook gate", () => {
  it("answers 404 to a delivery with the right secret while GitLab has no token", async () => {
    const deliver = await serverWith((c) => void (c.gitlab.webhookSecret = SECRET));
    expect((await deliver()).status).toBe(404);
  });

  it("lets the same delivery past the gate once GitLab has a token", async () => {
    const deliver = await serverWith((c) => {
      c.gitlab.webhookSecret = SECRET;
      c.gitlab.token = "glpat-acme-placeholder";
    });
    const res = await deliver();
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Missing or invalid X-Gitlab-Event header." });
  });
});
