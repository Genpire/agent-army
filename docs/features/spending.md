# Spending controls (README section and Admin API rows)

This file holds the README text for spending caps, alerts and model routing, ready to merge into `README.md` (after **The team**), and the Admin API rows to add to or replace in its table.

---

## Spending

Repo tasks are where the credit goes. Two settings keep it in check: **caps** stop new work once a budget is used up, and **model routing** runs small tasks on a cheaper model.

### Caps

On **Settings → Spending**:

- **Monthly budget** (`budget.monthlyUsd`): what Claude may cost per calendar month (UTC), chat replies and repo tasks together. `0` (the default) is no cap.
- **Caps per repository** (`budget.perRepoUsd`): what repo tasks on one repository may cost per month. Chat does not count toward them. A repository without a row has no cap of its own.
- **Alert at** (`budget.alertPercent`, 80 by default) and **Alert channel** (`budget.alertChannel`, a Slack channel ID).

What a cap does:

- **New repo tasks are refused** once the monthly cap or the task's repository cap has less than $0.50 left, from every place a task starts: Slack, the console's chat and **New task**, and GitHub review follow-ups. Nothing is posted, saved or started; the refusal says how much was used, the cap, and that the owner can raise it under **Settings → Spending**. In Slack and in the console's chat, Pointer relays it; a review follow-up posts it in the task's thread.
- **Chat replies are refused** once the monthly cap is used up, before any model call. Commands like `status` and `bind` still work.
- **A task's budget never exceeds what is left.** The worker lowers the task's budget (**Budget per task**) to what is left of the caps that apply, and its fix rounds share that budget. The timeline says when it did.
- **Running tasks are never stopped by a cap**: their own budget already bounds them. Tasks that run at the same time each see what was left when they started, so together they can go past a cap by up to their budgets.

The spend counted is the one the Activity page shows: each chat reply's reported cost and each repo task's cost on its record, in the current UTC month.

### Alerts

When a cap reaches its alert level, and again when it is used up:

- the **Overview** page shows a warning banner (alert level) or an error banner (used up), with the month's spend against every cap as progress bars;
- with an **Alert channel** set, Pointer posts one message there per cap and level per month, after the task or chat reply that crossed it (invite the app to the channel first). A cap passed in one go gets only the "used up" message. Changing a cap or the alert level alerts again for the new values. A message Slack refused (for example `not_in_channel`) is tried again after the next spend.

### Model routing

