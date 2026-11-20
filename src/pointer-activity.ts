import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ActivityKind, PointerActivity } from "./pointer-types.js";
import type { Team } from "./team/team.js";

/**
 * Turns Pointer's Agent SDK stream into live activity for the admin console:
 * the answer text as it is written (partial messages), and each tool use or
 * delegation with a friendly label ("Searching the web for …", "Reading
 * acme/web: src/app.tsx", "Asking Rita (Researcher)…"). Pure apart from the
 * small state it keeps to know which steps happen inside a delegation.
 */

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** One line, at most `max` characters, for a label. */
function short(text: string, max = 80): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const quoted = (text: string, max = 80) => `“${short(text, max)}”`;

/** "https://example.com/docs/page?x=1" → "example.com/docs/page". */
function urlLabel(url: string): string {
  try {
    const u = new URL(url);
    return short(`${u.host}${u.pathname === "/" ? "" : u.pathname}`, 90);
  } catch {
    return short(url, 90);
  }
}

/** A team member by subagent type: "Rita (Researcher)", or a generic name for the SDK's built-in helpers. */
export function agentName(team: Pick<Team, "agents">, subagentType: string | undefined): string {
  const agent = team.agents.find((a) => a.id === subagentType);
  if (!agent) return subagentType ? short(subagentType, 40) : "a helper";
  return agent.name === agent.role ? agent.name : `${agent.name} (${agent.role})`;
}

const POINTER_TOOL = /^mcp__pointer__(.+)$/;

/** What a tool use does, in words, and what it is about. */
export function toolLabel(name: string, input: Record<string, unknown>, team: Pick<Team, "agents">): { label: string; kind: ActivityKind } {
  if (name === "Agent" || name === "Task") {
    const who = agentName(team, str(input.subagent_type) || undefined);
    const what = str(input.description);
    return { label: `Asking ${who}${what ? `: ${short(what, 70)}` : "…"}`, kind: "agent" };
  }
  if (name === "WebSearch") return { label: str(input.query) ? `Searching the web for ${quoted(str(input.query))}` : "Searching the web", kind: "web" };
  if (name === "WebFetch") return { label: str(input.url) ? `Reading ${urlLabel(str(input.url))}` : "Reading a web page", kind: "web" };

  const tool = name.match(POINTER_TOOL)?.[1] ?? name;
  const repo = short(str(input.repo), 100);
  const onRepo = repo ? ` on ${repo}` : "";
  switch (tool) {
    case "github_list_repos":
      return { label: str(input.owner) ? `Listing ${short(str(input.owner), 60)}'s repositories` : "Listing repositories", kind: "github" };
    case "github_recent_commits":
      return { label: `Reading recent commits${onRepo}`, kind: "github" };
    case "github_list_pull_requests":
      return { label: `Listing pull requests${onRepo}`, kind: "github" };
    case "github_list_issues":
      return { label: `Listing issues${onRepo}`, kind: "github" };
    case "github_read_file": {
      const path = short(str(input.path), 120);
      return { label: `Reading ${repo || "a repository"}${path ? `: ${path}` : " (root)"}`, kind: "github" };
    }
    case "github_search_code":
      return { label: `Searching code for ${quoted(str(input.query), 60)}${repo ? ` in ${repo}` : ""}`, kind: "github" };
    case "project_notes_read":
      return { label: `Reading the project notes${repo ? ` for ${repo}` : ""}`, kind: "notes" };
    case "project_notes_add":
      return { label: `Adding to the project notes${repo ? ` for ${repo}` : ""}`, kind: "notes" };
    case "memory_save":
      return { label: "Saving a memory", kind: "memory" };
    case "memory_forget":
      return { label: "Forgetting a memory", kind: "memory" };
    case "start_repo_task":
      return { label: `Starting a repo task${onRepo}`, kind: "task" };
    case "repo_task_status":
      return { label: "Checking how the repo tasks are going", kind: "task" };
    case "monday_list_boards":
      return { label: "Listing monday.com boards", kind: "monday" };
    case "monday_get_board":
      return { label: "Reading a monday.com board", kind: "monday" };
    case "monday_search_items":
      return { label: str(input.text) ? `Searching monday.com for ${quoted(str(input.text), 60)}` : "Searching monday.com", kind: "monday" };
    case "monday_find_users":
      return { label: "Looking up monday.com people", kind: "monday" };
    case "monday_create_item":
      return { label: str(input.name) ? `Creating a monday.com item: ${short(str(input.name), 60)}` : "Creating a monday.com item", kind: "monday" };
    case "monday_update_item":
      return { label: "Updating a monday.com item", kind: "monday" };
    case "monday_add_comment":
      return { label: "Commenting on a monday.com item", kind: "monday" };
    case "monday_get_item":
      return { label: "Reading a monday.com item", kind: "monday" };
    case "monday_attach_files":
      return { label: "Attaching a monday.com item's files", kind: "monday" };
    default:
      return { label: `Using ${short(tool.replace(/^mcp__[^_]+__/, "").replace(/_/g, " "), 60)}`, kind: "other" };
  }
}

/**
 * Feeds SDK messages one at a time and returns the activity they mean. Text
 * deltas count only for Pointer's own answer (not its team members'); a new
 * Pointer turn resets the text, since the answer is the last turn's text.
 */
export class ActivityMapper {
  /** Delegation tool-use id → the team member's name. */
  private readonly delegations = new Map<string, string>();
  private readonly open = new Set<string>();

  constructor(private readonly team: Pick<Team, "agents">) {}

  feed(message: SDKMessage): PointerActivity[] {
    if (message.type === "stream_event") {
      if (message.parent_tool_use_id !== null) return [];
      const event = message.event;
      if (event.type === "message_start") return [{ type: "turn" }];
      if (event.type === "content_block_delta" && event.delta.type === "text_delta" && event.delta.text) {
        return [{ type: "text", delta: event.delta.text }];
      }
      return [];
    }
    if (message.type === "assistant") {
      const out: PointerActivity[] = [];
      const agent = message.parent_tool_use_id === null ? undefined : this.delegations.get(message.parent_tool_use_id);
      // Inside a delegation nobody is tracking (e.g. a nested one), steps are left out.
      if (message.parent_tool_use_id !== null && !agent) return [];
      for (const block of message.message.content) {
        if (block.type !== "tool_use" || this.open.has(block.id)) continue;
        const input = isRecord(block.input) ? block.input : {};
        const { label, kind } = toolLabel(block.name, input, this.team);
        if (kind === "agent" && !agent) this.delegations.set(block.id, agentName(this.team, str(input.subagent_type) || undefined));
        this.open.add(block.id);
        out.push({ type: "step", id: block.id, label, kind, ...(agent ? { agent } : {}) });
      }
      return out;
    }
    if (message.type === "user") {
      const content = message.message.content;
      if (!Array.isArray(content)) return [];
      const out: PointerActivity[] = [];
      for (const block of content) {
        if (!isRecord(block) || block.type !== "tool_result") continue;
        const id = str(block.tool_use_id);
        if (!this.open.delete(id)) continue;
        out.push({ type: "step-done", id, isError: block.is_error === true });
      }
      return out;
    }
    return [];
  }
}
