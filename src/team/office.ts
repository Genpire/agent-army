import type { ConversationSummary } from "../chat/conversations.js";
import type { AgentProgress } from "../progress.js";
import type { Store } from "../core/store.js";
import { type TaskEvent, type TaskTimeline, currentPhase, plainLine, readTimeline } from "../task-events.js";
import { type Task, type TaskPhase, type TaskRepo, WEB_CHANNEL } from "../tasks.js";
import { type AgentSpec, type Team, agentLabel, enabledAgents } from "./team.js";

/**
 * The virtual office (GET /api/office): everyone on the team as a person at a
 * desk, free or busy, with what they are doing right now. Derived from the
 * recent task records (progress.agents says who works on what), the running
 * tasks' timelines (the latest step of each agent) and the console
 * conversations (Pointer is thinking while it answers one). Read-only and
 * cheap: the recent tasks, the active tasks' timelines and the conversation
 * index, nothing else. Text comes from records that are already redacted.
 */

/** Pointer's id in the office (reserved for agents, so it never clashes). */
export const OFFICE_LEAD_ID = "pointer";
/** Recent tasks read per request (the same window as GET /api/tasks). */
export const OFFICE_TASKS_SCAN = 30;
/** A queued or running task not saved for this long is treated as gone (its worker died). */
export const STALE_TASK_MS = 3 * 60 * 60_000;
/** A pending conversation older than this was interrupted (Pointer's answers time out well before). */
export const STALE_ANSWER_MS = 15 * 60_000;
/** Longest `doing` line. */
export const DOING_MAX = 90;
/** Longest task title. */
export const TITLE_MAX = 80;

export type OfficeState = "free" | "working" | "thinking" | "meeting";

export interface OfficeTaskRef {
  id: string;
  repo: string;
  title: string;
  /** The console conversation it runs in (web tasks). */
  conversationId?: string;
  channel: string;
}

export interface OfficePerson {
  id: string;
  name: string;
  role: string;
  /** Slack emoji code. */
  emoji: string;
  /** The face's seed: the agent's avatar setting, else its id. */
  avatar: string;
  kind: "lead" | "agent";
  state: OfficeState;
  /** One short line: "Editing src/components/Header.tsx", "Running npm test". */
  doing?: string;
  task?: OfficeTaskRef;
  /** Pointer while it answers in Chat: that conversation. */
  conversation?: { id: string; title: string };
  /** When the current state started (free: when they last worked). */
  since?: string;
  /** Repo tasks they took part in since the start of the owner's day, and the minutes they worked on them. */
  today: { tasks: number; minutes: number };
}

export interface OfficeMeeting {
  taskId: string;
  title: string;
  repo: string;
  channel: string;
  conversationId?: string;
  /** The step the task is on. */
  step: TaskPhase;
  /** The lead's plan: items done and in all. */
  plan: { done: number; total: number };
  /** Pointer first, then the agents who took part, in the order they joined. */
  people: string[];
  since: string;
}

export interface OfficeView {
  people: OfficePerson[];
  meetings: OfficeMeeting[];
  updatedAt: string;
}

export interface OfficeInput {
  team: Team;
  /** Recent tasks, any order. */
  tasks: Task[];
  /** Timelines of the active tasks, by task id (missing or null: none yet). */
  timelines: ReadonlyMap<string, TaskTimeline | null>;
  /** The console conversations (summaries). */
  conversations: ConversationSummary[];
  now: number;
  /** The start of the owner's day, in ms. */
  dayStart: number;
}

const isActive = (t: Task, now: number) =>
  (t.status === "queued" || t.status === "running") && now - Date.parse(t.progress?.updatedAt ?? t.updatedAt) < STALE_TASK_MS;

const clip = (text: string, max: number) => plainLine(text, max);

/** Midnight in the owner's time zone (`tzOffsetMin` as Date#getTimezoneOffset gives it: minutes behind UTC). */
export function dayStartMs(now: number, tzOffsetMin = 0): number {
  const local = now - tzOffsetMin * 60_000;
  return local - (((local % 86_400_000) + 86_400_000) % 86_400_000) + tzOffsetMin * 60_000;
}

