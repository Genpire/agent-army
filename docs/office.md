## The Office

The **Office** page (`#/office`) shows your team as people at their desks: Pointer at the front, one desk for every enabled agent, HR in the HR corner, a meeting table, a kitchen and the skills library shelf (it opens the Skills page). It is re-read every 3 seconds while the tab is visible.

Each person has a face (a DiceBear "Notionists" portrait, CC0 art, drawn from a seed), a name tag and a ring in the colour of what they are doing:

| Ring | State | When |
| --- | --- | --- |
| Green, check | Free | Nothing running for them. |
| Blue, bolt | Working | They work on a repo task now. A speech bubble says what ("Editing src/components/Header.tsx", "Running npm test", "Checking the preview in the browser") and which task; their monitor lights up. |
| Purple, speech | Thinking | Pointer is answering you in Chat. |
| Orange, people | In a meeting | A repo task with two or more agents is a meeting: Pointer and everyone who took part sit at the meeting table, and a card shows the task (`acme/web · Dark mode toggle · step 3 of 5`), the plan's progress and what the one working is doing. A second meeting at the same time uses the kitchen table. |

Click someone to open their card: what they do and when Pointer uses them, access, model and effort, skills, today's tasks and minutes, the task they work on now (the same card as in Chat, with its live timeline), their last five tasks, **Ask Pointer for work** (starts a conversation, prefilled "Ask Sara to …"), **Edit on the Team page** and **Change face** (pick another seed; saved with the team). `#/office/<agent id>` opens a card directly.

The composer under the office starts a conversation with Pointer, like Chat. On a phone, or when you pick **List**, the office is a list of the same people and meetings.

An agent's face seed is the `avatar` field of its team entry (empty: its id). Motion (monitors, steam, people walking to the table) stops when the system asks for reduced motion.

### API

| Route | Body | What it does |
| --- | --- | --- |
| `GET /api/office` | `?tz=` (the browser's `Date#getTimezoneOffset()`, minutes; "today" starts at that midnight) | `{ people, meetings, updatedAt }`. `people`: Pointer (`kind: "lead"`, id `pointer`) then every enabled agent, each `{ id, name, role, emoji, avatar, kind, state, doing?, task?, conversation?, since?, today: { tasks, minutes } }`; `state` is `free`, `working`, `thinking` or `meeting`; `task` is `{ id, repo, title, channel, conversationId? }`; `conversation` (`{ id, title }`) is the console conversation Pointer is answering. `meetings`: `[{ taskId, title, repo, channel, conversationId?, step, plan: { done, total }, people, since }]`, one per running task with two or more agents (`people`: Pointer first). Read from the 30 most recent tasks, the active tasks' timelines and the conversation index; a task not saved for 3 hours and an answer pending for 15 minutes are left out. |
