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

/** An OpenAI API key (Codex): lists the models, the cheapest call that needs a valid key. */
export async function checkOpenAiKey(apiKey: string): Promise<void> {
  if (skip()) return;
  const res = await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${apiKey}` } }).catch(() => undefined);
  if (!res) throw new Error("Couldn't reach OpenAI to check the key.");
  await res.body?.cancel();
  if (res.status === 401) throw new Error("OpenAI rejected this API key.");
  if (res.status === 403) throw new Error("This OpenAI key cannot list models (HTTP 403): check its project and permissions.");
  if (!res.ok) throw new Error(`OpenAI API check failed (HTTP ${res.status}).`);
}

/** A Gemini API key (Gemini CLI): lists one model, the key in a header, never in the URL. */
export async function checkGeminiKey(apiKey: string): Promise<void> {
  if (skip()) return;
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": apiKey } }).catch(() => undefined);
  if (!res) throw new Error("Couldn't reach Google to check the key.");
  await res.body?.cancel();
  // An unknown key is a 400 (API_KEY_INVALID); a key whose project cannot use the Gemini API is a 403.
  if (res.status === 400 || res.status === 401) throw new Error("Google rejected this Gemini API key.");
  if (res.status === 403) throw new Error("This key cannot use the Gemini API (HTTP 403): create it in Google AI Studio, or enable the Gemini API for its project.");
  if (!res.ok) throw new Error(`Gemini API check failed (HTTP ${res.status}).`);
}
