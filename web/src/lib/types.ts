/**
 * The admin API's shapes, taken from the server's own types (type-only
 * imports: nothing from the server ends up in the browser bundle), so the
 * page and the API cannot drift apart.
 */
import type { AiProviderId, FollowupSettings, ROUTE_MAX as SERVER_ROUTE_MAX, WorkKind, publicView } from "../../../src/core/config.js";
import type { MemoryFact } from "../../../src/chat/memory.js";
import type { NotesRepo, ProjectNotes } from "../../../src/chat/notes.js";
import type { MondayBoardSummary } from "../../../src/integrations/monday/monday.js";
import type { ProgressSnapshot } from "../../../src/tasks/progress.js";
import type { ParallelLimit } from "../../../src/tasks/runner.js";
import type { CiSummary, Task } from "../../../src/tasks/tasks.js";
import type { Access, AGENT_FALLBACK_MAX as SERVER_AGENT_FALLBACK_MAX, AgentSpec, Effort, PointerSpec, Team } from "../../../src/team/team.js";
import type { MonthUsage } from "../../../src/spending/usage.js";

export type { Access, AgentSpec, CiSummary, Effort, MemoryFact, MondayBoardSummary, MonthUsage, ParallelLimit, PointerSpec, ProgressSnapshot, ProjectNotes, Task, Team, WorkKind };

// ---------- Routes: which providers each kind of work runs on, in order (config.ai.routes, src/ai/routing.ts) ----------

/** One provider of a route, in its place: whether it can run now, and why not. */
export interface RouteStepView {
  provider: AiProviderId;
  /** "Gemini", "Claude"… */
  name: string;
  ready: boolean;
  /** Why it is skipped now (not connected, incomplete, its monthly cap used up). */
  problem?: string;
}

/** A kind of work's route: the first ready step runs, the next takes over if it fails. */
export interface RouteView {
  /** The owner set it; else the default (chat, routines and light work follow the chat provider, repo tasks the task provider). */
  custom: boolean;
  steps: RouteStepView[];
}

export type RoutesView = Record<WorkKind, RouteView>;

/** POST /api/ai/routes: one kind at a time; `[]` puts it back to the default. */
export interface RouteSaved {
  ok: true;
  routes: RoutesView;
}

/** The kinds of work, in the order the AI model pane shows them (checked against the server's list). */
export const WORK_KIND_OPTIONS = ["chat", "routines", "tasks", "light"] as const satisfies readonly WorkKind[];
/** At most this many providers in one route (the server's ROUTE_MAX). */
export const ROUTE_MAX: typeof SERVER_ROUTE_MAX = 4;
/** At most this many engines take over from an agent's own (the server's AGENT_FALLBACK_MAX). */
export const AGENT_FALLBACK_MAX: typeof SERVER_AGENT_FALLBACK_MAX = 2;

type ServerConfig = ReturnType<typeof publicView>;

/**
 * The configuration as the browser sees it: secrets are never included, only
 * whether they are set. `ai.routes` is optional for a server that does not
 * send it yet: the page then shows each kind's default (aiRoutes.ts routesOf).
 * `followups` (the reminder settings, config.followups) is optional for the
 * same reason: the Follow-ups page then uses the list's own copy, else the defaults.
 */
export type PublicConfig = Omit<ServerConfig, "ai"> & { ai: ServerConfig["ai"] & { routes?: RoutesView }; followups?: FollowupSettings };
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
  /** Tasks at the same time: the setting, and the local runner's cap (MAX_PARALLEL or the instance's memory). */
  parallel?: ParallelLimit;
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
} from "../../../src/chat/conversations.js";
export type { CheckItem, CheckState, PhaseInfo, PhaseState, TaskEvent, TaskEventKind, TaskTimeline } from "../../../src/tasks/task-events.js";
export type { TaskPhase, TaskReport } from "../../../src/tasks/tasks.js";
export type { ActivityKind } from "../../../src/chat/pointer-types.js";

/** GET /api/conversations: newest activity first. */
export interface ConversationList {
  conversations: import("../../../src/chat/conversations.js").ConversationSummary[];
}

/** POST /api/conversations and POST /api/conversations/:id/messages (202). */
export interface ConversationSent {
  conversation: import("../../../src/chat/conversations.js").Conversation;
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
  timeline: import("../../../src/tasks/task-events.js").TaskTimeline | null;
}

/** The order of a repo task's steps, for the stepper (checked against the server's list). */
export const TASK_PHASE_ORDER = ["clone", "setup", "plan", "build", "verify", "publish", "checks"] as const satisfies readonly import("../../../src/tasks/tasks.js").TaskPhase[];

// ---------- AI providers (GET /api/ai/providers) ----------

export type { AiProviderView, AiProvidersView } from "../../../src/routes/ai.js";
export type { ModelPrice, PresetCapabilities, PresetField, PresetKind, PresetModel } from "../../../src/ai/ai-presets.js";
export type { AiProviderId, ModelTier } from "../../../src/core/config.js";
/** A source's models (GET /api/ai/providers/:id/models, GET /api/engines/:id/models). */
export type { CatalogModel, ModelList } from "../../../src/ai/model-catalog.js";

/** The model tiers a provider maps, in the order the page shows them (checked against the server's list). */
export const MODEL_TIER_OPTIONS = ["main", "opus", "sonnet", "haiku", "subagent"] as const satisfies readonly import("../../../src/core/config.js").ModelTier[];

/** The effort levels and access levels, in the order the page offers them (checked against the server's types). */
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[];
export const ACCESS_OPTIONS = ["read", "run", "write"] as const satisfies readonly Access[];
