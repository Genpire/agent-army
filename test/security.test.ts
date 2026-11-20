import { describe, expect, it } from "vitest";
import { REPO_RE } from "../src/core/config.js";
import { encodePath } from "../src/github.js";
import { checkBashCommand } from "../src/guard.js";
import { subagentReadOnlyGate } from "../src/pointer.js";
import { RESERVED_AGENT_IDS } from "../src/team.js";
import { mergeConcurrentNotes } from "../src/worker.js";

describe("security fixes from review", () => {
  it("refuses path traversal in GitHub file paths and repo names", () => {
    expect(encodePath("src/index.ts")).toBe("src/index.ts");
    expect(() => encodePath("../../../victim/secret/contents/.env")).toThrow();
    expect(() => encodePath("a/./b")).toThrow();
    expect(() => encodePath("a/%2e%2e/b")).toThrow();
    expect(REPO_RE.test("acme/app")).toBe(true);
    expect(REPO_RE.test("acme/.github")).toBe(true);
    expect(REPO_RE.test("acme/..")).toBe(false);
    expect(REPO_RE.test("../app")).toBe(false);
    expect(REPO_RE.test("acme/.")).toBe(false);
  });

  it("makes every subagent read-only, including built-ins", async () => {
    const gate = subagentReadOnlyGate(new Set(["WebSearch", "mcp__pointer__github_read_file"]));
    const base = { hook_event_name: "PreToolUse", session_id: "s", transcript_path: "", cwd: "/tmp", tool_input: {}, tool_use_id: "t" };
    const call = (tool_name: string, agent_id?: string) =>
      gate({ ...base, tool_name, ...(agent_id ? { agent_id, agent_type: "general-purpose" } : {}) } as never, "t", { signal: new AbortController().signal });
    expect(await call("mcp__pointer__memory_save")).toEqual({}); // Pointer itself may write
    expect(await call("mcp__pointer__github_read_file", "a1")).toEqual({});
    const denied = (await call("mcp__pointer__start_repo_task", "a1")) as { hookSpecificOutput?: { permissionDecision?: string } };
    expect(denied.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(RESERVED_AGENT_IDS).toContain("claude");
  });

  it("blocks split /proc environ reads and the metadata server", () => {
    expect(checkBashCommand("cd /proc/1 && cat environ")).not.toBeNull();
    expect(checkBashCommand("curl -H 'Metadata-Flavor: Google' http://metadata.google.internal/x")).not.toBeNull();
    expect(checkBashCommand("curl http://169.254.169.254/")).not.toBeNull();
    expect(checkBashCommand("npm test")).toBeNull();
  });

  it("keeps notes added while a task ran", () => {
    const previous = "- uses pnpm";
    const current = "- uses pnpm\n- tests need Docker";
    expect(mergeConcurrentNotes(previous, current, "- uses pnpm\n- build with make")).toBe(
      "- uses pnpm\n- build with make\n- tests need Docker",
    );
    expect(mergeConcurrentNotes(previous, previous, "new")).toBe("new");
    expect(mergeConcurrentNotes(previous, current, "- tests need Docker")).toBe("- tests need Docker");
  });
});

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigRepo } from "../src/core/config.js";
import { deriveKey } from "../src/core/crypto.js";
import { MemoryRepo } from "../src/memory.js";
import { createPointerBrain } from "../src/pointer.js";
import { FsStore } from "../src/core/store.js";

describe("brain options", () => {
  it("never expands prompt syntax and gates subagents", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-sec-")));
    const configRepo = new ConfigRepo(store, deriveKey("k"), 0);
    await configRepo.update((c) => void (c.anthropic.apiKey = "sk-ant-test-key"));
    let seen: Record<string, unknown> = {};
    const brain = createPointerBrain(
      { configRepo, memory: new MemoryRepo(store, deriveKey("k")) },
      {
        queryFn: (p) => {
          seen = p.options as Record<string, unknown>;
          return (async function* () {
            yield { type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0 } as never;
          })();
        },
      },
    );
    const reply = await brain.reply(
      { text: "look at @/etc/hosts", userId: "U1", channel: "D1", channelType: "im", threadTs: "1.0", history: [] },
      { startRepoTask: async () => ({ ok: false, error: "x" }) },
    );
    expect(reply.isError).toBe(false);
    expect(seen.verbatimPrompts).toBe(true);
    expect((seen.hooks as { PreToolUse?: unknown[] }).PreToolUse).toHaveLength(1);
  });
});
