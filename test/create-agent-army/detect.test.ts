import { describe, expect, it } from "vitest";
import { bestProvider, detectProviders, findClone } from "../../packages/create-agent-army/src/detect.js";
import { createRunner } from "../../packages/create-agent-army/src/exec.js";
import { createOutput } from "../../packages/create-agent-army/src/output.js";
import { Redactor } from "../../packages/create-agent-army/src/secrets.js";
import type { Fs } from "../../packages/create-agent-army/src/types.js";
import { CLONE_FILES, type Handler, loggedIn, nothingInstalled, overlay, run } from "./helpers.js";

function memoryFs(files: Record<string, string> = {}): Fs {
  return {
    exists: (p) => p in files,
    readFile: (p) => files[p] ?? "",
    writePrivateFile: () => {},
    writeFile: () => {},
    makeTempDir: () => "/tmp/x",
  };
}

async function detect(handler: Handler, options: { cwd?: string; files?: Record<string, string>; env?: Record<string, string> } = {}) {
  const lines: string[] = [];
  const redactor = new Redactor();
  const out = createOutput({ stdout: { write: (t) => lines.push(t) }, stderr: { write: (t) => lines.push(t) }, redactor });
  const calls: string[] = [];
  const runner = createRunner({
    out,
    redactor,
    dryRun: false,
    launch: async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      const reply = handler({ cmd, args, line, capture: true }) ?? {};
      return { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "", notFound: reply.notFound };
    },
  });
  const found = await detectProviders({ run: runner, cwd: options.cwd ?? "/work", fs: memoryFs(options.files), env: options.env ?? {} });
  return { found, calls, printed: lines.join("") };
}

describe("create-agent-army: provider detection", () => {
  it("finds nothing when no CLI is installed, and offers Render in the browser", async () => {
    const { found, printed } = await detect(nothingInstalled);
    expect(found.map((d) => [d.id, d.installed, d.ready])).toEqual([
      ["fly", false, false],
      ["railway", false, false],
      ["render", false, false],
      ["gcloud", false, false],
      ["docker", false, false],
      ["vm", false, false],
    ]);
    expect(bestProvider(found)).toBe("render");
    expect(printed).toBe(""); // checks never print anything
  });

  it("reads who each CLI is logged in as", async () => {
    const { found, calls } = await detect(loggedIn, { cwd: "/repo/packages", files: CLONE_FILES });
    const byId = Object.fromEntries(found.map((d) => [d.id, d]));
    expect(byId.fly).toMatchObject({ installed: true, ready: true, account: "pilot@example.com", cli: "fly" });
    expect(byId.railway).toMatchObject({ ready: true, account: "user@example.com" });
    expect(byId.railway?.details.workspaces).toEqual([{ id: "ws-1", name: "Personal" }]);
    expect(byId.gcloud).toMatchObject({ ready: true, account: "user@example.com" });
    expect(byId.gcloud?.details).toEqual({ project: "example-project", clone: "/repo" });
    expect(byId.docker).toMatchObject({ ready: true });
    expect(byId.vm).toMatchObject({ ready: true });
    expect(calls).toEqual(
      expect.arrayContaining([
        "fly auth whoami",
        "railway whoami --json",
        "gcloud auth list --filter=status:ACTIVE --format=value(account)",
        "gcloud config get-value project",
        "docker info --format {{.ServerVersion}}",
        "ssh -V",
      ]),
    );
  });

  it("falls back to the flyctl name, and tells installed from logged in", async () => {
    const handler: Handler = ({ cmd, line }) => {
      if (cmd === "fly") return { notFound: true };
      if (line === "flyctl auth whoami") return { code: 1, stderr: "not logged in" };
      if (line === "railway whoami --json") return { code: 1, stderr: "Unauthorized" };
      if (line.startsWith("docker info")) return { code: 1, stderr: "Cannot connect to the Docker daemon" };
      if (line.startsWith("gcloud auth list")) return { stdout: "" };
      if (line === "gcloud config get-value project") return { stdout: "(unset)\n" };
      return undefined;
    };
    const { found } = await detect(handler);
    const byId = Object.fromEntries(found.map((d) => [d.id, d]));
    expect(byId.fly).toMatchObject({ cli: "flyctl", installed: true, ready: false });
    expect(byId.fly?.status).toContain("flyctl auth login");
    expect(byId.railway).toMatchObject({ installed: true, ready: false });
    expect(byId.railway?.status).toContain("railway login");
    expect(byId.docker).toMatchObject({ installed: true, ready: false });
    expect(byId.docker?.status).toContain("not running");
    expect(byId.gcloud).toMatchObject({ installed: true, ready: false });
    expect(byId.gcloud?.details.project).toBeUndefined();
    expect(byId.gcloud?.status).toContain("gcloud auth login");
    expect(byId.gcloud?.status).toContain("Cloud Shell");
  });

  it("reports the Render CLI and an API key when they are there", async () => {
    const handler: Handler = ({ cmd, line }) => (cmd === "render" ? (line === "render whoami -o text" ? { stdout: "Test" } : {}) : undefined);
    const { found } = await detect(handler, { env: { RENDER_API_KEY: "rnd_test" } });
    const render = found.find((d) => d.id === "render");
    expect(render).toMatchObject({ installed: true, ready: true, details: { apiKey: true } });
  });

  it("prefers a ready cloud CLI, then local Docker, then Render", async () => {
    const all = (await detect(loggedIn, { cwd: "/repo", files: CLONE_FILES })).found;
    expect(bestProvider(all)).toBe("railway");

    const noRailway = (await detect(overlay(({ cmd }) => (cmd === "railway" ? { notFound: true } : undefined), loggedIn))).found;
    expect(bestProvider(noRailway)).toBe("fly");

    const onlyGcloud = overlay(({ cmd }) => (cmd === "railway" || cmd === "fly" || cmd === "flyctl" ? { notFound: true } : undefined), loggedIn);
    expect(bestProvider((await detect(onlyGcloud, { cwd: "/repo", files: CLONE_FILES })).found)).toBe("gcloud");
    // gcloud outside a clone means Cloud Shell in the browser: Docker comes first then.
    expect(bestProvider((await detect(onlyGcloud)).found)).toBe("docker");
  });

  it("finds the clone root from a subfolder, and only for this repo", () => {
    expect(findClone("/repo/web/src", memoryFs(CLONE_FILES))).toBe("/repo");
    expect(findClone("/elsewhere", memoryFs(CLONE_FILES))).toBeUndefined();
    const otherRepo = { "/other/package.json": JSON.stringify({ name: "other" }), "/other/deploy/gcp.sh": "" };
    expect(findClone("/other", memoryFs(otherRepo))).toBeUndefined();
  });

  it("lists what it found, and picks the best one without asking under --yes", async () => {
    const result = await run(["--yes", "--dry-run", "--name", "my-army"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Fly\.io\s+logged in as pilot@example\.com/);
    expect(result.stdout).toMatch(/Railway\s+logged in as user@example\.com/);
    expect(result.stdout).toContain("Using Railway (choose another with --provider).");
    expect(result.stdout).toContain("==> Plan: Railway");
  });

  it("asks once, with the best choice as the default", async () => {
    const result = await run(["--dry-run"], { interactive: true, answers: ["", "", ""] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Where should Agent Army run?");
    expect(result.stdout).toMatch(/\* 2\) Railway/);
    expect(result.stdout).toContain("==> Plan: Railway");
    expect(result.stdout).toContain("railway init --name agent-army-test --workspace ws-1 --json");
  });
});
