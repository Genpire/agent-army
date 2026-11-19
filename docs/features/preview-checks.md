### Preview checks

Most teams get a preview deployment for every pull request (Vercel, Netlify and others). After the pull request's [CI checks](#ci-checks), the worker finds that preview and has a verifying agent open the **real preview** in the headless browser (see [Browser checks](#browser-checks)): it walks through what the pull request changed, reads the browser console for errors, takes screenshots and reports whether it looks right.

**When it runs** (**Settings**, `limits.previewCheck`):

- `visible` (the default): only when the pull request changes what people see: markup and components (`.tsx`, `.jsx`, `.vue`, `.svelte`, `.astro`, `.html`, templates), styles (`.css`, `.scss`, `.less`, `styles/`, theme files, Tailwind config), public assets (`public/`, `static/`, `assets/`), and code in page, route, component, layout or view folders (not `api/`). Changes to tests, fixtures, mocks and stories alone do not count.
- `always`: after every pull request the task opens or updates.
- `off`: never.

A check that is not needed costs nothing. The check also needs the worker's browser; without it (for example `BROWSER=off`), the task says the preview could not be opened.

**How the preview is found.** For the pull request's head commit, the worker reads the commit's GitHub deployments, ignores production ones (Vercel names them `Production – <project>`), and takes the newest deployment whose latest status is a success with an environment URL. When a deployment is still building, it waits for it, up to 5 minutes and never past the task's deadline. In a monorepo with several previews (`Preview – web`, `Preview – docs`), the project whose folder the change touches comes first and the others are listed for the agent. When there is no deployment, or the token may not read them, the Vercel bot's comment on the pull request is used instead, if it says the preview is ready and was updated after the head commit.

**The check** is one more round of the team, after the checks and any fix rounds:

- It changes nothing: no code, commits or pushes. Problems are reported, not fixed, and no fix round starts on its own.
- It spends what is left of the task's budget, at most $2, and does not start with less than $0.50 left. It may run for up to 12 minutes and needs at least 4 minutes before the task's deadline.
- Screenshots are named `preview-…` and stored and posted like the other screenshots.

**Where the result shows:**

- a comment on the pull request: *Checked the preview at &lt;url&gt;: …* (or *… and found problems: …*), with what was checked and the number of screenshots;
- a *Preview* line in the Slack result: looks right, problems found, or why it could not be checked;
- in the admin console: a line on the task's card in Chat, a *Preview deployment* section in its timeline, and a *Preview* row in the task's details on the **Activity** page.

When problems are found, reply in the thread (or comment on the pull request) with what to fix, and the team picks it up on the same branch.

**GitHub token permissions.** A fine-grained token needs *Deployments: read* to find the preview, on top of the permissions in [CI checks](#ci-checks). Without it, GitHub answers 403: the worker falls back to the Vercel bot's comment (that needs *Pull requests: read*, which the token already has) and otherwise says the token needs *Deployments: read*. Editing an existing token's permissions on GitHub keeps its value. A classic token with the `repo` scope covers it; a GitHub App needs the *Deployments* read permission.

**Protected previews (Vercel Deployment Protection).** When Vercel asks for a login on previews, give the worker the project's bypass secret:

1. In the Vercel project, open **Settings → Deployment Protection** and, under **Protection Bypass for Automation**, create a secret (or copy the existing one).
2. On the admin page, open **Projects → Repo setup** for the repository and add it as an environment variable: `VERCEL_AUTOMATION_BYPASS_SECRET=<the secret>`.

The secret never goes into the team's prompt. For each check, the worker opens a redirect on `127.0.0.1` (a random port and path) that forwards the browser to the preview with Vercel's `x-vercel-protection-bypass` query parameter and `x-vercel-set-bypass-cookie=true`, so Vercel sets its bypass cookie and the agent then browses the preview normally. The agent is told only the redirect's address and, for commands such as `curl`, to pass the variable by name as the `x-vercel-protection-bypass` header without ever printing it. The secret is sent only to previews Vercel deployed, and it is redacted from everything the worker posts, comments and logs. Like every repo variable, it is readable from the agents' shell (see [Security model](#security-model)): use the bypass secret, never a Vercel token. Without the secret, an agent that meets Vercel's login page reports the check as not possible and says to add it.