/** A task's name: the team's report title, the monday.com ticket, else the request's first line. */
export function taskTitle(t: Pick<Task, "report" | "ticket" | "instruction">): string {
  const line = t.instruction.split("\n").find((l) => l.trim()) ?? "";
  return clip(t.report?.title || t.ticket?.name || line || "Repo task", TITLE_MAX);
}

export function taskRef(t: Task): OfficeTaskRef {
  return {
    id: t.id,
    repo: t.repo,
    title: taskTitle(t),
    channel: t.channel,
    ...(t.channel === WEB_CHANNEL ? { conversationId: t.threadTs } : {}),
  };
}

// ---------- What someone is doing, in words ----------

/** Verbs a short assignment usually starts with ("Review the diff"), so it can read "Reviewing the diff". */
const VERBS = new Set(
  (
    "add analyse analyze answer audit build change check clean compare configure create debug deploy design document draft edit explore find fix " +
    "gather improve implement install investigate list look make migrate move open plan port prepare read recommend refactor remove rename " +
    "research review rewrite run scan search set show summarise summarize test translate try update upgrade verify wire write"
  ).split(" "),
);

/** "Review the diff" → "Reviewing the diff"; text that does not start with a known verb is kept. */
export function gerund(text: string): string {
  const line = clip(text, DOING_MAX);
  const match = line.match(/^([A-Za-z]+)(\b.*)$/);
  const word = match?.[1] ?? "";
  const lower = word.toLowerCase();
  if (!VERBS.has(lower)) return line;
  let ing: string;
  if (/[^aeiou]e$/.test(lower)) ing = `${lower.slice(0, -1)}ing`;
  // Short verbs ending consonant-vowel-consonant double the last letter: run → running.
  else if (/^(run|set|plan|scan)$/.test(lower)) ing = `${lower}${lower.at(-1)}ing`;
  else ing = `${lower}ing`;
  const cased = word[0] === word[0]!.toUpperCase() ? ing[0]!.toUpperCase() + ing.slice(1) : ing;
  return clip(`${cased}${match?.[2] ?? ""}`, DOING_MAX);
}

const BROWSER_DOING: [prefix: string, words: (detail: string) => string][] = [
  ["Opened", (d) => (d ? `Checking ${d} in the browser` : "Checking the app in the browser")],
  ["Took a screenshot", (d) => (d ? `Taking a screenshot: ${d}` : "Taking a screenshot")],
  ["Clicked", (d) => (d ? `Clicking ${d} in the browser` : "Clicking through the app")],
  ["Filled in", (d) => (d ? `Filling in ${d}` : "Filling in a form")],
  ["Read the page", () => "Reading the page in the browser"],
  ["Resized the window", (d) => (d ? `Trying the page at ${d}` : "Resizing the browser")],
  ["Read the console", () => "Reading the browser console"],
  ["Read the network requests", () => "Checking the network requests"],
];

/** One timeline step as what someone is doing now: "Editing src/x.ts", "Running npm test". */
export function describeStep(e: Pick<TaskEvent, "kind" | "text">): string | undefined {
  switch (e.kind) {
    case "edit":
      return clip(`Editing ${e.text}`, DOING_MAX);
    case "command":
      return clip(`Running ${e.text}`, DOING_MAX);
    case "browser": {
      for (const [prefix, words] of BROWSER_DOING) {
        if (e.text === prefix || e.text.startsWith(`${prefix}:`)) return clip(words(e.text.slice(prefix.length).replace(/^:\s*/, "")), DOING_MAX);
      }
      return clip(`In the browser: ${e.text}`, DOING_MAX);
    }
    case "agent-start":
      // "Review the diff: <the whole prompt>" → the short part.
      return gerund(e.text.split(": ")[0] ?? e.text);
    default:
      return undefined;
  }
}

