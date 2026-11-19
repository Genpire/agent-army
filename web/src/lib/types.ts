/**
 * The admin API's shapes, taken from the server's own types (type-only
 * imports: nothing from the server ends up in the browser bundle), so the
 * page and the API cannot drift apart.
 */
import type { publicView } from "../../../src/config.js";
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

/** The effort levels and access levels, in the order the page offers them (checked against the server's types). */
export const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const satisfies readonly Effort[];
export const ACCESS_OPTIONS = ["read", "run", "write"] as const satisfies readonly Access[];
