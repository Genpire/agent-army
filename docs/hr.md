# HR (for the README)

Two pieces for the owner to merge into `README.md`: a section after **The team**, and rows for the **Admin API** table.

---

### HR recommendations

HR is the agent who thinks about what the team needs. On **Team → HR recommendations**, **Ask HR for a review**: HR reads how the team actually works and proposes at most six changes, each with its reason and the evidence behind it. Nothing changes until you apply one.

**What HR reads.** One compact summary (at most 30,000 characters), built from records Agent Army already keeps:

- the last 60 repo tasks: the request's first line only (never the full request, ticket or chat), repository, where it started (Slack, console, review, monday.com), how it ended (done, answer, blocked, stopped, failed), why it was blocked or failed (short), which agents worked on it, how long it took, what it cost, and the CI and preview outcomes;
- the team: each agent's name, role, *When to use* line, instructions (cut short on large teams), access, model, effort, enabled switch and skills, and how many recent tasks it worked on;
- Pointer's chat model and effort, the repo task effort and model routing;
- this month's spend and the caps;
- the skills library's names, once there is one.

Every configured secret and well-known token format (Anthropic, Slack, GitHub, AWS keys, bearer tokens) is redacted from it.

**How it runs.** One Agent SDK call in the web service: no tools, a JSON-schema answer, at most $0.50, about a minute. It follows the HR agent's instructions (edit them like any agent's); without HR on the team, the built-in ones, and the page offers **Add HR to the team**. It runs on HR's own model when set, else Pointer's chat model. The cost counts with chat on the Activity page, and a review is refused once the monthly cap is used up, like a chat reply.

**Proposals.** Each is a row with its kind, reason, evidence and what it would change:

| Kind | Example | Apply |
| --- | --- | --- |
| Hire | *Hire a Designer* | Adds the agent in full (role, when it is used, access, model, instructions), with an id made from its name. |
| Change | *Sharpen Reviewer's instructions* | Merges the changed fields into the agent; the page shows each field before and proposed, and flags **More access**. |
| Retire | *Retire Writer* | Disables the agent (two clicks). It is never deleted: turn it back on in the table. |
| Skill | *Add a skill for PDF reports* | Opens the **Skills** page with a search for the need. |

Every applied agent is checked like a save on the Team page. Proposals that are not valid (an agent that fails the checks, an unknown agent or model, a change that changes nothing) are left out, and the review says so. Dismissed proposals stay in the review. The last 20 reviews are kept (`hr/reviews/` in the store); earlier ones are under **Earlier reviews**.

In chat, Pointer may suggest asking HR for a review when someone asks who to hire or what the team lacks.

---

### Admin API rows

| Route | Body / query | Result |
| --- | --- | --- |
| `POST /api/hr/review` | | Runs one HR review (one model call, at most $0.50; refused with `409` when the monthly cap is used up or a review is already running, `400` without the Claude key, `502` when the call fails, with `costUsd`). Returns `{ review }`: `{ id, createdAt, summary, proposals, costUsd, model, instructionsFrom: "team" \| "default", tasksSeen, dropped: [{ kind, why }] }`. Each proposal: `{ id: "p1"…, kind: "hire" \| "change" \| "retire" \| "skill", title, reason, evidence: string[], agent? (hire: a full agent), agentId?, agentName?, changes? (change: the new values), before? (change: the values when HR reviewed), skillNeed? (skill), status: "open" \| "applied" \| "dismissed", decidedAt?, appliedAgentId? }`. |
| `GET /api/hr/reviews` | | `{ reviews }`, the last 20, newest first. |
| `POST /api/hr/reviews/:id/proposals/:pid/apply` | | Applies an open proposal: hire adds the agent with a unique id, change merges the fields into the agent, retire disables it (never deletes), skill only marks it applied. Returns `{ ok, review, proposal, agentId?, skillNeed? }` (`skillNeed` for skills: the Skills page searches `#/skills/find/<need>`). `409` when it was already decided or its agent left the team; `400` when the team would not be valid (for example, full). |
| `POST /api/hr/reviews/:id/proposals/:pid/dismiss` | | Marks an open proposal dismissed. Returns `{ ok, review, proposal }`. |
| `POST /api/hr/agent` | | Adds the default team's HR agent (`id: "hr"`). `409` when it is already on the team. Returns `{ ok, agent }`. |
