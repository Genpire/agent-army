# Security policy

Agent Army handles API keys, GitHub tokens and private conversations, so we take security reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report it privately through GitHub:

1. Open [Report a vulnerability](https://github.com/Genpire/agent-army/security/advisories/new) (the repository's **Security** tab).
2. Describe the problem, how to reproduce it, and what an attacker could do with it. A proof of concept helps.
3. Leave out real tokens, keys and personal data.

Only the maintainers can read the report. We aim to acknowledge it within five working days, agree on a fix and a disclosure date with you, and credit you in the advisory unless you would rather stay anonymous.

## Supported versions

There are no versioned releases yet. Fixes land on `main`; redeploy from the latest `main` to get them.

## Scope

In scope: the web service, the admin API and page, the worker, the shell guard, credential storage, and the deploy script.

The README's [Security model](README.md#security-model) lists known limits, such as prompt injection through content Pointer reads, and the worker container not being a boundary for platform secrets. A report that shows one of those limits can be exploited further than described there is in scope and welcome.

Vulnerabilities in Claude, Slack, GitHub or monday.com themselves should go to those vendors.
