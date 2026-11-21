# create-agent-army

Deploy [Agent Army](https://github.com/Genpire/agent-army) (Pointer and its team of Claude agents) with one command:

```bash
npm create agent-army@latest
```

It finds the provider CLIs you are already logged in to, asks once where to deploy, and deploys the prebuilt public image `ghcr.io/genpire/agent-army:latest`. Nothing is cloned or built on your computer. At the end it prints the address and the one-time setup token.

Requirements: Node.js 20 or newer, plus the CLI of the provider you pick (see below). There are no other dependencies. It runs on macOS and Linux; on Windows, run it in WSL.

## What it does

1. **Detects** which CLIs are installed and logged in: `fly`, `railway`, `render`, `gcloud`, `docker` and `ssh`. It lists what it found and asks once, with the best choice as the default.
2. **Generates the keys on your computer:** `MASTER_KEY` (32 random bytes, base64) and `SETUP_TOKEN` (18 random bytes, hex).
3. **Deploys** with the provider's own CLI. The keys go to the provider on stdin, in the environment or as provider secrets. They are never shown on the screen, and they never appear on a command line it prints.
4. **Saves `agent-army-<name>.env`** in the current folder, with mode 600. The file holds `MASTER_KEY`, which decrypts everything the deployment stores. Keep the file safe, and put a copy in a password manager. Without the key the data can't be read back.
5. **Waits** for `https://<address>/healthz`, then prints the address, the setup token and the next steps:
   - open the address and paste the token;
   - connect Claude;
   - connect Slack and GitHub.

If a step fails, it lists everything it created so far, with the command that removes each one.

## Options

```text
npm create agent-army@latest [name] -- [options]
npx create-agent-army [name] [options]
```

| Option | Meaning |
| --- | --- |
| `-p, --provider <id>` | `fly`, `railway`, `render`, `gcloud`, `docker` or `vm` |
| `-n, --name <name>` | App, project or container name: 3 to 40 characters from a-z, 0-9 and `-`. Default `agent-army-<4 hex>` |
| `-r, --region <id>` | Fly.io region (default `iad`) or Cloud Run region (default `us-central1`) |
| `--org <name>` | Fly.io organization or Railway workspace |
| `--project <id>` | Google Cloud project (default: gcloud's current project) |
| `--host <target>` | `vm`: the ssh target, e.g. `root@203.0.113.7` |
| `--domain <name>` | `vm`: a domain whose DNS A record points at the server |
| `--image <ref>` | The image to deploy (default `ghcr.io/genpire/agent-army:latest`) |
| `--port <n>` | `docker`: the local port (default 8080) |
| `--timeout <min>` | Minutes to wait for `/healthz` (default 15) |
| `-y, --yes` | Never ask: use the flags and the defaults |
| `--dry-run` | Print every command that would create or change something, and run none of them |
| `--no-open` | Don't open a browser (Render, Cloud Shell) |

With npm, put `--` before the options: `npm create agent-army@latest -- --provider fly`.

Without a terminal, or with `--yes`, it never asks a question. It uses the best provider it detected, or the one given with `--provider`.

```bash
# Fly.io, no questions
npm create agent-army@latest -- --provider fly --name my-army --region iad --yes

# Your own server
npx create-agent-army --provider vm --host root@203.0.113.7 --domain army.example.com

# See exactly what it would run
npx create-agent-army --provider railway --name my-army --dry-run
```

`--dry-run` still runs the read-only checks (which CLIs are installed and logged in). It prints every other command with the keys replaced by `<MASTER_KEY>` and `<SETUP_TOKEN>`, and writes no file. It works even when the provider's CLI is missing.

## Providers

The prices are monthly estimates for an always-on deployment.

### Fly.io: `--provider fly`

- **Needs:** [flyctl](https://fly.io/docs/flyctl/install/), logged in with `fly auth login`.
- **Runs:**
  - `fly apps create`;
  - `fly volumes create` (20 GB at `/data`);
  - `fly secrets set --stage` (MASTER_KEY, SETUP_TOKEN);
  - `fly deploy`, with a generated `agent-army-<name>.fly.toml`.
- **The fly.toml:**
  - the prebuilt image;
  - one shared-cpu-4x Machine with 8 GB, always on;
  - `/healthz` checks;
  - the volume at `/data`, with `WORK_DIR=/data` for task checkouts;
  - `PUBLIC_URL=https://<name>.fly.dev`.
- **Cost:** about $54 a month.
- **Address:** `https://<name>.fly.dev`. Fly.io app names are global, so pick a name nobody else has taken.
- **Update:** `fly deploy --app <name> --config agent-army-<name>.fly.toml`.
- **Remove:** `fly apps destroy <name>`.

### Railway: `--provider railway`

- **Needs:** the [Railway CLI](https://docs.railway.com/cli#installing-the-cli) (v5), logged in with `railway login`, and the Hobby plan or above.
- **Runs:**
  - `railway init`, in a new empty folder, so the folder you are in stays linked to its own project;
  - `railway add --service agent-army`;
  - `railway volume add --mount-path /data`;
  - `railway domain --port 8080`;
  - `railway variable set` (the keys on stdin);
  - `railway service source connect --image`, which deploys.
- **Variables:**
  - `STORAGE=fs`, `DATA_DIR=/data`, `RUNNER=local`;
  - `REQUIRE_MASTER_KEY=1`, `BROWSER=on`, `PORT=8080`;
  - `RAILWAY_RUN_UID=0`, because the volume is mounted as root;
  - `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`;
  - `PUBLIC_URL` from the generated domain.
- **Two settings the CLI can't set yet:** in the dashboard, open the service, then Settings > Deploy:
  - set the Healthcheck Path to `/healthz`;
  - set the Restart Policy to Always.
- **Cost:** about $10 to $30 a month, billed on usage.
- **Remove:** `railway delete --project <name>`.

### Render: `--provider render`

- **Needs:** a browser. The Render CLI can't create a service from a Blueprint, and Blueprints can't be created through the API.
- **What it does:** opens "Deploy to Render" for the repository's `render.yaml` and prints what to fill in:
  - the Blueprint name and the plan;
  - where to copy `SETUP_TOKEN` and `MASTER_KEY` from, since Render generates both.
- **Waiting:** paste the address when Render shows the service as Live, and it waits for `/healthz`.
- **Cost:**
  - 2c-8g: about $135 a month, 3 tasks at once;
  - 2c-4g: about $85 a month, 1 task at once.
- **Keys file:** none, because Render keeps the keys.

### Google Cloud Run: `--provider gcloud`

- **In a clone of the repository:**
  - **Needs:** [gcloud](https://cloud.google.com/sdk/docs/install), logged in with `gcloud auth login`, and a project with billing.
  - **Runs:**
    1. Stores the generated keys as the Secret Manager secrets `<name>-master-key` and `<name>-setup-token`. Secrets that already exist are kept, and `deploy/gcp.sh` keeps them too.
    2. Runs `deploy/gcp.sh` with `MIN_INSTANCES=1 SERVICE_CPU=1 SERVICE_MEMORY=2Gi`. Values already in your environment win.
  - **Cost:** about $53 a month, plus each task's job time.
- **Anywhere else:** it opens the repository in Google Cloud Shell and prints the commands to run there.

### Docker on this computer: `--provider docker`

- **Needs:** Docker, with the daemon running.
- **Runs:**
  - `docker pull`;
  - `docker volume create <name>-data`;
  - `docker run`, published on `127.0.0.1:<port>` only, so only this computer can reach it.
- **The keys:** passed as `--env MASTER_KEY --env SETUP_TOKEN`, so their values come from the environment and not the command line.
- **Address:** `http://localhost:8080`.
- **Slack:** needs a public HTTPS address, so put a tunnel in front, or deploy to a cloud provider.

### Your own Linux server: `--provider vm`

- **Needs:**
  - an Ubuntu or Debian server with 8 GB of RAM or more;
  - ports 80 and 443 open;
  - a domain whose A record points at the server;
  - ssh access as root, or as a user with passwordless sudo.
- **Runs:** the repository's `deploy/install.sh` over ssh, which sets up Docker, the app and Caddy with automatic HTTPS:

  ```bash
  ssh <host> sh -s   # script on stdin
  ```

  The script it sends sets `MASTER_KEY` and `SETUP_TOKEN` and downloads `install.sh`. It then runs it with `DOMAIN=<domain> NONINTERACTIVE=1`, because install.sh takes its options as environment variables.
- **Where the keys are:** on stdin, never on a command line, here or on the server. The server keeps them in `/opt/agent-army/.env`, with mode 600.
- **Cost:** from about €9 a month.
- **No domain?** Run install.sh on the server itself. It can use the server's IP address, which is experimental.

## If something goes wrong

- **A CLI is missing:** the error says where to install it and how to log in.
- **A CLI isn't logged in:** the error gives the exact login command.
- **The image can't be pulled:** `ghcr.io/genpire/agent-army` must be public. In a fork, make your own package public after its first release run, or pass `--image`.
- **`agent-army-<name>.env` already exists:** it may hold an earlier deployment's key, so the tool never overwrites it. Pick another `--name`, or move the file away first.
- **`/healthz` doesn't answer in time:** the deployment may still be starting. The tool prints where to look (logs, firewall, DNS) and exits with code 1.

## Development

The package lives in the Agent Army monorepo at `packages/create-agent-army`. It is plain JavaScript (ESM), type-checked with JSDoc, and has no dependencies.

```bash
node packages/create-agent-army/bin/create-agent-army.js --dry-run   # run it from a clone
npx tsc -p packages/create-agent-army/tsconfig.json                  # type-check
npx vitest run test/create-agent-army                                 # tests (stubbed CLIs, no network)
```

To publish, push a tag `create-agent-army-v<version>` that matches the `version` in `package.json`. The workflow `.github/workflows/publish-create-agent-army.yml` publishes the package with npm provenance once the repository has an `NPM_TOKEN` secret.

## License

MIT
