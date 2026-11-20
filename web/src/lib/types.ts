/**
 * The admin API's shapes, taken from the server's own types (type-only
 * imports: nothing from the server ends up in the browser bundle), so the
 * page and the API cannot drift apart.
 */
import type { publicView } from "../../../src/core/config.js";
import type { MemoryFact } from "../../../src/memory.js";
import type { NotesRepo, ProjectNotes } from "../../../src/notes.js";
import type { MondayBoardSummary } from "../../../src/monday.js";
import type { ProgressSnapshot } from "../../../src/progress.js";
import type { CiSummary, Task } from "../../../src/tasks.js";
import type { Access, AgentSpec, Effort, PointerSpec, Team } from "../../../src/team.js";
import type { MonthUsage } from "../../../src/usage.js";

export type { Access, AgentSpec, CiSummary, Effort, MemoryFact, MondayBoardSummary, MonthUsage, PointerSpec, ProgressSnapshot, ProjectNotes, Task, Team };

/** The configuration as the browser sees it: secrets are never included, only whether they are set. */
export type PublicConfig = ReturnType<typeof publicView>;
export type RepoSetupView = PublicConfig["repoSetup"][string];
export type GitHubConnectionView = PublicConfig["github"]["extra"][number];
export type Limits = PublicConfig["limits"];

/** GET /api/state */
export interface AppState {
  setupRequired: boolean;
  authed: boolean;
  /** Claude, Slack and GitHub are connected. */
  ready?: boolean;
  config?: PublicConfig;
  runner?: "local" | "cloudrun";
  storage?: string;
  /** Where Slack sends events: the Request URL of the Slack app. */
  eventsUrl?: string;
  /** Where GitHub sends pull request reviews: the webhook's Payload URL. */
  githubWebhookUrl?: string;
}

/** GET /api/notes */
export interface NotesList {
  notes: Awaited<ReturnType<NotesRepo["list"]>>;
  max: number;
}

/** GET /api/memory */
export interface MemoryList {
  facts: MemoryFact[];
  max: number;
}

// ---------- Chat (conversations with Pointer, repo tasks from the console) ----------

export type {
  ActivityStep,
  ChatMessage,
  Conversation,
  ConversationSummary,
  ConversationView,
  LiveReply,
  TaskMilestone,
} from "../../../src/conversations.js";
export type { CheckItem, CheckState, PhaseInfo, PhaseState, TaskEvent, TaskEventKind, TaskTimeline } from "../../../src/task-events.js";
export type { TaskPhase, TaskReport } from "../../../src/tasks.js";
export type { ActivityKind } from "../../../src/pointer-types.js";

/** GET /api/conversations: newest activity first. */
export interface ConversationList {
  conversations: import("../../../src/conversations.js").ConversationSummary[];
}

/** POST /api/conversations and POST /api/conversations/:id/messages (202). */
export interface ConversationSent {
  conversation: import("../../../src/conversations.js").Conversation;
}

/** POST /api/tasks (202): a repo task straight from the console, in a new conversation. */
export interface DirectTaskStarted {
  conversationId: string;
  taskId: string;
}

/** GET /api/tasks/:id/screenshots; each image is at /api/tasks/:id/screenshots/:name. */
export interface ScreenshotList {
  screenshots: { name: string; size: number }[];
}

/** GET /api/tasks/:id/events: null when the task has no timeline (older tasks, or not started yet). */
export interface TaskEventsView {
  timeline: import("../../../src/task-events.js").TaskTimeline | null;
}

/** The order of a repo task's steps, for the stepper (checked against the server's list). */
export const TASK_PHASE_ORDER = ["clone", "setup", "plan", "build", "verify", "publish", "checks"] as const satisfies readonly import("../../../src/tasks.js").TaskPhase[];

// ---------- AI providers (GET /api/ai/providers) ----------

export type { AiProviderView, AiProvidersView } from "../../../src/routes/ai.js";
export type { ModelPrice, PresetCapabilities, PresetField, PresetKind, PresetModel } from "../../../src/ai-presets.js";
export type { AiProviderId, ModelTier } from "../../../src/core/config.js";

/** The model tiers a provider maps, in the order the page shows them (checked against the server's list). */
export const MODEL_TIER_OPTIONS = ["main", "opus", "sonnet", "haiku", "subagent"] as const satisfies readonly import("../../../src/core/config.js").ModelTier[];

/** The effort levels and access levels, in the order the page offers them (checked against the server's types). */
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[];
export const ACCESS_OPTIONS = ["read", "run", "write"] as const satisfies readonly Access[];
