# The Railway template (for maintainers)

The **Deploy on Railway** button in the README opens a template, and a Railway
template lives in Railway, not in a file in this repo. Railway's Config as Code
files (`railway.json`, `railway.toml`) are deprecated: new services cannot opt
in, and they stop being read on 2026-12-01. So there is no `railway.json` here:
a maintainer creates the template once, in Railway's template composer, as
below. A fork that wants its own button does the same in its own workspace.

What a user gets: one always-on service running the prebuilt image, a 5 GB
volume at `/data`, a `*.up.railway.app` HTTPS address, and generated keys. No
build, so the first deploy takes a few minutes. Railway bills by usage: the
Hobby plan is $5 a month including $5 of usage, about $10 to $30 a month in all.

## Before you start

- **The image must be public.** `ghcr.io/genpire/agent-army` starts private like
  every new GitHub package: on GitHub, the package → **Package settings** →
  **Change visibility** → **Public**. A private image needs Railway's Pro plan,
  or registry credentials hidden in the template, which lock its source.
- **The image must have the entrypoint** (`deploy/docker-entrypoint.sh`, set as
  the Dockerfile's `ENTRYPOINT`). Railway mounts volumes as root, so the
  template starts the container as root (`RAILWAY_RUN_UID=0`); the entrypoint
  gives `/data` to the image's `node` user and runs the server as `node`.
  Without it, the server and the agents' commands would run as root: don't
  publish the template on an image that lacks it.
- **A Hobby or Pro workspace.** Trial (1 GB of RAM, 4 GB image limit) and Free
  (always sleeps) cannot run Agent Army.

## 1. Start a template

In Railway: your workspace → **Templates** → **New Template**.

## 2. Add the service

**Add service** → **Docker Image** → `ghcr.io/genpire/agent-army:latest`.
Name the service `agent-army`.

The alternative, **GitHub Repo** `https://github.com/Genpire/agent-army`, builds
the Dockerfile on every deploy (15 to 25 minutes) and always deploys this repo's
`main`. Prefer the image.

## 3. Variables

Add these on the service, each with its description (Railway shows them to the
person deploying). Type the values exactly, including `${{ }}`: Railway fills
them in at deploy time.

| Variable | Value | Description |
| --- | --- | --- |
| `MASTER_KEY` | `${{secret(64, "abcdef0123456789")}}` | Encrypts the stored config and signs admin sessions. Generated once. Never change it, or the stored data can't be read. |
| `SETUP_TOKEN` | `${{secret(32)}}` | One-time token that creates the admin account (and resets its password). Copy it from here when you first open the app. |
| `REQUIRE_MASTER_KEY` | `1` | Refuse to start without MASTER_KEY. |
| `STORAGE` | `fs` | Keep the data on the volume. |
| `DATA_DIR` | `/data` | The volume's mount path. |
| `RUNNER` | `local` | Repo tasks run as child processes of the server. |
| `BROWSER` | `on` | Headless Chromium for browser checks. `off` disables it. |
| `PORT` | `8080` | The port the server listens on. |
| `PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | The public address, for Slack events and sign-in callbacks. Change it if you add a custom domain. |
| `RAILWAY_RUN_UID` | `0` | The volume is mounted as root: start as root so the entrypoint can give /data to the node user. The server runs as node. |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` | Time to stop cleanly on a redeploy (Railway's default is 0). Running repo tasks still stop. |

Only with the GitHub Repo source, also add `ENGINES` = `codex gemini`. It is a
build argument: `codex`, `gemini` or empty gives a smaller image and a faster
build.

## 4. Settings

On the service's **Settings**:

- **Networking → Public Networking:** HTTP, target port `8080`. This generates
  the `*.up.railway.app` domain that `PUBLIC_URL` refers to.
- **Deploy → Healthcheck Path:** `/healthz`. Railway checks it during deploys only.
- **Deploy → Restart Policy:** Always.
- **Deploy → Serverless:** off. Pointer keeps working after Slack gets its
  reply, and repo tasks run for hours.
- **Replicas:** 1, the default. Per-thread queues and event dedupe live in
  memory, and a volume can't be shared by replicas anyway.

## 5. Volume

Right-click the service → **Attach Volume**, mount path `/data`. Hobby
volumes are 5 GB.

## 6. Create the template

**Create Template**. Railway shows the template's page, at
`https://railway.com/deploy/<CODE>`. Publishing it to Railway's marketplace is
optional.

## 7. Put the code in the README

In `README.md`, under **Deploy anywhere**, replace `TEMPLATE_CODE` in the
Deploy on Railway button's link with the code, and remove the note that says
the template isn't published yet.

## 8. Try it

From the button, in a workspace that has never run Agent Army:

1. Deploy, and wait until the deployment is **Active**.
2. Open the service's domain. On the service's **Variables** tab, copy
   `SETUP_TOKEN` and create the admin account with it.
3. Check that the server runs as `node`, not root: `railway ssh` into the
   service, then `grep Uid /proc/1/status` shows `1000`.
4. Redeploy the service, and check that you can still sign in (the volume and
   the key survived).

## Updating

A deployment from the image does not change when `latest` moves: its owner
redeploys the service. When you test the template, check that a redeploy pulls
the newest `latest`.

## Forks

Services deployed from a template deploy the template's source, so the upstream
button always runs the upstream image. A fork that ships its own code:

1. Lets its release workflow publish `ghcr.io/<owner>/agent-army`, then makes
   that package public.
2. Creates its own template as above, with its own image.
3. Puts its own code in its README's button.
