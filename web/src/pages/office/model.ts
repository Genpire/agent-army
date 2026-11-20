/**
 * The Office page's data and vocabulary: GET /api/office's shapes (type-only
 * imports from the server, like lib/types.ts), state labels and the pure
 * helpers the scene, the list and the drawer share. No React here.
 */
import type { OfficeMeeting, OfficePerson, OfficeState, OfficeTaskRef, OfficeView } from "../../../../src/team/office.js";
import { href } from "../../lib/router";
import type { AgentSpec, Task, TaskPhase } from "../../lib/types";
import { plainLabel } from "../chat/labels";

export type { OfficeMeeting, OfficePerson, OfficeState, OfficeTaskRef, OfficeView };

/** How often the page re-reads the office while it is visible. */
export const OFFICE_EVERY_MS = 3000;

/** GET /api/office for the browser's time zone, so "today" starts at the owner's midnight. */
export const officePath = () => `/api/office?tz=${new Date().getTimezoneOffset()}`;

export const LEAD_ID = "pointer";

export type StateTone = "green" | "blue" | "purple" | "orange";

/** Each state's words and colour; the colour is never the only cue (labels, icons and bubbles say it too). */
export const STATE_INFO: Record<OfficeState, { label: string; tone: StateTone; badge: "success" | "info" | "purple" | "orange" }> = {
  free: { label: "Free", tone: "green", badge: "success" },
  working: { label: "Working", tone: "blue", badge: "info" },
  thinking: { label: "Thinking", tone: "purple", badge: "purple" },
  meeting: { label: "In a meeting", tone: "orange", badge: "orange" },
};

export const isBusy = (p: Pick<OfficePerson, "state">) => p.state !== "free";

/** "Sara · Coder", or just "Coder" when the name is the role. */
export const nameTag = (p: Pick<OfficePerson, "name" | "role">) =>
  p.name.trim().toLowerCase() === p.role.trim().toLowerCase() ? p.name : `${p.name} · ${p.role}`;

/** Where a task's work can be followed: its conversation in Chat (console tasks), else Activity. */
export const taskHref = (t: Pick<OfficeTaskRef, "id" | "conversationId">) => (t.conversationId ? href("chat", t.conversationId) : href("activity", t.id));

const PHASE_WORDS: Record<TaskPhase, string> = {
  clone: "cloning",
  setup: "setting up",
  plan: "planning",
  build: "building",
  verify: "checking the work",
  publish: "opening the pull request",
  checks: "waiting for checks",
};

/** "step 3 of 5" from the plan, else the step in words. */
export function meetingStep(m: Pick<OfficeMeeting, "plan" | "step">): string {
  if (m.plan.total > 0) return `step ${Math.min(m.plan.done + 1, m.plan.total)} of ${m.plan.total}`;
  return PHASE_WORDS[m.step];
}

/** "acme/web · Dark mode toggle · step 3 of 5" */
export const meetingLine = (m: OfficeMeeting) => `${m.repo} · ${m.title} · ${meetingStep(m)}`;

/** A sentence for screen readers and tooltips: "Sara, Coder: working. Editing src/x.ts." */
export function personSummary(p: OfficePerson): string {
  const doing = p.doing ? ` ${p.doing}.` : "";
  return `${nameTag(p).replace(" · ", ", ")}: ${STATE_INFO[p.state].label.toLowerCase()}.${doing}`;
}

/** "3 h 5 min", "12 min", "–" */
export function minutesText(min: number): string {
  if (!min) return "0 min";
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/** The label an agent's work carries in task progress, without the emoji: "Sara (Coder)" (mirrors agentLabel in src/team.ts). */
export const progressName = (a: Pick<AgentSpec, "name" | "role">) => (a.name === a.role ? a.name : `${a.name} (${a.role})`);

/** Tasks the person took part in, newest first: every task for Pointer, else those whose progress names the agent. */
export function tasksOf(tasks: Task[], person: Pick<OfficePerson, "id" | "kind">, agent: AgentSpec | undefined): Task[] {
  if (person.kind === "lead") return tasks;
  if (!agent) return [];
  const names = new Set([progressName(agent), agent.id]);
  return tasks.filter((t) => t.progress?.agents.some((a) => names.has(plainLabel(a.label))));
}

/** Seeds to offer when changing a face: the current one first, then a few new ones. */
export function faceChoices(current: string, id: string, round: number, count = 11): string[] {
  const extra = Array.from({ length: count }, (_, i) => `${id}-${round * count + i + 1}`);
  return [current, ...extra.filter((s) => s !== current)];
}
