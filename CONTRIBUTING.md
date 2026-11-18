# Contributing to Agent Army

Thanks for helping. Bug reports, fixes, docs, new integrations and ideas are all welcome.

## Before you start

- **Small fixes** (typos, clear bugs, missing tests): open a pull request directly.
- **Bigger changes** (a new integration, a change to how Pointer or the worker behaves, a new setting): open an [issue](https://github.com/Genpire/agent-army/issues) or a [discussion](https://github.com/Genpire/agent-army/discussions) first, so we can agree on the approach before you write the code.
- **Security problems:** do not open a public issue. Follow [SECURITY.md](SECURITY.md).
- Issues labelled [`good first issue`](https://github.com/Genpire/agent-army/labels/good%20first%20issue) are a good place to start.

## Set up

You need Node.js 22 or newer (`nvm use` reads `.nvmrc`) and git.

```bash
git clone https://github.com/<you>/agent-army.git
cd agent-army
npm install
npm run dev          # admin page on http://localhost:8080, reloads on change
```

The first start prints a one-time setup token in the terminal (`[setup] Open the app and use this one-time setup token: …`). Without `MASTER_KEY`, a development key is generated under `./data`, which is also where config, memory and task records are stored. Delete `./data` to start over.

To try Pointer without Slack, connect Claude on the admin page, then:

```bash
npm run build && node dist/smoke.js "introduce yourself"
```

To try it in Slack, use a test workspace and a tunnel so Slack can reach your machine over HTTPS (for example `cloudflared tunnel --url http://localhost:8080`). Set `PUBLIC_URL` to the tunnel URL, restart, and use **Create Slack app** on the admin page, which pre-fills the manifest. Use an Anthropic key with a low spend limit while developing.

## Checks

Every pull request must pass the same checks CI runs on Node 22 and 24:

```bash
npm run typecheck
npm test
npm run build
```

Tests use [Vitest](https://vitest.dev) and live in `test/`. They never call Claude, Slack, GitHub or monday.com: those clients are faked. Add or update tests for any behaviour you change.

## Guidelines

- **TypeScript, strictly.** Avoid `any`; validate every input from users, Slack and the admin API with [zod](https://zod.dev).
- **Never log secrets or content.** Tokens, keys, message text and file contents stay out of logs. Pass error text through the redactor (`makeRedactor`) before logging or posting it.
- **Keep the security model.** Agents only open pull requests; conversation tools stay read-only unless there is a clear reason, and new tools must respect the GitHub allow lists. Read [Security model](README.md#security-model) before touching `pointer-tools.ts`, `guard.ts` or `worker.ts`.
- **Keep the admin page dependency-free.** `public/index.html` is a single file with no build step; reuse its helpers (`field`, cards, tables) rather than adding a framework.
- **Document what you change.** New settings, API routes or Slack commands go in the README (the [Admin API](README.md#admin-api) table lists every route).
- **Match the surrounding code** in naming, comments and structure. Prefer small, focused files.

## Commits and pull requests

- Write commit messages as [Conventional Commits](https://www.conventionalcommits.org): `feat: …`, `fix: …`, `docs: …`, `test: …`, `refactor: …`, `chore: …`.
- Keep a pull request to one change. Fill in the template: what changed, why, and how you tested it.
- A maintainer reviews every pull request. CI must be green before merging.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
