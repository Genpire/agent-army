import { describe, expect, it } from "vitest";
import { type CliOutcome, agentLine, engineFailure, failureInText, failureScope } from "../../src/ai/engine-fallback.js";

/** The kind a failed run of `engine` is put down to, from its failure event alone. */
const kindOf = (engine: CliOutcome["engine"], failure: string, o: Partial<CliOutcome> = {}) => engineFailure({ engine, code: 1, failure, ...o })?.kind;

describe("an agent's line of engines", () => {
  it("is its engine, then its fallback up to Claude, each engine once", () => {
    expect(agentLine({ engine: "gemini", engineModel: "gemini-4-pro", fallback: [{ engine: "codex", model: " gpt-6.2-sol " }] })).toEqual({
      steps: [
        { engine: "gemini", model: "gemini-4-pro" },
        { engine: "codex", model: "gpt-6.2-sol" },
      ],
      claude: false,
    });
    // Nothing after Claude runs; a repeat is skipped.
    expect(
      agentLine({
        engine: "codex",
        engineModel: "",
        fallback: [
          { engine: "codex", model: "x" },
          { engine: "claude", model: "" },
        ],
      }),
    ).toEqual({ steps: [{ engine: "codex", model: "" }], claude: true });
    expect(agentLine({ engine: "codex", engineModel: "", fallback: [{ engine: "claude", model: "" }, { engine: "gemini", model: "" }] }).steps).toHaveLength(1);
    expect(agentLine({ engine: "claude", engineModel: "", fallback: [{ engine: "codex", model: "" }] })).toEqual({ steps: [], claude: true });
    // Saved before fallbacks existed.
    expect(agentLine({ engine: "gemini", engineModel: "" })).toEqual({ steps: [{ engine: "gemini", model: "" }], claude: false });
  });
});