/** Pointer's line for a task it leads: its own step, the worker's stage, the plan item in progress, or the team's progress line. */
export function leadDoing(t: Task, timeline: TaskTimeline | null | undefined, lead: string, plainLabelOf: (label: string) => string): string {
  if (t.status === "queued") return `Waiting for a worker for ${t.repo}`;
  const last = timeline?.events.at(-1);
  if (last?.agent === lead) {
    const step = describeStep(last);
    if (step) return step;
  }
  const phase = timeline ? currentPhase(timeline) : t.stage?.phase;
  if (t.stage && (phase === "clone" || phase === "setup" || phase === "publish" || phase === "checks")) return clip(t.stage.text, DOING_MAX);
  const working = t.progress?.agents.filter((a) => a.state === "working") ?? [];
  if (working.length) return clip(`Leading ${working.map((a) => plainLabelOf(a.label)).join(" and ")} on ${t.repo}`, DOING_MAX);
  const progress = t.progress?.now ? clip(t.progress.now, DOING_MAX) : "";
  // "Pointer is checking the results" is Pointer's own line: "Checking the results".
  const own = progress.startsWith(`${lead} is `) ? progress.slice(lead.length + 4) : progress;
  if (own) return clip(own[0]!.toUpperCase() + own.slice(1), DOING_MAX);
  return clip(t.stage?.text || `Leading the team on ${t.repo}`, DOING_MAX);
}

// ---------- Who is who ----------

/** Maps progress and timeline labels (":hammer_and_wrench: Sara (Coder)", "Sara (Coder)", ":robot_face: coder") to agent ids. */
export function labelIndex(agents: AgentSpec[]): (label: string) => string | undefined {
  const exact = new Map<string, string>();
  const plain = new Map<string, string>();
  for (const a of agents) {
    exact.set(agentLabel(a), a.id);
    exact.set(`:robot_face: ${a.id}`, a.id);
    plain.set(plainLine(agentLabel(a), 80), a.id);
    plain.set(a.id, a.id);
  }
  return (label) => exact.get(label) ?? plain.get(plainLine(label, 80));
}

interface Involvement {
  task: Task;
  timeline: TaskTimeline | null | undefined;
  /** Agent id → its runs in this task (progress) and its latest timeline events. */
  agents: Map<string, { runs: AgentProgress[]; events: TaskEvent[] }>;
  /** Agent ids in the order they joined. */
  order: string[];
}

function involvement(t: Task, timeline: TaskTimeline | null | undefined, idOf: (label: string) => string | undefined): Involvement {
  const agents = new Map<string, { runs: AgentProgress[]; events: TaskEvent[] }>();
  const order: string[] = [];
  const entry = (id: string) => {
    let e = agents.get(id);
    if (!e) {
      e = { runs: [], events: [] };
      agents.set(id, e);
      order.push(id);
    }
    return e;
  };
  for (const e of timeline?.events ?? []) {
    const id = e.agent ? idOf(e.agent) : undefined;
    if (id) entry(id).events.push(e);
  }
  for (const run of t.progress?.agents ?? []) {
    const id = idOf(run.label);
    if (id) entry(id).runs.push(run);
  }
  return { task: t, timeline, agents, order };
}

/** Whether the agent is working in this task now, since when, and on what. */
function agentNow(inv: Involvement, id: string, now: number): { working: boolean; since?: string; doing?: string; at: number } {
  const entry = inv.agents.get(id);
  if (!entry) return { working: false, at: 0 };
  const runs = entry.events.filter((e) => e.kind === "agent-start" || e.kind === "agent-done");
  const lastRun = runs.at(-1);
  if (lastRun) {
    if (lastRun.kind === "agent-done") return { working: false, since: lastRun.at, at: Date.parse(lastRun.at) };
    const steps = entry.events.slice(entry.events.indexOf(lastRun) + 1);
    const latest = [...steps].reverse().find((e) => describeStep(e));
    return {
      working: true,
      since: lastRun.at,
      doing: describeStep(latest ?? lastRun),
      at: Date.parse((latest ?? lastRun).at),
    };
  }
  // No timeline (an older worker): the progress snapshot alone.
  const run = entry.runs.at(-1);
  if (!run) return { working: false, at: 0 };
  const savedAt = Date.parse(inv.task.progress?.updatedAt ?? inv.task.updatedAt);
  if (run.state !== "working") return { working: false, at: savedAt };
  return {
    working: true,
    since: new Date(Math.min(now, savedAt) - run.minutes * 60_000).toISOString(),
    doing: gerund(run.description),
    at: savedAt,
  };
}