On **Team → Model routing**, turn on **Route repo tasks by size**. Before each repo task, the worker asks Haiku 5.5 (`claude-haiku-5-5`) to call the request *small*, *medium* or *large*: one call without tools, one turn, a JSON answer, at most $0.05 (in practice a fraction of a cent, added to the task's cost). The task then runs with that size's model and effort:

| Size | Meant for | Default model | Default effort |
| --- | --- | --- | --- |
| Small | A contained change with a clear location: a typo, copy, a config value, a small fix in one or two files | Sonnet 5.5 | low |
| Medium | A feature or fix in one area: several files, new tests, or some investigation first | Sonnet 5.5 | medium |
| Large | Work across many files or modules: a new subsystem, a migration, a broad refactor, a bug with an unknown cause | Claude default (the model on **Integrations → Claude**) | high |

- The model applies to Pointer and to every agent without its own model; the effort replaces the repo task effort for Pointer and for every agent without its own effort. Agents with their own model or effort keep it.
- If the estimate fails (no answer, an error, a timeout), the task is treated as medium. Routing never stops a task.
- **Cost estimate.** The task records its size (`task.size`: size, model, effort, reason) and a cost range (`task.estimateUsd`): the 25th to 75th percentile of what earlier finished tasks of the same size cost, on the same repository once it has three of them, else on any repository, else a first guess ($0.25–$1.50 small, $1–$5 medium, $4–$15 large). The range never goes past the task's own budget. Slack's first progress line shows it (`small task · Sonnet 5.5, low effort · ~$0.40–$1.20`), and so does the task's timeline (a `routing` event) and its card in the console.
- Off (the default): every task runs on the configured models with the repo task effort.

Opus 5.5 costs $4 / $20 per million input / output tokens, Sonnet 5.5 $2 / $10, Haiku 5.5 $0.10 / $0.50.

### Preview check

**Settings → Repo task limits → Preview check** (`limits.previewCheck`): after the checks, the team opens the pull request's preview deployment (Vercel, Netlify… through GitHub deployments) in a browser and looks at the change: **Off**, **When the change is visible** (the default) or **Always**. Each look is a short extra run of the team, paid from the task's budget.

---

## Admin API rows

New:

| Route | Body / query | Result |
| --- | --- | --- |
| `POST /api/budget` | `{ monthlyUsd?, perRepoUsd?, alertPercent?, alertChannel? }` | Spending caps. Fields left out are kept. `monthlyUsd` and each cap in `perRepoUsd` are USD from 0 (no cap) to 100 000; `perRepoUsd` (`{ "owner/repo": usd }`, at most 200) replaces the whole list, and entries of 0 are dropped; the same repository twice in different case is refused. `alertPercent` is a whole number from 10 to 100; `alertChannel` a Slack channel ID or `""` (no Slack alerts). Returns `{ ok, budget }`. Alerts a lowered cap has already reached are posted right away. |

Replace:

| Route | Body / query | Result |
| --- | --- | --- |
| `GET /api/usage` | | Claude spend this calendar month (UTC) with the caps: `{ month, chat: { usd, count }, tasks: { usd, count }, totalUsd, topTasks: [{ id, repo, instruction, costUsd, createdAt }], repos: [{ repo, usd, count }], budget }`. `repos` is repo task spend per repository, highest first. `budget`: `{ monthly, repos, alertPercent, alertChannel, level, alerts }`, where `monthly` is `null` without a monthly cap or `{ capUsd, usedUsd, remainingUsd, percent, level }`, `repos` lists every repository with a cap the same way (with `repo`), `level` is the highest of `ok`, `alert` and `exceeded`, and `alerts` lists the caps at or past the alert level: `[{ key, scope: "monthly" \| "repo", repo?, level: "alert" \| "exceeded", capUsd, usedUsd, percent, notifiedAt? }]` (`notifiedAt`: when the alert channel was told). The Overview, Activity and Settings pages and Slack's `status` show it. |
| `POST /api/settings` | `{ orgName?, allowedUserIds?, allowedOwners?, bindings?, pointerChannels?, limits? }` | Partial update; `limits` (`maxTurns`, `maxBudgetUsd`, `maxParallel`, `progressEveryMin` 0-60, `ciWaitMin` 0-60, `ciFixRounds` 0-5, `previewCheck` `off` \| `visible` \| `always`) merges field by field. `allowedOwners` is the primary GitHub token's allow list (owners or exact repos). |
| `POST /api/team` | `{ pointer, agents }` | Replaces the team. `pointer`: `{ name, instructions, budgetUsd, maxTurns, model?, effort?, taskEffort?, routing? }`; `routing`: `{ enabled, small, medium, large }`, each size `{ model, effort }` (`model: ""` = the configured model). Each agent: `{ id, name, role, emoji, description, instructions, access, model?, effort?, enabled }`. Effort is `low`, `medium`, `high`, `xhigh` or `max` (an agent's `""` follows the chat or task). |
| `POST /api/tasks` | `{ repo, instruction }` | Starts a repo task directly (no Pointer reply) in a new conversation whose first message is the instruction (up to 8 000 characters). Same checks as Slack (GitHub connected, allow lists: `400`). `409` when a spending cap is used up (no conversation is created). `202` with `{ conversationId, taskId }`; `502` with `{ error, conversationId }` when the worker could not start. |

Add to the `GET /api/tasks` row: a routed task also has `size` (`{ size: "small" \| "medium" \| "large", model, effort, reason? }`) and `estimateUsd` (`{ low, high }`); its timeline has a `routing` event.

Add to the `GET /api/state` row: `config.budget` is `{ monthlyUsd, perRepoUsd, alertPercent, alertChannel }`; `config.team.pointer.routing` is the model routing; `config.limits` includes `previewCheck`.
