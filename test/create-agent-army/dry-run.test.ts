import { describe, expect, it } from "vitest";
import { CLONE_FILES, READ_ONLY, loggedIn, nothingInstalled, run } from "./helpers.js";

describe("create-agent-army: --dry-run", () => {
  it("fly", async () => {
    const result = await run(["--provider", "fly", "--name", "my-army", "--region", "iad", "--org", "my-org", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual([
      "fly apps create my-army --org my-org",
      "fly volumes create agent_army_data --app my-army --region iad --size 20 --yes",
      "fly secrets set --app my-army --stage MASTER_KEY=<MASTER_KEY> SETUP_TOKEN=<SETUP_TOKEN>",
      "fly deploy --app my-army --config agent-army-my-army.fly.toml --ha=false --wait-timeout 15m",
    ]);
    expect(result.stdout).toContain("# write ./agent-army-my-army.env (mode 600)");
    expect(result.stdout).toContain('# then wait until https://my-army.fly.dev/healthz answers "ok"');
    expect(result.stdout).toContain("Dry run finished: nothing was created");
    expect(result.calls.every((c) => READ_ONLY.test(c.line))).toBe(true);
    expect(result.files.size).toBe(0);
  });

  it("railway", async () => {
    const result = await run(["--provider", "railway", "--name", "my-army", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual([
      "railway init --name my-army --workspace ws-1 --json",
      "railway add --service agent-army --json",
      "railway volume add --service agent-army --mount-path /data --json",
      "railway domain --service agent-army --port 8080 --json",
      "railway variable set STORAGE=fs DATA_DIR=/data RUNNER=local REQUIRE_MASTER_KEY=1 BROWSER=on PORT=8080 RAILWAY_RUN_UID=0 " +
        "RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30 'PUBLIC_URL=https://<generated>.up.railway.app' --service agent-army --skip-deploys",
      "railway variable set MASTER_KEY --stdin --service agent-army --skip-deploys  # value on stdin",
      "railway variable set SETUP_TOKEN --stdin --service agent-army --skip-deploys  # value on stdin",
      "railway service source connect --image ghcr.io/genpire/agent-army:latest --service agent-army --json",
    ]);
    expect(result.calls.every((c) => READ_ONLY.test(c.line))).toBe(true);
  });

  it("render", async () => {
    const result = await run(["--provider", "render", "--name", "my-army", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual(["xdg-open 'https://render.com/deploy?repo=https://github.com/Genpire/agent-army'"]);
    expect(result.stdout).toContain("Blueprint Name: my-army");
    expect(result.stdout).toContain("Environment: copy SETUP_TOKEN");
    expect(result.opened).toEqual([]); // printed, not opened
  });

  it("gcloud in a clone", async () => {
    const result = await run(["--provider", "gcloud", "--name", "my-army", "--project", "example-project", "--dry-run"], {
      cwd: "/repo",
      files: CLONE_FILES,
    });
    expect(result.code).toBe(0);
    expect(result.commands).toEqual([
      "gcloud services enable secretmanager.googleapis.com --project example-project --quiet",
      "gcloud secrets create my-army-master-key --replication-policy automatic --data-file=- --project example-project --quiet  # MASTER_KEY on stdin",
      "gcloud secrets create my-army-setup-token --replication-policy automatic --data-file=- --project example-project --quiet  # SETUP_TOKEN on stdin",
      "PROJECT=example-project REGION=us-central1 NAME=my-army MIN_INSTANCES=1 SERVICE_CPU=1 SERVICE_MEMORY=2Gi bash deploy/gcp.sh",
      "gcloud run services describe my-army --region us-central1 --project example-project --format 'value(status.url)'",
    ]);
    expect(result.calls.every((c) => READ_ONLY.test(c.line))).toBe(true);
  });

  it("gcloud outside a clone: the Cloud Shell button", async () => {
    const result = await run(["--provider", "gcloud", "--name", "my-army", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual([
      "xdg-open 'https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=https%3A%2F%2Fgithub.com%2FGenpire%2Fagent-army&cloudshell_git_branch=main&cloudshell_tutorial=deploy%2Fgcp-tutorial.md&show=terminal'",
    ]);
    expect(result.stdout).toContain("PROJECT=<your-project-id> REGION=us-central1 NAME=my-army MIN_INSTANCES=1");
  });

  it("docker", async () => {
    const result = await run(["--provider", "docker", "--name", "my-army", "--port", "9090", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual([
      "docker pull ghcr.io/genpire/agent-army:latest",
      "docker volume create my-army-data",
      "docker run --detach --name my-army --restart unless-stopped --init --shm-size 1g --publish 127.0.0.1:9090:8080 " +
        "--volume my-army-data:/data --env MASTER_KEY --env SETUP_TOKEN --env REQUIRE_MASTER_KEY=1 --env STORAGE=fs " +
        "--env DATA_DIR=/data --env RUNNER=local ghcr.io/genpire/agent-army:latest  # MASTER_KEY and SETUP_TOKEN come from the environment",
    ]);
    expect(result.stdout).toContain('# then wait until http://localhost:9090/healthz answers "ok"');
  });

  it("vm", async () => {
    const result = await run(["--provider", "vm", "--name", "my-army", "--host", "ubuntu@203.0.113.7", "--domain", "army.example.com", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.commands).toEqual(["ssh -o ConnectTimeout=20 ubuntu@203.0.113.7 sh -s  # this script on stdin:"]);
    expect(result.stdout).toContain(
      [
        "    set -e",
        "    MASTER_KEY=<MASTER_KEY>",
        "    SETUP_TOKEN=<SETUP_TOKEN>",
        "    export MASTER_KEY SETUP_TOKEN",
        '    installer="$(curl -fsSL https://raw.githubusercontent.com/Genpire/agent-army/main/deploy/install.sh)"',
        `    printf '%s\\n' "$installer" | DOMAIN=army.example.com AGENT_ARMY_IMAGE=ghcr.io/genpire/agent-army:latest NONINTERACTIVE=1 sh`,
      ].join("\n"),
    );
  });

  it("works with nothing installed: warns, then prints the commands anyway", async () => {
    const result = await run(["--provider", "fly", "--name", "my-army", "--dry-run"], { handler: nothingInstalled });
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("Fly.io needs the fly command, which is not installed. Install it: https://fly.io/docs/flyctl/install/");
    expect(result.commands[0]).toBe("fly apps create my-army");
  });

  it("the same flags without --dry-run run exactly the printed commands", async () => {
    const flags = ["--provider", "railway", "--name", "my-army", "--yes"];
    const dry = await run([...flags, "--dry-run"]);
    const real = await run(flags, { handler: loggedIn });
    expect(real.code).toBe(0);
    const ran = real.calls.filter((c) => !READ_ONLY.test(c.line));
    expect(ran).toHaveLength(dry.commands.length);
    const plain = (c: string) => c.replace("my-army-production", "<generated>").replace(/'/g, "");
    expect(real.commands.map(plain)).toEqual(dry.commands.map(plain));
  });
});