const minutesOf = (runs: AgentProgress[]) => runs.reduce((sum, r) => sum + Math.max(0, r.minutes), 0);

/** Everyone in the office, from the records. Pure. */
export function buildOffice(input: OfficeInput): OfficeView {
  const { team, now, dayStart } = input;
  const lead = team.pointer.name || "Pointer";
  const agents = enabledAgents(team);
  const idOf = labelIndex(team.agents);
  const plainLabelOf = (label: string) => {
    const id = idOf(label);
    const spec = id ? team.agents.find((a) => a.id === id) : undefined;
    return spec ? spec.name : plainLine(label, 60);
  };

  const byNewest = [...input.tasks].sort((a, b) => b.id.localeCompare(a.id));
  const active = byNewest.filter((t) => isActive(t, now));
  const involved = new Map(byNewest.map((t) => [t.id, involvement(t, input.timelines.get(t.id), idOf)]));
  const activeInv = active.map((t) => involved.get(t.id)!);
  const isToday = (t: Task) => Date.parse(t.createdAt) >= dayStart || isActive(t, now);

  // A running task with two or more agents is a meeting: Pointer and everyone who took part.
  const enabledIds = new Set(agents.map((a) => a.id));
  const meetings: OfficeMeeting[] = activeInv
    .filter((inv) => inv.task.status === "running" && inv.order.filter((id) => enabledIds.has(id)).length >= 2)
    .map((inv) => {
      const t = inv.task;
      const plan = t.progress?.plan ?? [];
      return {
        taskId: t.id,
        title: taskTitle(t),
        repo: t.repo,
        channel: t.channel,
        ...(t.channel === WEB_CHANNEL ? { conversationId: t.threadTs } : {}),
        step: inv.timeline ? currentPhase(inv.timeline) : (t.stage?.phase ?? "plan"),
        plan: { done: plan.filter((p) => p.status === "completed").length, total: plan.length },
        people: [OFFICE_LEAD_ID, ...inv.order.filter((id) => enabledIds.has(id))],
        since: t.createdAt,
      };
    });
  const meetingOf = (id: string) => meetings.find((m) => m.people.includes(id));

  const people: OfficePerson[] = [];

  // Pointer: thinking while it answers in Chat, in a meeting while it leads one, working while any task runs.
  const answering = input.conversations
    .filter((c) => c.pending && now - Date.parse(c.updatedAt) < STALE_ANSWER_MS)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  const ledMeeting = meetings[0];
  const ledTask = ledMeeting ? active.find((t) => t.id === ledMeeting.taskId) : active[0];
  const todayTasks = byNewest.filter(isToday);
  const leadMinutes = todayTasks.reduce((sum, t) => {
    const end = isActive(t, now) ? now : Date.parse(t.updatedAt);
    return sum + Math.max(0, Math.round((end - Date.parse(t.createdAt)) / 60_000));
  }, 0);
  const leadBase = {
    id: OFFICE_LEAD_ID,
    name: lead,
    role: "Lead",
    emoji: ":dart:",
    avatar: OFFICE_LEAD_ID,
    kind: "lead" as const,
    today: { tasks: todayTasks.length, minutes: leadMinutes },
  };
  if (answering) {
    people.push({
      ...leadBase,
      state: "thinking",
      doing: clip(`Answering “${answering.title}”`, DOING_MAX),
      conversation: { id: answering.id, title: answering.title },
      since: answering.updatedAt,
      ...(ledTask ? { task: taskRef(ledTask) } : {}),
    });
  } else if (ledTask) {
    people.push({
      ...leadBase,
      state: ledMeeting ? "meeting" : "working",
      doing: leadDoing(ledTask, input.timelines.get(ledTask.id), lead, plainLabelOf),
      task: taskRef(ledTask),
      since: ledTask.createdAt,
    });
  } else {
    const last = byNewest[0];
    people.push({ ...leadBase, state: "free", ...(last ? { since: last.updatedAt } : {}) });
  }

  for (const a of agents) {
    const base = {
      id: a.id,
      name: a.name,
      role: a.role,
      emoji: a.emoji,
      avatar: a.avatar || a.id,
      kind: "agent" as const,
    };
    const mine = todayTasks.map((t) => involved.get(t.id)!).filter((inv) => inv.agents.has(a.id));
    const today = { tasks: mine.length, minutes: mine.reduce((sum, inv) => sum + minutesOf(inv.agents.get(a.id)!.runs), 0) };

    // Working: the active task where its latest step is newest.
    const busy = activeInv
      .map((inv) => ({ inv, now: agentNow(inv, a.id, now) }))
      .filter((x) => x.now.working)
      .sort((x, y) => y.now.at - x.now.at)[0];
    if (busy) {
      people.push({
        ...base,
        state: "working",
        ...(busy.now.doing ? { doing: busy.now.doing } : {}),
        task: taskRef(busy.inv.task),
        ...(busy.now.since ? { since: busy.now.since } : {}),
        today,
      });
      continue;
    }
    const meeting = meetingOf(a.id);
    if (meeting) {
      const inv = involved.get(meeting.taskId)!;
      const t = inv.task;
      const done = agentNow(inv, a.id, now);
      // What the meeting is busy with: the colleague working now, else Pointer.
      const colleague = meeting.people
        .map((id) => ({ spec: agents.find((x) => x.id === id), now: agentNow(inv, id, now) }))
        .find((x) => x.spec && x.spec.id !== a.id && x.now.working && x.now.doing);
      const doing = colleague
        ? `In the meeting: ${colleague.spec!.name} is ${colleague.now.doing![0]!.toLowerCase()}${colleague.now.doing!.slice(1)}`
        : `In the meeting with ${lead}`;
      people.push({
        ...base,
        state: "meeting",
        doing: clip(doing, DOING_MAX),
        task: taskRef(t),
        since: done.since ?? t.createdAt,
        today,
      });
      continue;
    }
    const lastWorked = byNewest.find((t) => involved.get(t.id)!.agents.has(a.id));
    people.push({ ...base, state: "free", ...(lastWorked ? { since: lastWorked.updatedAt } : {}), today });
  }

  return { people, meetings, updatedAt: new Date(now).toISOString() };
}

export interface OfficeDeps {
  store: Pick<Store, "get">;
  tasks: Pick<TaskRepo, "recent">;
  conversations: { list(): Promise<ConversationSummary[]> };
  team: Team;
}

/** Reads what the office needs (recent tasks, the active ones' timelines, the conversation index) and builds it. */
export async function loadOffice(deps: OfficeDeps, opts: { now?: number; tzOffsetMin?: number } = {}): Promise<OfficeView> {
  const now = opts.now ?? Date.now();
  const [tasks, conversations] = await Promise.all([
    deps.tasks.recent(OFFICE_TASKS_SCAN),
    deps.conversations.list().catch(() => [] as ConversationSummary[]),
  ]);
  const active = tasks.filter((t) => isActive(t, now));
  const timelines = new Map(
    await Promise.all(active.map(async (t) => [t.id, await readTimeline(deps.store, t.id).catch(() => null)] as const)),
  );
  return buildOffice({ team: deps.team, tasks, timelines, conversations, now, dayStart: dayStartMs(now, opts.tzOffsetMin) });
}
