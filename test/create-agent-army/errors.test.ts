import { describe, expect, it } from "vitest";
import { waitForHealthy } from "../../packages/create-agent-army/src/health.js";
import { CLONE_FILES, type Handler, SECRETS, loggedIn, mutating, nothingInstalled, overlay, run } from "./helpers.js";

describe("create-agent-army: errors", () => {
  it("a missing CLI: where to install it and how to log in, nothing created", async () => {
    const result = await run(["--provider", "fly", "--name", "my-army", "--yes"], { handler: nothingInstalled });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Fly.io needs the fly command, which is not installed.");
    expect(result.stdout).toContain("Install it: https://fly.io/docs/flyctl/install/");
    expect(result.stdout).toContain("Then: fly auth login");
    expect(result.stdout).toContain("Nothing was created.");
    expect(result.files.size).toBe(0);
  });

  it.each([
    ["fly", ({ line }) => (line === "fly auth whoami" ? { code: 1 } : undefined), "fly is not logged in.", "fly auth login"],
    ["railway", ({ line }) => (line === "railway whoami --json" ? { code: 1 } : undefined), "railway is not logged in.", "railway login"],
    ["docker", ({ line }) => (line.startsWith("docker info") ? { code: 1 } : undefined), "The Docker daemon is not running.", "Start Docker Desktop"],
  ] as [string, Handler, string, string][])("a CLI that isn't logged in: %s", async (provider, handler, message, fix) => {
    const result = await run(["--provider", provider, "--name", "my-army", "--yes"], { handler: overlay(handler, loggedIn) });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
    expect(result.stdout).toContain(fix);
    expect(mutating(result.calls)).toEqual([]);
  });

  it("a partial failure: what was created and how to remove it, with the key still hidden", async () => {
    const handler = overlay(({ line }) => {
      if (line.startsWith("fly secrets set")) return { code: 1, stderr: `Error: could not set MASTER_KEY=${SECRETS.masterKey}\n` };
      return undefined;
    }, loggedIn);
    const result = await run(["--provider", "fly", "--name", "my-army", "--yes"], { handler });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Error: This command failed (exit code 1):");
    expect(result.stderr).toContain("fly secrets set --app my-army --stage MASTER_KEY=<MASTER_KEY> SETUP_TOKEN=<SETUP_TOKEN>");
    expect(result.stdout).toContain("could not set MASTER_KEY=<MASTER_KEY hidden>");
    expect(result.stdout).toContain("Created so far");
    expect(result.stdout).toContain("- Fly.io app my-army, with its volume and secrets");
    expect(result.stdout).toContain("fly apps destroy my-army --yes");
    expect(result.stdout).toContain("The keys are in ./agent-army-my-army.env");
    expect(result.all).not.toContain(SECRETS.masterKey);
    expect(result.calls.some((c) => c.line.startsWith("fly deploy"))).toBe(false);
  });

  it("a taken Fly.io name says so", async () => {
    const handler = overlay(({ line }) => (line.startsWith("fly apps create") ? { code: 1 } : undefined), loggedIn);
    const result = await run(["--provider", "fly", "--name", "my-army", "--yes"], { handler });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Fly.io app names are global");
    expect(result.stdout).toContain("Nothing was created.");
  });

  it("removes a half-made Railway project by its id", async () => {
    const handler = overlay(({ line }) => {
      if (line.startsWith("railway init")) return { stdout: JSON.stringify({ id: "prj-1234", name: "my-army" }) };
      if (line.startsWith("railway volume add")) return { code: 1, stderr: "volume limit reached" };
      return undefined;
    }, loggedIn);
    const result = await run(["--provider", "railway", "--name", "my-army", "--yes"], { handler });
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("volume limit reached");
    expect(result.stdout).toContain("railway delete --project prj-1234 --yes");
    // The CLI ran in a new empty folder, not the one the user is in.
    expect(result.calls.find((c) => c.line.startsWith("railway init"))?.cwd).toBe("/tmp/create-agent-army-railway-1");
  });

  it("lists every Cloud Run resource when gcp.sh fails", async () => {
    const handler = overlay(({ line }) => (line === "bash deploy/gcp.sh" ? { code: 1 } : undefined), loggedIn);
    const result = await run(["--provider", "gcloud", "--name", "my-army", "--project", "example-project", "--yes"], {
      handler,
      cwd: "/repo",
      files: CLONE_FILES,
    });
    expect(result.code).toBe(1);
    for (const expected of [
      "gcloud secrets delete my-army-master-key --project example-project",
      "gcloud run services delete my-army --region us-central1 --project example-project",
      "gcloud run jobs delete my-army-worker --region us-central1 --project example-project",
      "gcloud storage rm --recursive gs://example-project-my-army-data",
    ]) {
      expect(result.stdout).toContain(expected);
    }
  });

  it("never overwrites an earlier keys file", async () => {
    const result = await run(["--provider", "fly", "--name", "my-army", "--yes"], {
      files: { "/work/agent-army-my-army.env": "MASTER_KEY=old" },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("./agent-army-my-army.env already exists.");
    expect(result.files.get("/work/agent-army-my-army.env")?.content).toBe("MASTER_KEY=old");
    expect(mutating(result.calls)).toEqual([]);
  });

  it("asks for what it needs, or says which flag to pass", async () => {
    const severalWorkspaces = overlay(
      ({ line }) =>
        line === "railway whoami --json"
          ? { stdout: JSON.stringify({ workspaces: [{ id: "ws-1", name: "Personal" }, { id: "ws-2", name: "Team" }] }) }
          : undefined,
      loggedIn,
    );
    const railway = await run(["--provider", "railway", "--name", "my-army", "--yes"], { handler: severalWorkspaces });
    expect(railway.code).toBe(1);
    expect(railway.stdout).toContain("Choose one with --org: Personal, Team");
    const withOrg = await run(["--provider", "railway", "--name", "my-army", "--org", "team", "--yes"], { handler: severalWorkspaces });
    expect(withOrg.code).toBe(0);
    expect(withOrg.calls.some((c) => c.line === "railway init --name my-army --workspace ws-2 --json")).toBe(true);

    const vm = await run(["--provider", "vm", "--name", "my-army", "--yes"]);
    expect(vm.code).toBe(1);
    expect(vm.stdout).toContain("Pass --host");
    const vmNoDomain = await run(["--provider", "vm", "--name", "my-army", "--host", "root@203.0.113.7", "--yes"]);
    expect(vmNoDomain.code).toBe(1);
    expect(vmNoDomain.stdout).toContain("Pass --domain");

    const noProject = overlay(({ line }) => (line === "gcloud config get-value project" ? { stdout: "" } : undefined), loggedIn);
    const gcloud = await run(["--provider", "gcloud", "--name", "my-army", "--yes"], {
      handler: noProject,
      cwd: "/repo",
      files: CLONE_FILES,
    });
    expect(gcloud.code).toBe(1);
    expect(gcloud.stdout).toContain("gcloud config set project <id>");
  });

  it("a deployment that doesn't answer: a warning, a hint, exit code 1, the summary anyway", async () => {
    const result = await run(["--provider", "fly", "--name", "my-army", "--yes", "--timeout", "1"], { healthy: false });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("https://my-army.fly.dev did not answer within 1 minutes");
    expect(result.stdout).toContain("fly logs --app my-army");
    expect(result.stdout).toContain("Deployed, but not answering yet");
    expect(result.stdout).toContain(`Setup token:  ${SECRETS.setupToken}`);
  });

  it("stops before creating anything when the answer is no", async () => {
    const result = await run([], { interactive: true, answers: ["1", "my-army", "", "n"] });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Plan: Fly.io");
    expect(result.stdout).toContain("Stopped: nothing was created.");
    expect(mutating(result.calls)).toEqual([]);
    expect(result.files.size).toBe(0);
  });

  it("waits for /healthz to say ok", async () => {
    let t = 0;
    const replies = [new Error("ECONNREFUSED"), { ok: false, text: async () => "" }, { ok: true, text: async () => "ok\n" }];
    const urls: string[] = [];
    const ok = await waitForHealthy("https://army.example.com/", {
      timeoutMs: 60_000,
      now: () => (t += 1_000),
      sleep: async () => {},
      fetch: async (url) => {
        urls.push(url);
        const reply = replies.shift();
        if (reply instanceof Error) throw reply;
        return reply ?? { ok: false, text: async () => "" };
      },
    });
    expect(ok).toBe(true);
    expect(urls).toEqual(Array(3).fill("https://army.example.com/healthz"));

    let clock = 0;
    const late = await waitForHealthy("https://army.example.com", {
      timeoutMs: 60_000,
      now: () => (clock += 20_000),
      sleep: async () => {},
      fetch: async () => ({ ok: true, text: async () => "starting" }),
    });
    expect(late).toBe(false);
  });
});
