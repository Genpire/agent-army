import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/core/config.js";
import { configSecrets, makeRedactor } from "../../src/tasks/worker.js";

/**
 * makeRedactor(configSecrets(config)) is what keeps credentials out of logs,
 * PR texts and Slack messages. Every credential the config can hold is set
 * here to its own value: each must be redacted, and plain text must stay
 * as it is.
 */

const SECRETS = {
  anthropic: "sk-ant-acme-placeholder-anthropic",
  slackBot: "xoxb-acme-placeholder-bot-token",
  slackSigning: "acme-placeholder-slack-signing",
  monday: "acme-placeholder-monday-token",
  mondayHook: "acme-placeholder-monday-hook-secret",
  github: "ghp_acmeplaceholdergithubtoken0000",
  githubHook: "acme-placeholder-github-hook-secret",
  gitlab: "glpat-acme-placeholder-gitlab",
  gitlabHook: "acme-placeholder-gitlab-hook-secret",
  bitbucket: "ATATT-acme-placeholder-bitbucket",
  bitbucketHook: "acme-placeholder-bitbucket-hook-secret",
  jira: "acme-placeholder-jira-token",
  jiraHook: "acme-placeholder-jira-hook-secret0",
  miro: "acme-placeholder-miro-token",
  appBearer: "acme-placeholder-app-bearer",
  appHeaderKey: "acme-placeholder-header-key",
  appAccess: "acme-placeholder-oauth-access",
  appRefresh: "acme-placeholder-oauth-refresh",
  appClientSecret: "acme-placeholder-oauth-client-secret",
  bedrock: "acme-placeholder-bedrock-key",
  codex: "acme-placeholder-codex-key",
  gemini: "acme-placeholder-gemini-key",
  smtp: "acme-placeholder-smtp-pass",
  resend: "re_acme_placeholder_resend",
  sendgrid: "SG.acme-placeholder-sendgrid",
  dsBearer: "acme-placeholder-ds-bearer",
  dsBasic: "acme-placeholder-ds-basic",
  dsHeader: "acme-placeholder-ds-header",
  dsLogin: "acme-placeholder-ds-login",
  postgres: "postgres://reader:acme-placeholder-pg@db.example.com/app",
  repoVar: "acme-placeholder-repo-variable",
};

const app = (id: string, auth: unknown) => ({ id, name: id, url: "https://mcp.example.com/mcp", auth });
const httpSource = (id: string, auth: unknown) => ({ id, name: id, kind: "http", http: { baseUrl: "https://api.example.com", auth } });

function fullConfig() {
  const c = ConfigSchema.parse({
    github: { token: SECRETS.github, allowedOwners: ["acme"], webhookSecret: SECRETS.githubHook },
    monday: { token: SECRETS.monday, automation: { webhookSecret: SECRETS.mondayHook } },
    gitlab: { token: SECRETS.gitlab, webhookSecret: SECRETS.gitlabHook },
    bitbucket: { token: SECRETS.bitbucket, email: "octo-dev@example.com", webhookSecret: SECRETS.bitbucketHook },
    jira: { siteUrl: "https://acme.atlassian.net", email: "octo-dev@example.com", token: SECRETS.jira, automation: { webhookSecret: SECRETS.jiraHook } },
    miro: { token: SECRETS.miro },
    ai: { providers: { bedrock: { secrets: { apiKey: SECRETS.bedrock } } } },
    engines: { codex: { apiKey: SECRETS.codex }, gemini: { apiKey: SECRETS.gemini } },
    email: { provider: "smtp", smtp: { host: "smtp.example.com", pass: SECRETS.smtp }, resend: { apiKey: SECRETS.resend }, sendgrid: { apiKey: SECRETS.sendgrid } },
    apps: [
      app("app-bearer", { type: "bearer", token: SECRETS.appBearer }),
      app("app-headers", { type: "headers", headers: { Authorization: `Token token=${SECRETS.appHeaderKey}` } }),
      app("app-oauth", { type: "oauth", oauth: { tokens: { access_token: SECRETS.appAccess, refresh_token: SECRETS.appRefresh }, clientInformation: { client_id: "acme-client", client_secret: SECRETS.appClientSecret } } }),
    ],
    dataSources: [
      httpSource("ds-bearer", { type: "bearer", token: SECRETS.dsBearer }),
      httpSource("ds-basic", { type: "basic", username: "reader", password: SECRETS.dsBasic }),
      httpSource("ds-header", { type: "header", name: "X-Api-Key", value: SECRETS.dsHeader }),
      httpSource("ds-login", { type: "login", loginUrl: "https://api.example.com/login", username: "reader", password: SECRETS.dsLogin }),
      { id: "ds-pg", name: "Warehouse", kind: "postgres", postgres: { connectionString: SECRETS.postgres } },
    ],
    repoSetup: { "acme/web": { env: { API_TOKEN: SECRETS.repoVar, NODE_ENV: "development", PORT: "3000" } } },
  });
  c.anthropic.apiKey = SECRETS.anthropic;
  c.slack.botToken = SECRETS.slackBot;
  c.slack.signingSecret = SECRETS.slackSigning;
  return c;
}

describe("configSecrets and makeRedactor", () => {
  it("redacts every credential the config holds", () => {
    const redact = makeRedactor(configSecrets(fullConfig()));
    for (const [name, secret] of Object.entries(SECRETS)) {
      const text = redact(`fatal: could not use ${secret} here`);
      expect(text, name).not.toContain(secret);
      expect(text, name).toContain("[redacted]");
    }
  });

  it("redacts the Basic forms of the code hosts' and Jira's tokens", () => {
    const redact = makeRedactor(configSecrets(fullConfig()));
    const basic = (user: string, token: string) => Buffer.from(`${user}:${token}`).toString("base64");
    for (const form of [basic("oauth2", SECRETS.gitlab), basic("x-token-auth", SECRETS.bitbucket), basic("octo-dev@example.com", SECRETS.bitbucket), basic("octo-dev@example.com", SECRETS.jira)]) {
      const text = redact(`Authorization: Basic ${form}`);
      expect(text).not.toContain(form);
      expect(text).toContain("[redacted]");
    }
  });

  it("leaves plain text and the settings that are not secret as they are", () => {
    const redact = makeRedactor(configSecrets(fullConfig()));
    const plain = "Build 3000 on development for acme/web at https://api.example.com as reader (octo-dev@example.com, acme-client)";
    expect(redact(plain)).toBe(plain);
  });

  it("skips values too short to be a credential, which would garble every text", () => {
    const redact = makeRedactor(["abc12", "", undefined, "abcdef"]);
    expect(redact("abc12 and abcdef")).toBe("abc12 and [redacted]");
  });
});
