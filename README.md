# Agent Army

[![CI](https://github.com/Genpire/agent-army/actions/workflows/ci.yml/badge.svg)](https://github.com/Genpire/agent-army/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A self-hosted Slack assistant, **Pointer**, with a team of Claude agents that answer questions, research, read your code and turn requests into pull requests. One container, deployable anywhere, configured entirely from its own web page.

- **Pointer:** talk to it in a DM, in channels you mark as Pointer channels, or in any thread it is part of. It answers questions, researches the web, reads GitHub and the files you share (designs, code, screenshots, PDFs, zips), remembers facts you give it, opens and updates monday.com tickets (optional), and hands work to its team. Built on the Claude Agent SDK.
- **The team:** agents you list, name, edit and create on the admin page, for any role: engineering (Coder, Reviewer, QA) or not (Researcher, Writer). Pointer picks the agent whose description fits the job.
- **Code changes:** any change to a repo runs as a task in its own isolated worker: clone, Pointer and the team work on a branch, then the platform opens a pull request. Each agent learns the project from the repo itself (CLAUDE.md, README, scripts, CI) and from the team's **project notes**, which every task reads at the start and updates at the end.
- **Standalone:** deploy the container, open the URL, and the onboarding page walks you through connecting Claude, Slack and GitHub. Nothing is hard-coded to one company; to use it elsewhere, deploy it again there.
- **Humans stay in charge:** agents only ever open pull requests. They cannot push to protected branches or merge.

```
Slack (DM, Pointer channel, thread, @mention)
   │
   ▼
web service: Pointer ─── web search · GitHub (read) · memory · project notes · monday.com · team agents
   │ code change? start a repo task
   ▼
one isolated worker per task
   ├─ clone repo, new branch
   ├─ read project notes, Pointer ⇄ the team (Coder, Reviewer, QA, …)
   └─ push branch, open PR, update project notes, report in thread
```

## Quick start

You need Docker (or Node.js 22+), an [Anthropic API key](https://console.anthropic.com), and a Slack workspace where you can install apps. A GitHub token is optional: without one, Pointer still chats and researches.

```bash
git clone https://github.com/Genpire/agent-army.git
cd agent-army
cp .env.example .env                 # set MASTER_KEY=$(openssl rand -base64 32)
docker compose up -d --build
docker compose logs agent-army | grep setup   # the one-time setup token
```

Open http://localhost:8080, paste the setup token, and follow the [onboarding](#onboarding-in-the-web-page) steps. Slack must reach `/slack/events` over public HTTPS: for a quick try, run a tunnel such as `cloudflared tunnel --url http://localhost:8080`, set `PUBLIC_URL` in `.env` to its URL and restart. For a lasting setup, [deploy to Cloud Run](#google-cloud-run) or behind your own TLS proxy.

## Deploy

### Google Cloud Run

```bash
PROJECT=your-gcp-project REGION=us-central1 ./deploy/gcp.sh
```

The script prints the URL and a one-time **setup token**. It creates a private bucket (encrypted config, memory, project notes and task records), two secrets, two least-privilege service accounts, the web service, and a Cloud Run Job that runs one container per task. Re-run it to update.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PROJECT` | your gcloud default | GCP project. |
| `REGION` | `us-central1` | Region for every resource. |
| `NAME` | `agent-army` | Resource name prefix; the job is `<NAME>-worker`. |
| `MIN_INSTANCES` | `0` | `1` keeps the web service warm. |

The web service runs with 8 vCPU, 8 GiB (`SERVICE_CPU` / `SERVICE_MEMORY`) and **CPU always allocated** (Pointer keeps working after Slack has its HTTP 200, and the Agent SDK runs as a subprocess), as a **single instance** (per-thread queues and event dedupe live in memory). With the default `MIN_INSTANCES=0` it scales to zero when idle and the first message afterwards waits for a cold start. At this size an instance costs roughly $0.58 per hour while it is up (it stays up about 15 minutes after the last request), so `MIN_INSTANCES=1` would cost roughly $420 a month; lower `SERVICE_CPU` / `SERVICE_MEMORY` (e.g. 1 and 2Gi, about $55 a month warm) if you keep one warm. Claude usage is billed separately, capped per message and per task (see below). The worker job runs each task with 8 vCPU and 8 GiB (`JOB_CPU` / `JOB_MEMORY`), billed only while a task runs.

**Smoke test.** Once Claude is connected, check the deployment without Slack. This runs Pointer once inside the worker job, with the real config, team and memory. Repo tasks are disabled and nothing is posted to Slack.

```bash
gcloud run jobs execute agent-army-worker --region REGION \
  --args=dist/smoke.js,"what is the last commit on owner/repo" --wait
```

The execution fails when Pointer returns an error. To read the reply, take the execution name the command prints (or find it with `gcloud run jobs executions list --job agent-army-worker --region REGION`):

```bash
gcloud logging read 'resource.type="cloud_run_job" AND resource.labels.job_name="agent-army-worker" AND labels."run.googleapis.com/execution_name"="EXECUTION_NAME"' \
  --freshness 1h --order asc --format 'value(textPayload)'
```

The output is `--- reply ---`, the answer, then `--- cost: $… · error: …`. Logs can take a few seconds to appear. For a question that contains a comma, use gcloud's alternate delimiter: `--args='^;^dist/smoke.js;what changed, and why'`.

### Anywhere else (VM, laptop, Kubernetes)

```bash
cp .env.example .env          # set MASTER_KEY=$(openssl rand -base64 32)
docker compose up -d --build  # then open http://localhost:8080
```

Workers run as child processes of the server (`RUNNER=local`). Slack needs to reach `/slack/events` over public HTTPS, so put a TLS proxy or tunnel in front. If `SETUP_TOKEN` is unset, the token is printed in the container log. Smoke test: `docker compose exec agent-army node dist/smoke.js "introduce yourself"`.

## Onboarding (in the web page)

1. **Admin account**: paste the setup token, choose a password.
2. **Claude**: an Anthropic API key. Use a dedicated key with a spend limit.
3. **Slack**: click *Create Slack app* (the manifest is pre-filled with this deployment's URL and Pointer's name), install it to your workspace, paste the Bot User OAuth Token and Signing Secret. Invite Pointer to the channels where you want it.
4. **GitHub**: a fine-grained personal access token, ideally on a dedicated bot account, limited to the repos the agents may touch, with *Contents: read/write*, *Pull requests: read/write*, *Metadata: read*. Optionally restrict it to owners or exact repos. For repos outside your organisation, add more tokens under *Other GitHub connections* (see [GitHub connections](#github-connections)). Without GitHub, Pointer still chats; GitHub questions and repo tasks say GitHub is not connected.
5. **monday.com** (optional): an API token so Pointer can open and update tickets, a default board and the boards it may use. See [monday.com](#mondaycom).
6. **Projects and rules** (optional): channel → default repo, Pointer channels, who may talk to Pointer, budget and turn limits per task.
7. **Team** (optional): rename Pointer, give it extra instructions, edit or add agents.

Every credential is verified before it is saved, stored encrypted (AES-256-GCM with `MASTER_KEY`), and never sent back to the browser.

## GitHub connections

Pointer can hold several GitHub tokens: the primary one on the **GitHub** card, plus up to 10 more under **Other GitHub connections** on the same card. Each has its own allow list.

- **Allow lists** are comma separated, and each entry is an owner (`your-org`: every repo of that organisation or user) or an exact repo (`someone/some-repo`). Empty means any repository the token can reach.
- **Which token is used:** for a repo, the most specific match wins: an exact repo entry, then an owner entry, then a connection with an empty allow list. A repo that no connection allows is refused, for GitHub reads and repo tasks alike.
- **When to add one:** for a repository outside your organisation, for example a private repo on someone's personal account. GitHub's fine-grained tokens only cover one owner, so a token made for your organisation cannot reach it. Add a token that can: a fine-grained token created by the repo's owner (same permissions as above, limited to that repo), or a classic token with the `repo` scope. Then limit the connection to the exact repo (`someone/some-repo`); a classic token reaches everything its user can, so the allow list is what keeps Pointer to that one repo.
- **Checks:** a new token is verified with GitHub, and each exact repo in its allow list must be reachable with it ("This token cannot reach someone/some-repo." otherwise). Editing a connection's allow list checks its exact repos the same way. Owner entries are not checked.
- The page shows each connection's GitHub user, the last four characters of its token and its allow list, which you can edit in place. Removing one takes two clicks.

## Using it from Slack

### Where Pointer answers

| Where | When it answers | Where the reply goes |
| --- | --- | --- |
| A DM with Pointer | Every message | Inline (no thread) |
| A Pointer channel | Every message | In a thread |
| A thread Pointer has posted in | Every reply | In the thread |
| Any other channel it is in | Only when @mentioned | In a thread |

Pointer reacts with :eyes: while it works, then :white_check_mark: or :x:. Messages in the same thread are handled in order. If you restrict who may talk to Pointer, others are ignored; if they @mention it, they get one "not allowed" reply.

### What it can do

| You say | What happens |
| --- | --- |
| `what's new in the latest Node.js release?` | Searches and reads the web, cites sources |
| `what changed in owner/repo this week?` | Reads commits, pull requests and issues on GitHub |
| `where is PDF export implemented in owner/repo?` | Searches and reads the code on GitHub, changes nothing |
| `remember that staging deploys go through owner/infra` | Saves a fact to memory |
| `remember for owner/repo that e2e tests need Docker` | Adds a line to that repo's project notes |
| `open a ticket for the login bug on the Bugs board` | Creates a monday.com item with the details from the conversation (monday.com connected) |
| `move ticket 1234567890 to Done and note the fix is in PR #42` | Updates the item's columns and adds a comment |
| share `Chat Section.html`, `Mobile-html.zip` and a screenshot: `what's off in the mobile layout?` | Reads the files and answers (see [Files you share](#files-you-share)) |
| `who's on the team?` | Describes the agents |
| `fix the flaky checkout test` | Starts a repo task on this channel's default project |
| `in owner/repo: add rate limiting to /api/login` | Starts a repo task on that project |
| reply in the task's thread: `also cover the empty case` | Continues on the same branch and PR |

Pointer hands a question to a team agent when the agent's description fits (in conversation, agents can only search the web and read GitHub). For any code change, Pointer starts a repo task: on the repo you name, else the one this thread already works on, else the channel's default; when there is none, it asks.

### Files you share

Pointer reads the files shared in the conversation it is answering: the new message's files and those earlier in the thread (in a DM, those in your last 15 messages). It reads HTML, code and other text files, images (PNG, JPEG, GIF, WebP), PDFs, and zips (expanded one level, macOS metadata skipped). Sharing files without a message is enough wherever Pointer answers without a mention (DMs, Pointer channels, threads it is in); elsewhere, mention it.

| Limit | Value |
| --- | --- |
| Size of one file | 20 MB |
| Files per thread | 40 |
| New files read per message | 10 (the rest are read with the next message) |
| A zip | 300 files, 60 MB unpacked |
| Text read per prompt | 60 000 characters per file, 250 000 in total |
| Images per prompt | 12, up to 5 MB each |
| One PDF | 15 MB |

What goes over the per-prompt limits is listed to Pointer by name instead. When Pointer cannot download a file (too large, or the app lacks the `files:read` scope), it still answers and says which files it could not read.

Files are stored per thread, encrypted with `MASTER_KEY` like memory and notes (`attachments/<channel>-<thread>/`), and repo tasks started from that thread hand them to the team. Pointer never logs file contents. Apps created before this feature need the `files:read` scope: see [Updating an existing Slack app](#updating-an-existing-slack-app).

### Commands

These work with or without a mention wherever Pointer is listening.

| You type | What happens |
| --- | --- |
| `help` or `?` | How to use Pointer |
| `status` | This channel's project, whether it is a Pointer channel, the runner, recent tasks |
| `bind owner/repo` / `unbind` | Set or clear this channel's default project |
| `listen here` / `stop listening` | Make this channel a Pointer channel, or stop (also `listen` / `unlisten`). Invite Pointer first: `/invite @Pointer` |

### Repo tasks

The worker clones the repo, creates a branch (`army/…`) and runs Pointer with the team. Pointer plans with acceptance criteria, hands the change to an agent with *Change code* access, then has another fitting agent review or test it, for up to three rounds. If a role is missing it skips the step and says so; if no *Change code* agent is enabled and the request needs code, the task comes back blocked.

Pointer edits one message in the thread as the team works, then posts the summary, verification results, risks and the pull request link. A task started from a DM gets its own thread on your message, where progress and follow-ups live.

**Progress while the team works.** The progress message is a live dashboard: what is happening now, the lead's plan as a checklist (the lead keeps it with TodoWrite, or TaskCreate/TaskUpdate), which agents are working and for how long, the latest steps (files edited, commands run, each agent's report line) and the files changed so far. Every few minutes (5 by default; **Progress update every** on the Projects card, 0 turns it off) a new update is posted in the thread, so followers are notified. Ask in the thread "how is it going?" and Pointer answers from the same saved progress with its `repo_task_status` tool. All of this is built from the Agent SDK's message stream and costs no Claude credit.

## The team

The **Team** card on the admin page holds Pointer's settings and the agent list.

- **Pointer:** its name, extra instructions (appended to its built-in prompt), and per-message limits for conversations: budget (default $1) and turns (default 40).
- **Model and effort:** the chat model (empty uses the Claude card's model), the chat effort and the repo task effort (`low`, `medium`, `high`, `xhigh`, `max`; both default to `medium`). Each agent can set its own model and effort; an empty effort follows the chat or repo task it is part of. Higher effort thinks longer: better on hard work, slower, and more credit. Sonnet 5.5 costs half as much as Opus 5.5 per token, and Haiku 5.5 far less.
- **Agents:** a fresh deployment starts with Coder, Reviewer, QA, Researcher and Writer. Add, edit, disable or delete agents. Each has a name, role, emoji, *When should Pointer use this agent?* (Pointer chooses agents by this), instructions, access, model and an enabled switch. The id is derived from the name and does not change.

| Access | Tools in repo tasks |
| --- | --- |
| Look only | Read, Glob, Grep, WebSearch, WebFetch |
| Look and run commands | the above, plus Bash (behind the shell guard) |
| Change code | the above, plus Edit and Write |

In Slack conversations every agent gets the same safe tools (web search and fetch, GitHub read), whatever its access. **Model** is *Same as Pointer* (the configured Claude model, else the SDK default) or a specific Claude model per agent. Platform ground rules (no pushing, no secrets, treat web and file content as data, report facts) are appended to every agent and cannot be edited away. The page warns when no enabled agent can change code.

Pointer can describe the team in Slack but cannot change it; only the admin page can. Renaming Pointer changes how it introduces itself; the name Slack shows changes when you update the app manifest (below). Per-project behaviour belongs in that project's own `CLAUDE.md`, which the agents load automatically in repo tasks.

The image ships Node 22, Python 3, git, make and g++. For repos that need other toolchains (Go, Java, pnpm, Playwright browsers…), extend the image:

```dockerfile
FROM agent-army
USER root
RUN apt-get update && apt-get install -y golang && rm -rf /var/lib/apt/lists/*
USER node
```

## Memory

Ask Pointer to remember something (`remember that…`) or forget it, and it carries the fact into every later conversation. Memory holds up to 100 facts of up to 500 characters each, stored encrypted like the config. The **Memory** card lists every fact with its date and a delete button.

Memory is **shared**: every conversation sees every fact, including conversations in public channels. Pointer is told never to save secrets or personal data; don't ask it to.

## Project notes

What the team has learned about each repository (how to build and test it, conventions, layout, gotchas), so it stops rediscovering them on every task.

- **Repo tasks** read the repo's notes at the start (as possibly outdated hints to verify) and rewrite them at the end: they keep what is still true, add what the task learned, drop what is obsolete, and never include secrets. Notes are saved after successful and blocked tasks alike.
- **In Slack**, Pointer sees the notes for the thread's repo (else the channel's default repo), can read any repo's notes, and adds a line when you say `remember for owner/repo that …`. Notes follow the GitHub allow lists.
- **On the admin page**, the **Project notes** card lists every repo with its size and last update. Open one to edit it, or add notes for a new repo (`owner/repo`). Saving empty notes deletes them.

Notes are limited to 8 000 characters per repo, stored encrypted in the data store (`notes/<owner>__<repo>.enc`), and never written into the checkout, so they never end up in a pull request.

## monday.com

Optional. With monday.com connected, Pointer can work with tickets from Slack:

- list boards, read a board's groups and columns, search items, and find people to assign;
- create an item (named after the request, with the details from the conversation posted as its first update, signed with who asked in Slack);
- update an item's columns (status, owner, dates, …) and add comments.

It never deletes or archives anything. When a request names no board, Pointer uses the default board; with no default, it asks.

**Connect it** on the admin page's **monday.com** card:

1. In monday.com, click your avatar and choose **Developers**.
2. Open **My access tokens**, choose **Show** and copy the token.
3. Paste it into the card. It is verified with monday.com, stored encrypted and never shown again.

The token acts as the monday.com user who created it, with everything that user can see and change. Use a dedicated monday.com user (for example "Pointer bot") that is a member of only the boards Pointer should work on.

Once connected, the card offers:

- **Default board for tickets**, picked from your most recently used boards (search finds others).
- **Boards Pointer may use**: board ids, comma separated (the number in a board's URL, `…/boards/1234567890`). Empty means every board the token's user can see. When set, Pointer cannot read or change any other board, and the default board must be one of them.
- **Disconnect**, which forgets the token and keeps the board settings.

## Updating an existing Slack app

Apps created before Pointer only receive @mentions, and apps created before file support cannot download shared files. To let Pointer receive DMs and channel messages, add reactions and read files, update the app once:

1. On the admin page, open **Slack → Already created the app? Update it** and copy the manifest.
2. At [api.slack.com/apps](https://api.slack.com/apps), open your app → **App Manifest**, replace the JSON with the copy, **Save**.
3. **Install App → Reinstall** to grant the new scopes (`im:history`, `reactions:write`, `files:read`).

Until you do, @mentions still work, but DMs, Pointer channels and unmentioned thread replies are not received, reactions are skipped, and Pointer answers without the files, saying it is "missing files:read permission". Update it again whenever you rename Pointer.

## Security model

- **Isolation:** each repo task runs in its own container (Cloud Run Job) or process (local), in a throwaway checkout that is deleted afterwards.
- **Conversations are tool-restricted:** Pointer runs in the web service with only web search and fetch, its agents, and its own service-side tools (GitHub read, memory, project notes, monday.com when connected, start a repo task). It has no shell and cannot read or write files; anything not explicitly allowed is denied, no settings files are loaded, and each message gets a fresh temporary directory as its working directory and home (deleted afterwards) and a minimal environment whose only secret is the Anthropic key. The master key and the Slack, GitHub and monday.com tokens held by the service are out of its reach.
- **Pull requests only:** the platform, not the agents, pushes the branch and opens the PR. Enable branch protection on your default branch so merging requires a human review.
- **Least privilege:** each GitHub token should cover only the repos you want worked on. Tokens are used only by the service-side tools and the worker. The GitHub allow lists (owners or exact repos, per connection) apply to GitHub reads and repo tasks, and the Slack user allowlist is checked before any model call.
- **Secrets:** in repo tasks the agents' shell gets a minimal environment (no master key, Slack or GitHub tokens), git credentials are passed per command and never written to `.git/config`, and a shell guard blocks pushing, credential changes and reading platform secrets. Memory, project notes, shared files and the monday.com token are stored encrypted with the master key. Message text and file contents are never logged. The Slack token is sent only to `https://files.slack.com` when downloading a file.
- **Limits:** per-message budget and turns for conversations (Team card), per-task budget, turn limit and timeout for repo tasks (Projects card). At most six answers are worked on at once; the rest wait their turn.

Known limits, stated plainly:

- **Prompt injection:** a web page, issue or file Pointer reads could try to steer it into saving a memory fact or project note, opening or editing a monday.com ticket, or starting a repo task. The damage is bounded: tasks only touch allowed owners and repos, stop at the per-task budget and end as a pull request a human must merge; memory and project notes are visible and editable on the page; monday.com changes are limited to the allowed boards, never delete anything and are recorded in the item's activity log.
- **Exfiltration through web fetch:** Pointer can read private data (private repos, monday.com items, memory, project notes) and fetch any URL. Injected content could try to make it send that data to an outside address. Subagents are read-only and the prompt treats fetched content as data, but there is no URL allowlist. Keep the GitHub tokens and monday.com token scoped to what Pointer needs.
- **The repo-task container is not a boundary for platform secrets.** The worker process holds the master key and its service account can read the bucket and the secret; the agents' shell runs as the same user. The shell guard blocks the obvious paths (`/proc/*/environ`, the metadata server), but a determined agent following injected instructions could get around it. Repo tasks can be started by Pointer from conversation, so treat the content Pointer reads (web pages, issues, repos) as part of the trust boundary, and give this deployment its own GCP project for anything sensitive.
- Memory is global (see above): do not use it for anything private.
- The agents' shell in repo tasks does hold the Anthropic API key (the SDK needs it) and runs code from the repo. Treat the repos you connect as trusted, and keep the key dedicated and capped. The shell guard is a seatbelt, not a sandbox boundary.
- People from other organisations in Slack Connect channels are ignored unless their user ID is on the allowlist.
- Agents have outbound network access (they need it to install dependencies and research).
- On Cloud Run, the checkout lives in memory-backed `/tmp`; the job is sized at 8 GiB. Raise `JOB_MEMORY` in `deploy/gcp.sh` (up to 32Gi) for very large repos.
- If a task hits its budget, turn limit or timeout, its partial work is not published.
- The web service is a single instance. During a redeploy two instances briefly overlap, so a message can very rarely be answered twice.
- For anything involving regulated data or SOC 2 scope, give the deployment its own GCP project and review the service-account grants in `deploy/gcp.sh`.

## Configuration reference

All optional; see `.env.example`. Pointer's team, memory, project notes, monday.com, Pointer channels and limits are set on the admin page, not here.

| Variable | Purpose |
| --- | --- |
| `MASTER_KEY` | Encrypts stored credentials and memory, signs admin sessions. Required when `REQUIRE_MASTER_KEY=1`. |
| `SETUP_TOKEN` | One-time token to create the admin account. |
| `PUBLIC_URL` | Public base URL (auto-detected behind most proxies). |
| `STORAGE` / `DATA_DIR` / `GCS_BUCKET` | `fs` or `gcs` storage for config, memory and task records. |
| `RUNNER` / `WORKER_JOB` | `local` or `cloudrun` worker execution. |
| `TASK_TIMEOUT_MIN` | Hard stop per repo task (default 50). |

### Admin API

The admin page is a client of this JSON API. Every route except `/api/state`, `/api/setup`, `/api/login` and `/api/logout` needs the admin session cookie (else `401`). Errors are `{ "error": "…" }` with status `400` (invalid input or a failed check), `403`, `404` or `409`. Secrets are accepted, never returned.

| Route | Body / query | Result |
| --- | --- | --- |
| `GET /api/state` | | Setup and sign-in state; when signed in, readiness and the config without secrets (`config.github.extra` lists the other GitHub connections as `{ id, login, allowed, key }` with a masked key; `config.monday` shows `connected`, `userName`, `accountName`, `defaultBoardId`, `allowedBoardIds`). |
| `POST /api/setup` | `{ setupToken, password }` | Creates the admin account and signs in. |
| `POST /api/login` / `POST /api/logout` | `{ password }` / none | Session cookie. |
| `POST /api/anthropic` | `{ apiKey, model? }` | Verifies and saves the Claude key. |
| `GET /api/slack/manifest` | `?name=` | `{ manifest, createUrl }` for this deployment. |
| `POST /api/slack` | `{ botToken, signingSecret }` | Verifies and saves Slack. |
| `POST /api/github` | `{ token, allowedOwners? }` | Verifies and saves the primary GitHub token. `allowedOwners` entries are owners (`your-org`) or exact repos (`owner/repo`), at most 50. Other connections are kept. |
| `POST /api/github/connections` | `{ token, allowed? }` | Verifies the token and that it can reach each exact repo in `allowed` (same entry rules), then adds it as another connection (at most 10). Returns `{ ok, id, login }`. |
| `POST /api/github/connections/update` | `{ id, allowed }` | Replaces a connection's allow list; its exact repos are checked with the connection's token. `404` if unknown. |
| `POST /api/github/connections/delete` | `{ id }` | Removes a connection (`404` if unknown). |
| `POST /api/monday` | `{ token?, defaultBoardId?, allowedBoardIds? }` | With `token`: verifies it and connects as its user. Board ids are digit strings (at most 100; `defaultBoardId: ""` clears the default, which must be among `allowedBoardIds` when those are set). Without a token, monday.com must already be connected. Returns `{ ok, userName?, accountName? }`. |
| `POST /api/monday/disconnect` | | Forgets the token and its user; keeps the board settings. |
| `GET /api/monday/boards` | `?search=` | `{ boards: [{ id, name, workspace? }] }`: up to 50 active boards, most recently used first, filtered by name. `400` when not connected or when monday.com fails. |
| `POST /api/settings` | `{ orgName?, allowedUserIds?, allowedOwners?, bindings?, pointerChannels?, limits? }` | Partial update; `limits` (`maxTurns`, `maxBudgetUsd`, `maxParallel`, `progressEveryMin` 0-60) merges field by field. `allowedOwners` is the primary GitHub token's allow list (owners or exact repos). |
| `POST /api/team` | `{ pointer, agents }` | Replaces the team. `pointer`: `{ name, instructions, budgetUsd, maxTurns, model?, effort?, taskEffort? }`; each agent: `{ id, name, role, emoji, description, instructions, access, model?, effort?, enabled }`. Effort is `low`, `medium`, `high`, `xhigh` or `max` (an agent's `""` follows the chat or task). |
| `GET /api/memory` | | `{ facts, max }` |
| `POST /api/memory/delete` | `{ id }` | Deletes one fact (`404` if unknown). |
| `GET /api/notes` | | `{ notes: [{ repo, updatedAt, chars }], max }`, newest first; `max` is 8 000. |
| `GET /api/notes/:owner/:repo` | | `{ repo, text, updatedAt }`, or `404` when the repo has no notes. |
| `POST /api/notes` | `{ repo, text }` | Replaces the repo's notes; empty text deletes them. `400` for a bad repo name or text over the limit. |
| `GET /api/tasks` | | `{ tasks }`: the 30 most recent repo tasks; a running task carries `progress` (`now`, `plan`, `agents`, `recent`, `files`, `filesCount`, `startedAt`, `updatedAt`). |
| `GET /api/usage` | | Claude spend this calendar month (UTC): `{ month, chat: { usd, count }, tasks: { usd, count }, totalUsd, topTasks: [{ id, repo, instruction, costUsd, createdAt }] }`. Chat is tallied from each reply's reported cost; tasks from their records. The Activity card and Slack's `status` show it. |

## Development

Requires Node.js 22 or newer (`nvm use`).

```bash
npm install
npm run dev        # server with reload on :8080
npm test           # unit, Slack flow and API tests
npm run typecheck
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for trying Pointer locally with and without Slack, the checks CI runs, and the code guidelines.

Layout:

- `src/server.ts`: admin API and Slack events.
- `src/listen.ts`: when Pointer answers, queues, dedupe.
- `src/dispatch.ts`: Slack event → command or Pointer.
- `src/targeting.ts`: commands and which project.
- `src/pointer.ts` + `src/pointer-tools.ts`: Pointer's brain and its tools (GitHub read, memory, project notes, monday.com, repo tasks).
- `src/team.ts`: team model, defaults and tool access.
- `src/memory.ts`: encrypted memory.
- `src/notes.ts`: encrypted project notes.
- `src/attachments.ts`: encrypted per-thread files and how Pointer reads them; `src/slack.ts` downloads them from Slack.
- `src/monday.ts`: monday.com client, token check and Pointer's monday.com tools.
- `src/runner.ts`: local / Cloud Run.
- `src/worker.ts`: clone → team → PR → report.
- `src/agents.ts`: the repo-task prompt and report.
- `src/guard.ts`: shell guard.
- `src/config.ts` + `src/store.ts`: encrypted config, storage.
- `src/smoke.ts`: smoke test.
- `public/index.html`: admin page.

## Contributing

Contributions are welcome: bug reports, fixes, docs and new integrations. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, ask questions in [Discussions](https://github.com/Genpire/agent-army/discussions), and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE). Agent Army is an independent project, not affiliated with Anthropic, Slack, GitHub or monday.com.
