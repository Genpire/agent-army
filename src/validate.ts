import { slackClient } from "./slack.js";

/** Each check proves a credential works before the wizard saves it. */
const skip = () => process.env.SKIP_VALIDATION === "1";

export async function checkAnthropic(apiKey: string): Promise<void> {
  if (skip()) return;
  const res = await fetch("https://api.anthropic.com/v1/models?limit=1", {
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
  });
  if (res.status === 401 || res.status === 403) throw new Error("Anthropic rejected this API key.");
  if (!res.ok) throw new Error(`Anthropic API check failed (HTTP ${res.status}).`);
}

export async function checkSlack(botToken: string): Promise<{ botUserId: string; teamName: string }> {
  if (skip()) return { botUserId: "UTESTBOT", teamName: "test" };
  try {
    const auth = await slackClient(botToken).auth.test();
    if (!auth.user_id) throw new Error("no bot user");
    return { botUserId: auth.user_id, teamName: auth.team ?? "" };
  } catch (err) {
    throw new Error(`Slack rejected this bot token (${(err as Error).message}).`);
  }
}

export async function checkGithub(token: string): Promise<{ login: string }> {
  if (skip()) return { login: "test" };
  const res = await fetch("https://api.github.com/user", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "agent-army",
    },
  });
  if (res.status === 401) throw new Error("GitHub rejected this token.");
  if (!res.ok) throw new Error(`GitHub check failed (HTTP ${res.status}).`);
  const body = (await res.json()) as { login?: string };
  return { login: body.login ?? "" };
}
