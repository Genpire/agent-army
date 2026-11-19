# Skills library and the Skills Scout

For the owner to merge into README.md: a section (after "The team") and rows for the Admin API table.

---

## Skills

A **skill** teaches an agent a task: a folder with a `SKILL.md` (YAML frontmatter with `name` and `description`, then instructions) and sometimes scripts or reference files. The team keeps a **skills library**; the Skills page in the admin console shows it, adds skills and finds new ones.

**Add a skill** from a GitHub folder (`https://github.com/<owner>/<repo>/tree/<ref>/<path>`, or the address of its `SKILL.md`) or by pasting a single `SKILL.md`. Every skill is previewed first: its files, frontmatter, licence (the frontmatter's `license` and a `LICENSE`/`LICENSE.txt` file's first line), whether it ships scripts, and anything that blocks it. Nothing is installed until you click **Install**. Public repositories are read without a token; a private one needs a GitHub connection whose allow list covers it. [Anthropic's skills](https://github.com/anthropics/skills) are a good place to start.

**Limits:** at most 50 skills; per skill at most 100 files and 2 MB, text files only (images, fonts, archives and other binaries are refused), relative paths only (no `..`, no absolute paths), and a `name` of lowercase letters, digits and dashes (up to 64) that is the skill's name in its frontmatter. A skill with the same name as an installed one replaces it.

**Who uses it.** A skill goes to **every agent** (agents added later too) or to **chosen agents**; the Team page's agent drawer has a Skills field too. An agent has its skills loaded when it starts work. Pointer can use any installed skill. Removing a skill takes it away from every agent.

**How the team gets them.** A repo task writes the library as a local plugin **next to the checkout, never inside it** (`<work dir>/skills-plugin/`: `.claude-plugin/plugin.json` named `team-skills`, and `skills/<name>/…`), so no skill file can be committed. The Agent SDK loads it (`plugins: [{ type: "local", path, skipMcpDiscovery: true }]`: a plugin's own MCP servers are never read); its skills are named `team-skills:<name>`; each subagent gets its skills preloaded (`AgentDefinition.skills`); Pointer, leading the task, lists only the library's skills (not the CLI's bundled ones, nor a checkout's own) and loads them with the `Skill` tool. Pointer's chat in Slack and the console loads the same plugin from the service's temp folder, rebuilt when the library changes. In chat there is no shell and no file access, so a skill's scripts and reference files only work in repo tasks; in chat its instructions do.

**Trust.** A skill's instructions steer your agents, and in repo tasks its scripts run in the agents' shell like the repository's own code: with the same access, the same command guard and the same environment (the platform's own secrets are not in it, but the task's Claude key and the repository's setup variables are). Install only skills you trust, and read a skill's scripts before installing it. Skill files are kept in the store encrypted with the master key, like project notes.

### Skills Scout

The Skills Scout (an agent on the default team) finds skills for a need. On the Skills page, **Find skills** takes a need ("fill in and merge PDF forms") and runs one Claude query in the web service with web search and fetch only, Anthropic's skills repository first. It returns up to five candidates, each with what it does, why it fits, its licence, whether it runs scripts and which agents should use it. **Preview** opens the add drawer on that folder; installing is always your click. The Scout uses its own instructions from the Team page, at most $0.50 a search; the monthly spending cap applies (a search is refused once it is used up) and the cost counts with chat. `#/skills/find/<need>` opens the page with the need filled in and searched (HR's recommendations link there).

---

## Admin API rows

| Route | Body | Notes |
| --- | --- | --- |
| `GET /api/skills` | | `{ skills, limits }`. Each skill: `{ name, description, source?: { url, repo?, path?, ref? }, license?, files: [{ path, size }], bytes, hasScripts, installedAt, assignedTo }`, by name; `assignedTo` is `"all"` or the ids of the agents whose `skills` list names it. `limits`: `{ maxBytes, maxFiles, maxSkills, maxDirs, maxPathChars, maxSegmentChars, maxDescriptionChars, maxPastedBytes }`. |
| `POST /api/skills/preview` | `{ url }` \| `{ skillMd }` | What an install would add, without installing: `{ preview: { name, description, license?, licenseFile?: { path, title }, source?, files: [{ path, size, binary? }], bytes, hasScripts, frontmatter, skillMd, installed?: { installedAt, source? }, problems } }`. `problems` lists what blocks the install (empty = installable). `url` is a GitHub folder (`…/tree/<ref>/<path>`, `…/blob/<ref>/<path>/SKILL.md` or a repository); read with the GitHub connection allowed to read the repository, else without a token. `skillMd` is at most 256 KB. `400` for a bad address, a folder GitHub does not have (or cannot be read), one over the limits, or a GitHub error. |
| `POST /api/skills/install` | `{ url \| skillMd, assignedTo? }` | Installs the skill (a folder previewed in the last 10 minutes is installed as previewed), replacing one of the same name. `assignedTo`: `"all"` (the default for a new skill; a replaced skill keeps its assignment) or agent ids, whose `skills` lists are updated. Returns `{ ok, skill }`; `400` with the first problem when it cannot be installed. |
| `GET /api/skills/:name` | | `{ skill, skillMd }`; `404` when not installed, `400` for a bad name. |
| `POST /api/skills/:name/assign` | `{ assignedTo }` | `"all"` (every agent, agents added later too; the name leaves the agents' own lists) or agent ids (exactly those agents have it in their `skills`). Returns `{ ok, skill }`; `400` for an unknown agent id, `404` when not installed. |
| `POST /api/skills/:name/delete` | | Removes the skill from the library and from every agent's `skills`; its stored files are blanked. `404` when not installed. |
| `POST /api/skills/find` | `{ need }` | The Skills Scout: one Claude query (web search and fetch only, at most $0.50) for a need of 3 to 1 000 characters. Returns `{ candidates: [{ name, description, url, license?, runsScripts?, why, forAgents? }], costUsd? }`, at most five, each `url` a GitHub folder, `forAgents` existing agent ids. `400` when Claude is not connected, `409` when the monthly spending cap is used up (nothing runs), `502` when the search fails. The cost counts with chat. |

Also: `POST /api/team` agents now carry `skills` (skill names from the library, at most 50) and `avatar`.
