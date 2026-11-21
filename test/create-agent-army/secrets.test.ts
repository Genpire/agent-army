import { describe, expect, it } from "vitest";
import { keysFileContent, keysFileName } from "../../packages/create-agent-army/src/files.js";
import { createOutput } from "../../packages/create-agent-army/src/output.js";
import { Redactor, generateSecrets } from "../../packages/create-agent-army/src/secrets.js";
import { CLONE_FILES, type Handler, SECRETS, loggedIn, overlay, run } from "./helpers.js";

const FLAGS: Record<string, string[]> = {
  fly: ["--provider", "fly"],
  railway: ["--provider", "railway"],
  gcloud: ["--provider", "gcloud", "--project", "example-project"],
  docker: ["--provider", "docker"],
  vm: ["--provider", "vm", "--host", "root@203.0.113.7", "--domain", "army.example.com"],
  render: ["--provider", "render", "--no-open"],
};

/** Every CLI also echoes the keys back, in pieces, wherever its output is shown. */
const leaky: Handler = overlay((call) => {
  if (call.capture) return undefined;
  const k = SECRETS.masterKey;
  return { chunks: [`progress ${k.slice(0, 10)}`, `${k.slice(10)} done\n`, `token ${SECRETS.setupToken}\n`, "tail without newline ", k] };
}, loggedIn);

