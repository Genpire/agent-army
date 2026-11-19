# monday.com ticket automation

Text for the README: the section goes under [monday.com](#mondaycom), the rows under [Admin API](#admin-api).

---

### Tickets that start repo tasks

Optional, and off until you turn it on, board by board. When a ticket on an automated board moves to the board's start status (for example **Ready for dev**), the team starts on it, and the ticket shows the progress:

| When | The ticket's status | The update posted on the ticket |
| --- | --- | --- |
| The task starts | the "working" label (default **Working on it**) | "The team started on this", with a link to the task's conversation in the console |
| The pull request opens (or a follow-up updates it) | the "in review" label (**In review**) | the pull request's link and title |
| The team stops early, fails or is blocked | the "stuck" label (**Stuck**) | the reason, and the draft pull request that keeps the unfinished work |
| The team answers without changing code | the "in review" label | the answer, for a person to read |
| The pull request is merged | the "done" label (**Done**) | "Merged: …" |
| The pull request is closed without merging | unchanged | that it was closed |

An empty label leaves the status as it is. Updates are signed by Pointer, and credentials are removed from them.

The task runs in a new conversation on the **Chat** page, named after the ticket. Its instruction is the ticket's name, its description and first updates (oldest first) and its column values, in short. Files on the ticket are listed by name: ask Pointer in that conversation to attach them (its monday.com tools) and a follow-up task gets them. A follow-up in that conversation (a reply such as "continue", or review feedback on the pull request) keeps updating the same ticket.

**Set it up** on **Integrations → monday.com → Ticket automation** (monday.com and GitHub connected):

1. **Automate a board**: pick the board (one of the boards Pointer may use, when that list is set), the repository (allowed by a GitHub connection), the status column, the label that starts a task, and the labels the team sets. The labels are checked against the board; the start label must differ from the others, so a ticket cannot start itself again.
2. Turn on **Start tasks from tickets**.
3. **Connect webhook**: creates a webhook on each automated board (a change of its status column) pointing at `https://<your deployment>/monday/webhook/<secret>`. monday.com checks the address once when the webhook is created, so the deployment must be reachable from the internet. Connect again after adding a board.

If the token's monday.com user cannot create webhooks (it needs the `webhooks:write` scope and edit rights on the board), the pane shows the address and how to add it by hand: on the board, open **Integrate**, search for **Webhooks**, choose **When a column changes, send a webhook**, pick the status column and paste the address.

For **Done** on merge, the GitHub webhook (see [Pull request reviews](#pull-request-reviews)) must also send **Pull requests** events.

**What is trusted.** monday.com does not sign webhooks created with an API token, so the secret in the address is the check: deliveries to a wrong address, or while the automation is off, get `404`. The delivery itself is not trusted beyond its board and item ids: Pointer reads the item again and starts a task only when its status is the start label now, its board is automated (and allowed), and no task is already working on that ticket. A ticket that started a task is not started again within five minutes. Ticket text is never logged; logs carry board, item and task ids and the outcome.

Anyone who can change the status on an automated board can start a task on its repository, within the same limits as a request from Slack: allowed repositories only, the per-task budget, and a pull request a human must merge. Automate only boards whose members you would let ask for changes.

Turning the automation off stops new tasks and makes the webhook address answer `404`; tasks already running keep updating their tickets.

---

### Admin API rows

| Route | Body | What it does |
| --- | --- | --- |
| `POST /api/monday/automation` | `{ enabled?, boards?: { "<boardId>": { repo, statusColumnId, startLabel, workingLabel?, reviewLabel?, doneLabel?, stuckLabel? } \| null } }` | Turns ticket automation on or off and adds, changes (`null` removes) automated boards. Boards must be among `allowedBoardIds` when that list is set; `repo` must be allowed by a GitHub connection; the start label must differ from the others. With monday.com connected (and `SKIP_VALIDATION` unset) the status column and every label are checked on the board, and saved in the board's spelling; labels left out default to Working on it, In review, Done and Stuck, and `""` leaves the status alone. Removing a board deletes the webhook created on it. Returns `{ ok, automation }` (`config.monday.automation`: `{ enabled, webhookConfigured, boards }`, never the secret). |
| `POST /api/monday/automation/webhook` | | Makes the webhook secret on first use and creates a `change_specific_column_value` webhook on each automated board's status column, pointing at `<base>/monday/webhook/<secret>` (an earlier one for another address is replaced). The automation must be on. Returns `{ ok, url, created: [boardId], failed: [{ boardId, error }], manualSteps? }`; `manualSteps` says how to add the webhook by hand when some boards failed. |
| `GET /api/monday/columns` | `?boardId=` | `{ board: { id, name }, columns: [{ id, title, labels }] }`: the board's status columns and their labels, for the pickers. `400` when not connected, the board is not allowed, or monday.com fails. |
| `POST /monday/webhook/:secret` | monday.com's delivery | Not an admin route. `404` unless the automation is on and the secret matches (compared in constant time). Echoes `{ challenge }`; otherwise answers `200` at once, then reads the item again and starts the task (trigger `monday`, with `ticket`) when it qualifies. |

`config.monday.automation` in `GET /api/state` shows `enabled`, `webhookConfigured` (whether a webhook secret exists) and `boards`. Tasks started from a ticket have `trigger: "monday"` and `ticket: { boardId, itemId, name, url }`; their timeline has a `ticket` event for each update of the ticket.
