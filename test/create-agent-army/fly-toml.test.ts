import { describe, expect, it } from "vitest";
import { FLY_VOLUME, flyConfigName, flyToml } from "../../packages/create-agent-army/src/providers/fly.js";
import { run } from "./helpers.js";

/** The `key = value` pairs of one [table] (or the top level, for ""), first occurrence only. */
function table(toml: string, name: string): Record<string, string> {
  const lines = toml.split("\n").map((l) => l.replace(/#.*$/, "").trim());
  const result: Record<string, string> = {};
  let current = "";
  for (const line of lines) {
    const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      if (current === name && Object.keys(result).length > 0) break;
      current = header[1] ?? "";
      continue;
    }
    const kv = line.match(/^([A-Za-z_]+)\s*=\s*(.+)$/);
    if (kv && current === name && !(kv[1]! in result)) result[kv[1]!] = kv[2]!;
  }
  return result;
}

describe("create-agent-army: the generated fly.toml", () => {
  const toml = flyToml({ name: "my-army", region: "fra", image: "ghcr.io/genpire/agent-army:latest" });

  it("deploys the prebuilt image, with no build", () => {
    expect(table(toml, "")).toMatchObject({ app: '"my-army"', primary_region: '"fra"', kill_signal: '"SIGTERM"', kill_timeout: "300" });
    expect(table(toml, "build")).toEqual({ image: '"ghcr.io/genpire/agent-army:latest"' });
    expect(toml).not.toMatch(/^\s*dockerfile\s*=/m);
  });

  it("keeps the data and the task checkouts on the volume", () => {
    expect(table(toml, "env")).toEqual({
      STORAGE: '"fs"',
      DATA_DIR: '"/data"',
      WORK_DIR: '"/data"',
      RUNNER: '"local"',
      REQUIRE_MASTER_KEY: '"1"',
      PUBLIC_URL: '"https://my-army.fly.dev"',
    });
    expect(table(toml, "mounts")).toMatchObject({ source: `"${FLY_VOLUME}"`, destination: '"/data"' });
  });

  it("is always on, with /healthz checks, on an 8 GB Machine", () => {
    expect(table(toml, "http_service")).toMatchObject({
      internal_port: "8080",
      force_https: "true",
      auto_stop_machines: '"off"',
      min_machines_running: "1",
    });
    expect(table(toml, "http_service.checks")).toMatchObject({ method: '"GET"', path: '"/healthz"' });
    expect(table(toml, "restart")).toEqual({ policy: '"always"' });
    expect(table(toml, "vm")).toEqual({ size: '"shared-cpu-4x"', memory: '"8gb"' });
  });

  it("never contains a secret", () => {
    expect(toml).not.toMatch(/^\s*(MASTER_KEY|SETUP_TOKEN)\s*=/m);
  });

  it("is named after the deployment, and written next to the keys", async () => {
    expect(flyConfigName("my-army")).toBe("agent-army-my-army.fly.toml");
    expect(flyConfigName("agent-army-3f9c")).toBe("agent-army-3f9c.fly.toml");

    const result = await run(["--provider", "fly", "--name", "my-army", "--region", "fra", "--yes"]);
    expect(result.code).toBe(0);
    expect(result.files.get("/work/agent-army-my-army.fly.toml")?.content).toBe(toml);
    const deploy = result.calls.find((c) => c.line.startsWith("fly deploy"));
    expect(deploy?.args).toEqual(["deploy", "--app", "my-army", "--config", "agent-army-my-army.fly.toml", "--ha=false", "--wait-timeout", "15m"]);
    expect(deploy?.cwd).toBe("/work");
  });
});
