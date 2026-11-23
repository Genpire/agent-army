import { describe, expect, it } from "vitest";
import { sessionSecrets } from "../../src/ai/ai-providers.js";
import { makeRedactor } from "../../src/tasks/worker.js";

describe("a session's own credentials", () => {
  it("are hidden like the config's, the Gemini bridge's session token included", () => {
    const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:41234", ANTHROPIC_AUTH_TOKEN: "gbt_example-session-token-0123456789", ANTHROPIC_API_KEY: "", PATH: "/usr/bin" };
    expect(sessionSecrets(env)).toEqual(["gbt_example-session-token-0123456789"]);
    const redact = makeRedactor(sessionSecrets(env));
    expect(redact("token=gbt_example-session-token-0123456789 base=http://127.0.0.1:41234")).not.toContain("gbt_example-session-token");
  });
});
