# Agent Army

[![CI](https://github.com/Genpire/agent-army/actions/workflows/ci.yml/badge.svg)](https://github.com/Genpire/agent-army/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A self-hosted Slack assistant, **Pointer**, with a team of Claude agents that answer questions, research, read your code and turn requests into pull requests. One container, deployable anywhere, configured entirely from its own web page.

- **Pointer:** talk to it in a DM, in channels you mark as Pointer channels, or in any thread it is part of. It answers questions, researches the web, reads GitHub and the files you share (designs, code, screenshots, PDFs, zips), remembers facts you give it, opens and updates monday.com tickets (optional), and hands work to its team. Built on the Claude Agent SDK.
- **The team:** agents you list, name, edit and create on the admin page, for any role: engineering (Coder, Reviewer, QA) or not (Researcher, Writer). Pointer picks the agent whose description fits the job.
- **Code changes:** any change to a repo runs as a task in its own isolated worker: clone, Pointer and the team work on a branch, then the platform opens a pull request, waits for its CI checks and has the team fix failing ones. Agents can check UI changes in a headless browser and post screenshots in Slack. With the GitHub webhook set up, review comments on the pull request start a follow-up. Each agent learns the project from the repo itself (CLAUDE.md, README, scripts, CI) and from the team's **project notes**, which every task reads at the start and updates at the end.
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
   ├─ clone repo, new branch, run the repo's setup command
   ├─ read project notes, Pointer ⇄ the team (Coder, Reviewer, QA, …), headless browser for UI checks
   ├─ push branch, open PR (a draft if the task stopped early), wait for CI, fix failing checks
   └─ update project notes, report in thread with screenshots

GitHub: review or /pointer comment on the team's PR ──webhook──► follow-up task in the same thread
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

The web service runs with 8 vCPU, 8 GiB (`SERVICE_CPU` / `SERVICE_MEMORY`) and **CPU always allocated** (Pointer keeps working after Slack has its HTTP 200, and the Agent SDK runs as a subprocess), as a **single instance** (per-thread queues and event dedupe live in memory). With the default `MIN_INSTANCES=0` it scales to zero when idle and the first message afterwards waits for a cold start. At this size an instance costs roughly $0.58 per hour while it is up (it stays up about 15 minutes after the last request), so `MIN_INSTANCES=1` would cost roughly $420 a month; lower `SERVICE_CPU` / `SERVICE_MEMORY` (e.g. 1 and 2Gi, about $55 a month warm) if you keep one warm. Claude usage is billed separately, capped per message and per task (see below). The worker job runs each task with 8 vCPU and 8 GiB (`JOB_CPU` / `JOB_MEMORY`), billed only while a task runs, for at most 3 hours (`JOB_TIMEOUT_MIN`, default 180): the team's own run stops after 50 minutes, and waiting for CI checks, fix rounds and publishing come after it.

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
4. **GitHub**: a fine-grained personal access token, ideally on a dedicated bot account, limited to the repos the agents may touch, with *Contents: read/write*, *Pull requests: read/write*, *Metadata: read*, and for the [CI checks](#ci-checks) loop *Checks: read*, *Commit statuses: read* and *Actions: read*. Optionally restrict it to owners or exact repos. For repos outside your organisation, add more tokens under *Other GitHub connections* (see [GitHub connections](#github-connections)). Without GitHub, Pointer still chats; GitHub questions and repo tasks say GitHub is not connected. Optionally add the webhook for [pull request reviews](#pull-request-reviews) on the same card.
5. **monday.com** (optional): an API token so Pointer can open and update tickets, a default board and the boards it may use. See [monday.com](#mondaycom).
6. **Projects and rules** (optional): channel → default repo, Pointer channels, who may talk to Pointer, budget and turn limits per task, how long to wait for CI checks and how many fix rounds to run. Per repo, the **Repo setup** card holds a setup command, how to start the app and environment variables (see [Repo setup](#repo-setup)).
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
| reply in a stopped task's thread: `continue` | Resumes the unfinished work on the same branch and draft PR |
| on GitHub, request changes on the team's PR, or comment `/pointer rename the flag` | Starts a follow-up task in the task's thread (webhook set up, see [Pull request reviews](#pull-request-reviews)) |

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

The worker clones the repo, creates a branch (`army/…`), runs the repo's setup command if the owner set one (see [Repo setup](#repo-setup)) and runs Pointer with the team. Pointer plans with acceptance criteria, hands the change to an agent with *Change code* access, then has another fitting agent review or test it, for up to three rounds; changes people can see are also checked in a headless browser (see [Browser checks](#browser-checks)). If a role is missing it skips the step and says so; if no *Change code* agent is enabled and the request needs code, the task comes back blocked.

The platform then commits, pushes the branch and opens the pull request, waits for its CI checks and has the team fix failing ones (see [CI checks](#ci-checks)). Pointer edits one message in the thread as the team works, then posts the summary, verification results, risks, a *Checks* line and the pull request link, followed by any screenshots the agents took. A task started from a DM gets its own thread on your message, where progress and follow-ups live.

**Follow-ups.** A reply in the task's thread starts a new task on the same branch and pull request, which the platform comments on instead of opening another. When the thread has a pull request, the team also gets the review feedback left on GitHub since its last run. Feedback on GitHub can start a follow-up by itself: see [Pull request reviews](#pull-request-reviews).

**Unfinished work is kept.** When a task times out (`TASK_TIMEOUT_MIN`, 50 minutes by default) or hits its budget or turn limit, the worker commits what the team has, pushes the branch and opens a **draft** pull request (or comments on the thread's existing one), and says in Slack why it stopped. Reply in the thread (for example `continue`) to resume on the same branch; when the work finishes, the draft is marked ready for review. If the team had changed nothing, there is nothing to publish.

**Progress while the team works.** The progress message is a live dashboard: what is happening now, the lead's plan as a checklist (the lead keeps it with TodoWrite, or TaskCreate/TaskUpdate), which agents are working and for how long, the latest steps (files edited, commands run, each agent's report line) and the files changed so far. Every few minutes (5 by default; **Progress update every** on the Projects card, 0 turns it off) a new update is posted in the thread, so followers are notified. Ask in the thread "how is it going?" and Pointer answers from the same saved progress with its `repo_task_status` tool. All of this is built from the Agent SDK's message stream and costs no Claude credit.

### Browser checks

The image includes headless Chromium and the [Playwright MCP server](https://github.com/microsoft/playwright-mcp). In repo tasks, agents with *Look and run commands* or *Change code* access get its browser tools (`mcp__browser__browser_*`: navigate, snapshot, click, type, fill forms, resize, screenshots, console and network messages, and a few more); *Look only* agents and Pointer itself do not. Each of those agents starts its own browser with an in-memory profile. `browser_run_code_unsafe` is left out on purpose: it runs arbitrary code in the server's process, outside the shell guard.

For a change people can see (UI, pages, styles), Pointer briefs the verifying agent to:

1. start the app in the background, with the repo's start command (see [Repo setup](#repo-setup)) or else the project's own dev script, and wait until it answers;
2. open it, exercise the changed flow and check the browser console for errors;
3. take screenshots with descriptive file names (`after-sidebar-desktop.png`) at 1280 px wide, and at 390 px when layout matters.

If the app cannot start (a database or service it needs is missing, or a variable is not set), the agent says so in verification instead of guessing. Agents are told never to take screenshots of pages that show secrets.

Screenshots saved under a relative file name go to a folder outside the checkout, so they never end up in the pull request, and are posted in the task's Slack thread after the task. Posting needs the Slack `files:write` scope: apps created before this feature must update their manifest and reinstall (see [Updating an existing Slack app](#updating-an-existing-slack-app)).

Set `BROWSER=off` on the worker to give the agents no browser. Outside the Docker image (for example `npm run dev`), the browser is available only when `PLAYWRIGHT_BROWSERS_PATH` names a folder with Playwright's Chromium in it: install it with `PLAYWRIGHT_BROWSERS_PATH=$HOME/.cache/ms-playwright npx playwright install chromium` (in this repo, so the version matches) and start the server with the same variable.

### CI checks

After pushing, the worker waits for the pull request's checks: GitHub Actions check runs and the commit statuses other services report (Vercel deployments, for example).

- **Wait for checks** (Projects card, `limits.ciWaitMin`): up to 15 minutes by default, at most 60. `0` skips waiting.
- **Fix rounds for failing checks** (`limits.ciFixRounds`): when checks fail, the team gets each failing check's output and annotations and the end of its GitHub Actions job log, fixes the problem, and the worker pushes and waits again. 2 rounds by default, at most 5; `0` only reports the failures. Fix rounds count against the task's budget, and the worker stops in time to publish before its deadline (`JOB_TIMEOUT_MIN`).
- The Slack result has a *Checks* line: passed, failed (with the failing checks' names), still running when the wait ended, or no checks. The Activity card on the admin page shows the same.

A fine-grained token needs *Checks: read*, *Commit statuses: read* and *Actions: read* (for job logs) on top of *Contents* and *Pull requests* read/write. Editing an existing token's permissions on GitHub keeps its value, so nothing changes on the admin page. A classic token with the `repo` scope covers them.

### Pull request reviews

With the GitHub webhook set up, feedback on a pull request the team opened starts a follow-up task in that task's Slack thread, on the same branch, as if someone had replied in the thread.

What starts a task, from someone with write access to the repository (GitHub's author association `OWNER`, `MEMBER` or `COLLABORATOR`):

- a submitted review that requests changes, or a review submitted as a comment;
- a comment on the pull request that starts with `/pointer` or mentions `@pointer`.

What is ignored: approvals, comments from bots, the platform's own comments on its pull requests, people without write access (`CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`, …), pull requests the team did not open, other events, and deliveries without a valid signature. Other comments from people with write access do not start a task, but the next follow-up in that thread sees them with the rest of the new feedback. If the team is still working in the thread, Pointer posts a note there instead of starting a second task.

Set it up:

1. On the admin page, open **GitHub → Pull request reviews (webhook)**. It shows the payload URL (`https://<your deployment>/github/webhook`).
2. In GitHub, open the repository's (or, to cover all its repos, the organisation's) **Settings → Webhooks → Add webhook**.
3. **Payload URL**: the URL from step 1. **Content type**: `application/json`.
4. **Secret**: click **Generate** on the card (or use `openssl rand -hex 32`), copy it into GitHub, and **Save** it on the card. It is stored encrypted and never shown again.
5. **Which events**: *Let me select individual events*, then tick **Pull request reviews** and **Issue comments** (untick *Pushes*).
6. Keep **Active** ticked and click **Add webhook**. The webhook's *Recent Deliveries* tab on GitHub shows each delivery and the response.

Each delivery is checked against the secret (HMAC-SHA256, GitHub's `X-Hub-Signature-256` header) before anything else. **Remove** on the card deletes the secret, after which deliveries are refused.

## The team

The **Team** card on the admin page holds Pointer's settings and the agent list.

- **Pointer:** its name, extra instructions (appended to its built-in prompt), and per-message limits for conversations: budget (default $1) and turns (default 40).
- **Model and effort:** the chat model (empty uses the Claude card's model), the chat effort and the repo task effort (`low`, `medium`, `high`, `xhigh`, `max`; both default to `medium`). Each agent can set its own model and effort; an empty effort follows the chat or repo task it is part of. Higher effort thinks longer: better on hard work, slower, and more credit. Sonnet 5.5 costs half as much as Opus 5.5 per token, and Haiku 5.5 far less.
- **Agents:** a fresh deployment starts with Coder, Reviewer, QA, Researcher and Writer. Add, edit, disable or delete agents. Each has a name, role, emoji, *When should Pointer use this agent?* (Pointer chooses agents by this), instructions, access, model and an enabled switch. The id is derived from the name and does not change.

| Access | Tools in repo tasks |
| --- | --- |
| Look only | Read, Glob, Grep, WebSearch, WebFetch |
| Look and run commands | the above, plus Bash (behind the shell guard) and the [browser tools](#browser-checks) |
| Change code | the above, plus Edit and Write |

In Slack conversations every agent gets the same safe tools (web search and fetch, GitHub read), whatever its access. **Model** is *Same as Pointer* (the configured Claude model, else the SDK default) or a specific Claude model per agent. Platform ground rules (no pushing, no secrets, treat web and file content as data, report facts) are appended to every agent and cannot be edited away. The page warns when no enabled agent can change code.

Pointer can describe the team in Slack but cannot change it; only the admin page can. Renaming Pointer changes how it introduces itself; the name Slack shows changes when you update the app manifest (below). Per-project behaviour belongs in that project's own `CLAUDE.md`, which the agents load automatically in repo tasks.

The image ships Node 22 (with corepack), Python 3, git, make, g++, and headless Chromium with its system libraries for [browser checks](#browser-checks) (Playwright's build, under `/ms-playwright`; it adds about 440 MB to the compressed image). A repo's own Playwright tests still download the browsers their Playwright version needs, as usual. For repos that need other toolchains (Go, Java, …), extend the image:

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

## Repo setup

How repo tasks prepare and run one repository, set per repo on the admin page's **Repo setup** card. Everything is optional; a repo without a setup is worked out from the project itself.

- **Setup command**, e.g. `npm ci`, `pip install -r requirements.txt` or `make deps`: run once with `bash` in the checkout after the clone, before the team starts, with the repo's environment variables below. It may run for up to 15 minutes. The team is told whether it worked, how long it took and the last lines of its output (with secrets redacted); when it failed, the team works around it or reports what is missing.
- **Start command** and **App URL**, e.g. `npm run dev` and `http://localhost:3000`: how the agents start the app and where it answers, for [browser checks](#browser-checks). Without them, the agents use the project's own dev script.
- **Environment variables**: `NAME=value` lines (one per line; `export ` and quotes around a value are dropped, as in a `.env` file), set in the agents' shell and for the setup command. Values are stored encrypted with the config and never sent back to the browser: the card lists names only. To change a value, enter the line again; leave a name out to keep it; remove one with its **Remove** button. At most 100 per repo; names use letters, digits and `_`, and the names the platform sets itself (`PATH`, `HOME`, `ANTHROPIC_API_KEY`, `MASTER_KEY`, …) are refused.

The team's prompt gets the variable names, never their values, with the rule not to print them, write them into files or commit `.env` files. The values are also redacted from everything the worker posts or logs. Anything in the agents' shell can still be read by the agents and by the repo's code they run (see [Security model](#security-model)), so use development or test credentials, not production ones.

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

Apps created before Pointer only receive @mentions, apps created before file support cannot download shared files, and apps created before browser checks cannot post screenshots. To let Pointer receive DMs and channel messages, add reactions, read files and post screenshots, update the app once:

1. On the admin page, open **Slack → Already created the app? Update it** and copy the manifest.
2. At [api.slack.com/apps](https://api.slack.com/apps), open your app → **App Manifest**, replace the JSON with the copy, **Save**.
3. **Install App → Reinstall** to grant the new scopes (`im:history`, `reactions:write`, `files:read`, `files:write`).

Until you do, @mentions still work, but DMs, Pointer channels and unmentioned thread replies are not received, reactions are skipped, Pointer answers without the files, saying it is "missing files:read permission", and screenshots from browser checks are not posted. Update it again whenever you rename Pointer.

## Security model

- **Isolation:** each repo task runs in its own container (Cloud Run Job) or process (local), in a throwaway checkout that is deleted afterwards.
- **Conversations are tool-restricted:** Pointer runs in the web service with only web search and fetch, its agents, and its own service-side tools (GitHub read, memory, project notes, monday.com when connected, start a repo task). It has no shell and cannot read or write files; anything not explicitly allowed is denied, no settings files are loaded, and each message gets a fresh temporary directory as its working directory and home (deleted afterwards) and a minimal environment whose only secret is the Anthropic key. The master key and the Slack, GitHub and monday.com tokens held by the service are out of its reach.
- **Pull requests only:** the platform, not the agents, pushes the branch and opens the PR (a draft for unfinished work). Enable branch protection on your default branch so merging requires a human review.
- **Least privilege:** each GitHub token should cover only the repos you want worked on. Tokens are used only by the service-side tools and the worker. The GitHub allow lists (owners or exact repos, per connection) apply to GitHub reads and repo tasks, and the Slack user allowlist is checked before any model call.
- **GitHub webhook:** `POST /github/webhook` refuses any delivery whose HMAC-SHA256 signature does not match the shared secret, and starts work only for feedback from people with write access to the repository (`OWNER`, `MEMBER`, `COLLABORATOR`) on pull requests the team opened. Bots and the platform's own comments are ignored. The follow-up runs on the same repo, so it is bound by the same allow lists and limits as any task.
- **Secrets:** in repo tasks the agents' shell gets a minimal environment (no master key, Slack or GitHub tokens) plus the variables the owner set for that repo under [Repo setup](#repo-setup), git credentials are passed per command and never written to `.git/config`, and a shell guard blocks pushing, credential changes and reading platform secrets. The repo's variables, memory, project notes, shared files, the webhook secret and the monday.com token are stored encrypted with the master key; variable values are never sent to the browser or the team's prompt and are redacted from what the worker posts and logs. Message text and file contents are never logged. The Slack token is sent only to `https://files.slack.com` when downloading a file.
- **Browser:** the browser tools run Chromium in its own process, outside the shell guard, with an environment that holds no secrets. The tool that runs arbitrary code in that process (`browser_run_code_unsafe`) is not offered. Screenshots are written outside the checkout and posted only in the task's own thread.
- **Limits:** per-message budget and turns for conversations (Team card), per-task budget, turn limit and timeout for repo tasks (Projects card), plus the CI wait and fix rounds, which run within the same budget and the worker's deadline. At most six answers are worked on at once; the rest wait their turn.

Known limits, stated plainly:

- **Prompt injection:** a web page, issue or file Pointer reads could try to steer it into saving a memory fact or project note, opening or editing a monday.com ticket, or starting a repo task. The damage is bounded: tasks only touch allowed owners and repos, stop at the per-task budget and end as a pull request a human must merge; memory and project notes are visible and editable on the page; monday.com changes are limited to the allowed boards, never delete anything and are recorded in the item's activity log.
- **Pull request feedback and CI output are untrusted content too.** Review comments come only from people with write access, but they, the pages the browser opens and the CI logs the team reads in fix rounds are given to the team as data, not instructions, and are bounded the same way: same repo, same budget, and the result is still a pull request a human must merge.
- **Exfiltration through web fetch:** Pointer can read private data (private repos, monday.com items, memory, project notes) and fetch any URL. Injected content could try to make it send that data to an outside address. Subagents are read-only and the prompt treats fetched content as data, but there is no URL allowlist. Keep the GitHub tokens and monday.com token scoped to what Pointer needs.
- **The repo-task container is not a boundary for platform secrets.** The worker process holds the master key and its service account can read the bucket and the secret; the agents' shell runs as the same user. The shell guard blocks the obvious paths (`/proc/*/environ`, the metadata server), but a determined agent following injected instructions could get around it. Repo tasks can be started by Pointer from conversation, so treat the content Pointer reads (web pages, issues, repos) as part of the trust boundary, and give this deployment its own GCP project for anything sensitive.
- Memory is global (see above): do not use it for anything private.
- The agents' shell in repo tasks does hold the Anthropic API key (the SDK needs it) and the repo's own variables from [Repo setup](#repo-setup), and runs code from the repo. An agent, or code it runs, can read and send those values anywhere: treat the repos you connect as trusted, keep the key dedicated and capped, and give repos development or test credentials only. The shell guard is a seatbelt, not a sandbox boundary.
- The browser is not behind the shell guard. It can open any URL the worker can reach, including the app the agents started and outside sites; by default the Playwright MCP server blocks `file://` pages and keeps file access to its own folder. Set `BROWSER=off` if you do not want it.
- People from other organisations in Slack Connect channels are ignored unless their user ID is on the allowlist.
- Agents have outbound network access (they need it to install dependencies and research).
- On Cloud Run, the checkout lives in memory-backed `/tmp`; the job is sized at 8 GiB. Raise `JOB_MEMORY` in `deploy/gcp.sh` (up to 32Gi) for very large repos. Chromium and the app the agents start use the same memory.
- If a task hits its budget, turn limit or timeout, its partial work is pushed as a draft pull request and the thread says so; reply there to continue. Work cut off by the job's own hard limit (`JOB_TIMEOUT_MIN`) before the worker could publish is lost, which is why the worker stops waiting for checks and fixing them in time.
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
| `TASK_TIMEOUT_MIN` | Stops the team's first run in a repo task, checkout and setup command included (default 50). The work so far goes into a draft pull request. |
| `JOB_TIMEOUT_MIN` | The worker's hard deadline in minutes: the team's run, waiting for CI, fix rounds and publishing must fit in it. Unset = no deadline. Set it to the job's timeout on Cloud Run (`deploy/gcp.sh` sets 180 and a 3-hour task timeout). |
| `BROWSER` | `off` gives the agents no headless browser in repo tasks (no [browser checks](#browser-checks) or screenshots). |
| `PLAYWRIGHT_BROWSERS_PATH` | Where Playwright's Chromium is installed (`/ms-playwright` in the image). Without it, there is no browser. |

### Admin API

The admin page is a client of this JSON API. Every route except `/api/state`, `/api/setup`, `/api/login` and `/api/logout` needs the admin session cookie (else `401`). Errors are `{ "error": "…" }` with status `400` (invalid input or a failed check), `403`, `404` or `409`. Secrets are accepted, never returned.

Besides the admin API, the service takes `POST /slack/events` from Slack and `POST /github/webhook` from GitHub (see [Pull request reviews](#pull-request-reviews)); both are verified with their signing secret, not the admin session.

| Route | Body / query | Result |
| --- | --- | --- |
| `GET /api/state` | | Setup and sign-in state; when signed in, readiness, `eventsUrl`, `githubWebhookUrl` (the payload URL for GitHub) and the config without secrets (`config.github.extra` lists the other GitHub connections as `{ id, login, allowed, key }` with a masked key; `config.github.webhook.configured` says whether a webhook secret is saved; `config.repoSetup` maps `owner/repo` to `{ setupCommand, startCommand, appUrl, envKeys }`, variable names only; `config.monday` shows `connected`, `userName`, `accountName`, `defaultBoardId`, `allowedBoardIds`; `config.limits` includes `ciWaitMin` and `ciFixRounds`). |
| `POST /api/setup` | `{ setupToken, password }` | Creates the admin account and signs in. |
| `POST /api/login` / `POST /api/logout` | `{ password }` / none | Session cookie. |
| `POST /api/anthropic` | `{ apiKey, model? }` | Verifies and saves the Claude key. |
| `GET /api/slack/manifest` | `?name=` | `{ manifest, createUrl }` for this deployment. |
| `POST /api/slack` | `{ botToken, signingSecret }` | Verifies and saves Slack. |
| `POST /api/github` | `{ token, allowedOwners? }` | Verifies and saves the primary GitHub token. `allowedOwners` entries are owners (`your-org`) or exact repos (`owner/repo`), at most 50. Other connections are kept. |
| `POST /api/github/connections` | `{ token, allowed? }` | Verifies the token and that it can reach each exact repo in `allowed` (same entry rules), then adds it as another connection (at most 10). Returns `{ ok, id, login }`. |
| `POST /api/github/connections/update` | `{ id, allowed }` | Replaces a connection's allow list; its exact repos are checked with the connection's token. `404` if unknown. |
| `POST /api/github/connections/delete` | `{ id }` | Removes a connection (`404` if unknown). |
| `POST /api/github/webhook` | `{ secret }` | Saves the shared secret of the GitHub webhook: 20-200 characters, no whitespace. `""` removes it. Returns `{ ok, url }` with the payload URL. |
| `POST /api/monday` | `{ token?, defaultBoardId?, allowedBoardIds? }` | With `token`: verifies it and connects as its user. Board ids are digit strings (at most 100; `defaultBoardId: ""` clears the default, which must be among `allowedBoardIds` when those are set). Without a token, monday.com must already be connected. Returns `{ ok, userName?, accountName? }`. |
| `POST /api/monday/disconnect` | | Forgets the token and its user; keeps the board settings. |
| `GET /api/monday/boards` | `?search=` | `{ boards: [{ id, name, workspace? }] }`: up to 50 active boards, most recently used first, filtered by name. `400` when not connected or when monday.com fails. |
| `POST /api/settings` | `{ orgName?, allowedUserIds?, allowedOwners?, bindings?, pointerChannels?, limits? }` | Partial update; `limits` (`maxTurns`, `maxBudgetUsd`, `maxParallel`, `progressEveryMin` 0-60, `ciWaitMin` 0-60, `ciFixRounds` 0-5) merges field by field. `allowedOwners` is the primary GitHub token's allow list (owners or exact repos). |
| `POST /api/repo-setup` | `{ repo, setupCommand?, startCommand?, appUrl?, env? }` | Creates or updates a repo's setup; omitted fields are kept. `setupCommand` up to 2 000 characters, `startCommand` up to 500, `appUrl` empty or `http(s)://…`. `env` is `{ NAME: "value" \| null }`: a value sets the variable, `null` deletes it, names left out are kept (at most 100; reserved names are refused). Returns `{ ok, repoSetup }`: that repo's setup with variable names only. |
| `POST /api/repo-setup/delete` | `{ repo }` | Removes a repo's setup and its variables (`404` if unknown). |
| `POST /api/team` | `{ pointer, agents }` | Replaces the team. `pointer`: `{ name, instructions, budgetUsd, maxTurns, model?, effort?, taskEffort? }`; each agent: `{ id, name, role, emoji, description, instructions, access, model?, effort?, enabled }`. Effort is `low`, `medium`, `high`, `xhigh` or `max` (an agent's `""` follows the chat or task). |
| `GET /api/memory` | | `{ facts, max }` |
| `POST /api/memory/delete` | `{ id }` | Deletes one fact (`404` if unknown). |
| `GET /api/notes` | | `{ notes: [{ repo, updatedAt, chars }], max }`, newest first; `max` is 8 000. |
| `GET /api/notes/:owner/:repo` | | `{ repo, text, updatedAt }`, or `404` when the repo has no notes. |
| `POST /api/notes` | `{ repo, text }` | Replaces the repo's notes; empty text deletes them. `400` for a bad repo name or text over the limit. |
| `GET /api/tasks` | | `{ tasks }`: the 30 most recent repo tasks; a running task carries `progress` (`now`, `plan`, `agents`, `recent`, `files`, `filesCount`, `startedAt`, `updatedAt`). A task may also have `trigger` (`slack` or `review`), `ci` (`{ state, fixRounds, names, total }`, state `passed`, `failed`, `pending` or `none`) and `screenshots` (how many were posted). |
| `GET /api/usage` | | Claude spend this calendar month (UTC): `{ month, chat: { usd, count }, tasks: { usd, count }, totalUsd, topTasks: [{ id, repo, instruction, costUsd, createdAt }] }`. Chat is tallied from each reply's reported cost; tasks from their records. The Activity card and Slack's `status` show it. |

## Development

Requires Node.js 22 or newer (`nvm use`).

```bash
npm install
npm run build:web  # the admin page, into public/
npm run dev        # server with reload on :8080
npm run dev:web    # admin page with live reload on :5173 (optional)
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
- `src/worker.ts`: clone → setup → team → PR → checks → report.
- `src/repo-setup.ts`: a repo's setup command and variables; `src/ci.ts`: waiting for and fixing the pull request's checks; `src/pr-feedback.ts`: review feedback for the team.
- `src/browser.ts` + `src/browser-mcp.ts`: the headless browser (Playwright MCP) and screenshots.
- `src/webhook.ts` + `src/thread-task.ts`: the GitHub webhook and follow-up tasks in a thread.
- `src/agents.ts`: the repo-task prompt and report.
- `src/guard.ts`: shell guard.
- `src/config.ts` + `src/store.ts`: encrypted config, storage.
- `src/smoke.ts`: smoke test.
- `web/`: the admin page, a React app on [Astryx](https://github.com/meta/astryx) (Meta's design system on StyleX), built into `public/` with `npm run build:web`. Pages in `web/src/pages/`, the API client and the server's types in `web/src/lib/`.

## Contributing

Contributions are welcome: bug reports, fixes, docs and new integrations. Read [CONTRIBUTING.md](CONTRIBUTING.md) to get set up, ask questions in [Discussions](https://github.com/Genpire/agent-army/discussions), and follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), not in public issues.

## License

[MIT](LICENSE). Agent Army is an independent project, not affiliated with Anthropic, Slack, GitHub or monday.com.