describe("create-agent-army: secrets", () => {
  it("makes a 32-byte base64 MASTER_KEY and an 18-byte hex SETUP_TOKEN", () => {
    const a = generateSecrets();
    const b = generateSecrets();
    expect(Buffer.from(a.masterKey, "base64")).toHaveLength(32);
    expect(a.masterKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(a.setupToken).toMatch(/^[0-9a-f]{36}$/);
    expect(a.masterKey).not.toBe(b.masterKey);
    expect(a.setupToken).not.toBe(b.setupToken);
  });

  it("redacts values, including ones split across chunks of child output", () => {
    const redactor = new Redactor();
    redactor.add("supersecretvalue", "<hidden>");
    let shown = "";
    const out = createOutput({ stdout: { write: (t) => void (shown += t) }, stderr: { write: (t) => void (shown += t) }, redactor });
    out.line("a supersecretvalue b");
    out.stream("x super", "stdout");
    out.stream("secretvalue y\nz", "stdout");
    out.stream("\r", "stdout");
    out.stream("supersecret", "stderr");
    out.stream("value", "stderr");
    out.flush();
    expect(shown).not.toContain("supersecretvalue");
    expect(shown).toContain("a <hidden> b");
    expect(shown).toContain("x <hidden> y\nz\r");
    expect(shown.endsWith("<hidden>")).toBe(true);
  });

  it.each(Object.keys(FLAGS))("never prints MASTER_KEY: %s", async (provider) => {
    const result = await run([...(FLAGS[provider] ?? []), "--name", "my-army", "--yes"], {
      handler: leaky,
      cwd: provider === "gcloud" ? "/repo" : "/work",
      files: provider === "gcloud" ? CLONE_FILES : {},
    });
    expect(result.code).toBe(0);
    expect(result.all).not.toContain(SECRETS.masterKey);
    expect(result.all).not.toContain(SECRETS.masterKey.slice(0, 20));
    if (["fly", "gcloud", "docker", "vm"].includes(provider)) {
      // These show a CLI's own output (deploy logs): the leaked key is there, redacted.
      expect(result.all).toContain("<MASTER_KEY hidden>");
    }
    if (provider !== "render") {
      // The setup token is shown once, in the summary, and never in a command line.
      expect(result.stdout).toContain(`Setup token:  ${SECRETS.setupToken}`);
      expect(result.commands.join("\n")).not.toContain(SECRETS.setupToken);
    }
  });

  it.each(["fly", "railway", "gcloud", "docker", "vm"])("passes the keys on stdin or in the environment, never on a command line it shows: %s", async (provider) => {
    const result = await run([...(FLAGS[provider] ?? []), "--name", "my-army", "--yes"], {
      cwd: provider === "gcloud" ? "/repo" : "/work",
      files: provider === "gcloud" ? CLONE_FILES : {},
    });
    expect(result.code).toBe(0);
    for (const line of result.commands) {
      expect(line).not.toContain(SECRETS.masterKey);
      expect(line).not.toContain(SECRETS.setupToken);
    }
    const carrying = result.calls.filter((c) => c.input?.includes(SECRETS.masterKey) || c.env?.MASTER_KEY === SECRETS.masterKey);
    const inArgv = result.calls.filter((c) => c.args.some((a) => a.includes(SECRETS.masterKey)));
    if (provider === "fly") {
      // `fly secrets set` takes NAME=VALUE arguments: shown redacted, never stdin.
      expect(inArgv.map((c) => c.args.slice(0, 2).join(" "))).toEqual(["secrets set"]);
      expect(result.commands).toContain("fly secrets set --app my-army --stage MASTER_KEY=<MASTER_KEY> SETUP_TOKEN=<SETUP_TOKEN>");
    } else {
      expect(inArgv).toEqual([]);
      expect(carrying.length).toBeGreaterThan(0);
    }
  });

  it("saves agent-army-<name>.env with mode 600, MASTER_KEY and a warning", async () => {
    const result = await run(["--provider", "fly", "--name", "my-army", "--yes"]);
    const file = result.files.get("/work/agent-army-my-army.env");
    expect(file?.mode).toBe(0o600);
    expect(file?.content).toContain(`MASTER_KEY=${SECRETS.masterKey}`);
    expect(file?.content).toContain(`SETUP_TOKEN=${SECRETS.setupToken}`);
    expect(file?.content).toContain("AGENT_ARMY_URL=https://my-army.fly.dev");
    expect(file?.content).toMatch(/KEEP THIS FILE SAFE/);
    expect(result.stdout).toContain("Saved the keys to ./agent-army-my-army.env (mode 600)");
    expect(result.stdout).toContain("MASTER_KEY decrypts your data");
  });

  it("names the keys file once, and writes the content it describes", () => {
    expect(keysFileName("my-army")).toBe("agent-army-my-army.env");
    expect(keysFileName("agent-army-3f9c")).toBe("agent-army-3f9c.env");
    const content = keysFileContent({ name: "x-army", provider: "Fly.io", secrets: SECRETS, extra: { AGENT_ARMY_URL: "https://x" }, date: new Date("2026-11-21T00:00:00Z") });
    expect(content.split("\n")[0]).toBe('# Agent Army "x-army" on Fly.io, written by create-agent-army on 2026-11-21.');
    expect(content).toMatch(/^AGENT_ARMY_URL=https:\/\/x$/m);
  });

  it("writes no keys file for Render, whose Blueprint makes the keys", async () => {
    const result = await run(["--provider", "render", "--name", "my-army", "--yes", "--no-open"]);
    expect([...result.files.keys()]).toEqual([]);
    expect(result.stdout).toContain("Setup token:  Render > the agent-army service > Environment > SETUP_TOKEN");
    expect(result.stdout).toContain("MASTER_KEY:   Render > the agent-army service > Environment > MASTER_KEY");
    expect(result.stdout).not.toContain(SECRETS.setupToken);
  });

  it("dry runs print no key, and write nothing", async () => {
    for (const provider of Object.keys(FLAGS)) {
      const result = await run([...(FLAGS[provider] ?? []), "--name", "my-army", "--dry-run"], { cwd: provider === "gcloud" ? "/repo" : "/work", files: provider === "gcloud" ? CLONE_FILES : {} });
      expect(result.code).toBe(0);
      expect(result.all).not.toContain(SECRETS.masterKey);
      expect(result.all).not.toContain(SECRETS.setupToken);
      expect([...result.files.keys()].filter((p) => !(p in CLONE_FILES))).toEqual([]);
    }
  });
});