describe("failures of the engine, not of the work", () => {
  it("reads Gemini CLI's errors: Google's message and status in its error result, its error class and its exit code", () => {
    // Gemini CLI's own formatting: "[API Error: <message> (Status: <status>)]", with its advice after a 429.
    const exhausted = "[API Error: Resource has been exhausted (e.g. check quota). (Status: RESOURCE_EXHAUSTED)]\nPlease wait and try again later. To increase your limits, request a quota increase through AI Studio, or switch to another /auth method";
    expect(kindOf("gemini", exhausted)).toBe("rate_limit");
    expect(
      kindOf(
        "gemini",
        "[API Error: You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-4-pro (Status: RESOURCE_EXHAUSTED)]",
      ),
    ).toBe("quota");
    expect(kindOf("gemini", "You have exhausted your daily quota on this model.")).toBe("quota");
    expect(kindOf("gemini", "[API Error: API key not valid. Please pass a valid API key. (Status: INVALID_ARGUMENT)]")).toBe("auth");
    expect(kindOf("gemini", "[API Error: API key expired. Please renew the API key. (Status: INVALID_ARGUMENT)]")).toBe("auth");
    expect(kindOf("gemini", "[API Error: Your API key was reported as leaked. Please use another API key. (Status: PERMISSION_DENIED)]")).toBe("auth");
    expect(kindOf("gemini", "[API Error: User location is not supported for the API use. (Status: FAILED_PRECONDITION)]")).toBe("auth");
    expect(kindOf("gemini", "[API Error: Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio. (Status: FAILED_PRECONDITION)]")).toBe(
      "billing",
    );
    expect(kindOf("gemini", "[API Error: The model is overloaded. Please try again later. (Status: UNAVAILABLE)]")).toBe("unavailable");
    expect(kindOf("gemini", "[API Error: An internal error has occurred. Please retry or report in https://developers.generativeai.google/guide/troubleshooting (Status: INTERNAL)]")).toBe(
      "unavailable",
    );
    expect(kindOf("gemini", "[API Error: Deadline expired before operation could complete. (Status: DEADLINE_EXCEEDED)]")).toBe("unavailable");
    expect(
      kindOf("gemini", "[API Error: models/gemini-9-ultra is not found for API version v1beta, or is not supported for generateContent. Call ListModels to see the list of available models. (Status: NOT_FOUND)]"),
    ).toBe("model");
    // The JSON the genai SDK sometimes passes through whole.
    expect(kindOf("gemini", '[API Error: {"error":{"code":429,"message":"Resource has been exhausted (e.g. check quota).","status":"RESOURCE_EXHAUSTED"}}]')).toBe("rate_limit");
    expect(kindOf("gemini", 'got status: 503 Service Unavailable. {"error":{"code":503,"message":"The service is currently unavailable.","status":"UNAVAILABLE"}}')).toBe("unavailable");

    // Its error classes, whatever the message says.
    expect(kindOf("gemini", "Usage limit reached.", { failureType: "TerminalQuotaError" })).toBe("quota");
    expect(kindOf("gemini", "Please retry in 41.2s.", { failureType: "RetryableQuotaError" })).toBe("rate_limit");
    expect(kindOf("gemini", "Model not found", { failureType: "ModelNotFoundError" })).toBe("model");
    // Exit 41: its sign-in failed (FatalAuthenticationError).
    expect(engineFailure({ engine: "gemini", code: 41, failure: "the run failed" })?.kind).toBe("auth");
    expect(engineFailure({ engine: "codex", code: 41, failure: "the run failed" })).toBeUndefined();
  });

  it("reads Codex's errors: its own messages and the OpenAI API's statuses and bodies", () => {
    expect(kindOf("codex", "exceeded retry limit, last status: 429 Too Many Requests, request id: req_123")).toBe("rate_limit");
    expect(kindOf("codex", "rate limit exceeded: Rate limit reached for gpt-6.2-sol in organization org-x on tokens per min (TPM): Limit 30000, Used 29000, Requested 4000.")).toBe(
      "rate_limit",
    );
    expect(kindOf("codex", "Quota exceeded. Check your plan and billing details.")).toBe("quota");
    expect(kindOf("codex", "You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again later.")).toBe("quota");
    expect(kindOf("codex", 'unexpected status 429 Too Many Requests: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota","code":"insufficient_quota"}}')).toBe(
      "quota",
    );
    expect(kindOf("codex", "Your API project has reached its spend limit.")).toBe("billing");
    expect(kindOf("codex", "Your workspace is out of credits. Add credits to continue.")).toBe("billing");
    expect(
      kindOf(
        "codex",
        'unexpected status 401 Unauthorized: {"error":{"message":"Incorrect API key provided: sk-proj-****cdef. You can find your API key at https://platform.openai.com/account/api-keys.","type":"invalid_request_error","code":"invalid_api_key"}}, url: https://api.openai.com/v1/responses',
      ),
    ).toBe("auth");
    expect(kindOf("codex", "unexpected status 403 Forbidden: Unknown error, auth error: missing scope")).toBe("auth");
    expect(
      kindOf("codex", 'unexpected status 404 Not Found: {"error":{"message":"The model `gpt-9` does not exist or you do not have access to it.","type":"invalid_request_error","code":"model_not_found"}}'),
    ).toBe("model");
    expect(kindOf("codex", "unexpected status 400 Bad Request: {\"detail\":\"The 'gpt-9' model is not supported when using Codex with a ChatGPT account.\"}")).toBe("model");
    expect(kindOf("codex", "Selected model is at capacity. Please try a different model.")).toBe("unavailable");
    expect(kindOf("codex", "We’re currently experiencing high demand, which may cause temporary errors.")).toBe("unavailable");
    expect(kindOf("codex", "exceeded retry limit, last status: 503 Service Unavailable")).toBe("unavailable");
    expect(kindOf("codex", "stream disconnected before completion: error sending request for url (https://api.openai.com/v1/responses)")).toBe("unavailable");
  });

  it("leaves the work's own failures where they are", () => {
    // The work's: the context window, a content filter, a turn limit, a failed command, a bad request of its own.
    expect(kindOf("codex", "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.")).toBeUndefined();
    expect(kindOf("codex", "stream disconnected before completion: Incomplete response returned, reason: content_filter")).toBeUndefined();
    expect(kindOf("gemini", "Reached max session turns for this session.")).toBeUndefined();
    expect(kindOf("codex", 'unexpected status 400 Bad Request: {"error":{"message":"Invalid schema for function \'shell\'","type":"invalid_request_error"}}')).toBeUndefined();
    expect(kindOf("codex", "the turn failed")).toBeUndefined();
    // Numbers in the work's own words are not statuses.
    expect(kindOf("codex", "npm test exited with 1: expected 200, got 429 in rate.test.ts:401")).toBeUndefined();
    expect(kindOf("gemini", "Error: tests failed (3 failing). See test/api.test.ts line 503.")).toBeUndefined();
    // An error class means nothing next to the work's own trouble.
    expect(kindOf("gemini", "Reached the context window limit.", { failureType: "TerminalQuotaError" })).toBeUndefined();
  });

  it("decides by the CLI's failure first, and only without one by what it said along the way and on stderr", () => {
    // A rate limit it retried past does not decide a failure it explained otherwise.
    expect(engineFailure({ engine: "codex", code: 1, failure: "Codex ran out of room in the model's context window.", lastError: "Reconnecting... 2/5 (exceeded retry limit, last status: 429 Too Many Requests)" })).toBeUndefined();
    // No words of its own (or the parsers' placeholder): its last error, then stderr.
    expect(engineFailure({ engine: "codex", code: 1, failure: "the turn failed", lastError: "exceeded retry limit, last status: 502 Bad Gateway" })?.kind).toBe("unavailable");
    expect(engineFailure({ engine: "gemini", code: 1, stderr: "Error when talking to Gemini API\n[API Error: API key not valid. Please pass a valid API key. (Status: INVALID_ARGUMENT)]" })?.kind).toBe("auth");
    expect(engineFailure({ engine: "gemini", code: 3, stderr: "fatal: the key [redacted] was refused" })).toBeUndefined();
    expect(engineFailure({ engine: "codex", code: 1 })).toBeUndefined();
  });

  it("says why, short, with the CLI's own line", () => {
    const f = failureInText("Error when talking to the API\n[API Error: The model is overloaded. Please try again later. (Status: UNAVAILABLE)]")!;
    expect(f).toEqual({ kind: "unavailable", reason: "the service was unavailable", detail: "[API Error: The model is overloaded. Please try again later. (Status: UNAVAILABLE)]" });
    expect(failureInText(`unexpected status 503 Service Unavailable: ${"x".repeat(500)}`)!.detail!.length).toBeLessThanOrEqual(200);
    expect(failureInText("")).toBeUndefined();
  });

  it("reaches as far as the failure does: a key or credit is the engine's, a limit or outage the model's, a refusal here the line's", () => {
    expect(failureScope("auth")).toBe("engine");
    expect(failureScope("billing")).toBe("engine");
    for (const kind of ["quota", "rate_limit", "model", "unavailable"] as const) expect(failureScope(kind)).toBe("model");
    expect(failureScope("cannot_run")).toBe("line");
  });
});
