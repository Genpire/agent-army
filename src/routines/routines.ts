/**
 * Routines: work Pointer does on its own on a schedule (config.routines).
 * The scheduler runs due routines through Pointer's brain (read-only), and
 * the runner delivers each report by email, Slack and the console.
 *
 * This file is Pointer's side: the "routines" tool server to create, list,
 * change, delete and run routines from a conversation. Creating, changing and
 * deleting are gated after outside content (confirm-gate.ts). The tools use
 * the RoutineService registered for the conversation's ConfigRepo
 * (server.ts); without one there are no routine tools.
 */
import { type SdkMcpToolDefinition, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { ChatIntegration, ChatIntegrationContext } from "../chat/chat-integrations.js";
import type { Config, ConfigRepo } from "../core/config.js";
import { emailReady } from "../integrations/email/email.js";
import { formatRunTime } from "./cron.js";
import { MIN_INTERVAL_MIN, type RoutineDraft, type RoutineService, type RoutineView } from "./service.js";
import { ROUTINES_SERVER_KEY, ROUTINE_READ_TOOL_NAMES, ROUTINE_TOOL_NAMES, routineToolName } from "./tool-names.js";

export { ROUTINES_SERVER_KEY, ROUTINE_READ_TOOL_NAMES, ROUTINE_TOOL_NAMES, ROUTINE_WRITE_TOOLS } from "./tool-names.js";

const services = new WeakMap<ConfigRepo, RoutineService>();

/** Makes the routine tools available to conversations that use this ConfigRepo (server.ts). */
export function registerRoutineService(configRepo: ConfigRepo, service: RoutineService): void {
  services.set(configRepo, service);
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** Where a routine's reports go, in words. */
export function recipientsText(r: Pick<RoutineView, "deliver">): string {
  const parts: string[] = [];
  if (r.deliver.email.length) parts.push(`email to ${r.deliver.email.join(", ")}`);
  if (r.deliver.slack) parts.push(`Slack ${r.deliver.slack}`);
  if (r.deliver.console) parts.push("the console (a conversation for this routine)");
  return parts.join("; ") || "nobody";
}

const runTimes = (r: RoutineView) => r.nextRuns.map((iso) => formatRunTime(new Date(iso), r.schedule.timezone)).join("; ");

/** One routine for Pointer: id, name, schedule, next runs, recipients, last run. */
export function routineLine(r: RoutineView): string {
  const next = !r.enabled ? "paused" : r.nextRuns.length ? `next ${runTimes(r)}` : "no upcoming runs";
  const last = r.lastRun ? `last run ${r.lastRun.status} (${r.lastRun.startedAt.slice(0, 16).replace("T", " ")} UTC)` : "not run yet";
  return [
    `- ${r.id} "${oneLine(r.name)}": ${r.scheduleText} (${r.schedule.timezone}, cron ${r.schedule.cron}); ${next}; reports to ${recipientsText(r)}; budget $${r.budgetUsd.toFixed(2)} per run; ${last}.${r.problem ? ` Problem: ${r.problem}` : ""}`,
    `  Instruction: ${oneLine(r.instruction).slice(0, 400)}`,
  ].join("\n");
}

const READ_ONLY_NOTE = "Each run is read-only: it looks things up and writes a report, and changes nothing. Reports go only to the recipients listed.";

function emailNote(config: Config, r: Pick<RoutineView, "deliver">): string {
  return r.deliver.email.length && !emailReady(config)
    ? " Email is not set up yet, so nothing is emailed until the owner sets up Email on the Integrations page."
    : "";
}

const deliveryArgs = {
  email: z.array(z.string().max(200)).max(20).optional().describe("Email addresses to send each report to"),
  slack: z
    .string()
    .max(200)
    .optional()
    .describe('A Slack channel id (C…), a user id (U…), or "me" for the person asking (from Slack); "" for none'),
  console: z.boolean().optional().describe("Keep each report in a console conversation for this routine (default true)"),
};

export interface RoutineToolOptions {
  service: RoutineService;
  config: Config;
  requester: string;
  requesterSlackId?: string;
  /**
   * The owner's own conversation (the console, their DM with Pointer): what
   * is created or changed here is marked ownerOnly. Anywhere else the mark is
   * cleared, so nobody else's routine reads the owner's Slack account.
   */
  byOwner?: boolean;
}

/** "me" on Slack is the person asking, when they asked from Slack. */
function slackFor(slack: string | undefined, o: RoutineToolOptions): { ok: true; value?: string } | { ok: false; error: string } {
  if (slack === undefined) return { ok: true };
  if (/^\s*me\s*$/i.test(slack)) {
    if (!o.requesterSlackId) {
      return { ok: false, error: 'There is no Slack account for "me" here: this request did not come from Slack. Find the person with slack_find_user and use their user id, or use a channel id.' };
    }
    return { ok: true, value: o.requesterSlackId };
  }
  return { ok: true, value: slack };
}

export function routineTools(o: RoutineToolOptions): SdkMcpToolDefinition<any>[] {
  const { service, config } = o;
  return [
    tool(
      "routine_create",
      "Create a routine: work you do on your own on a schedule, read-only, with its report delivered to the recipients given. " +
        "Use it when someone asks for something recurring (every day, each Monday, every morning at 8, weekly). " +
        `cron is standard 5-field cron (minute hour day-of-month month day-of-week), e.g. "0 8 * * *" daily at 08:00, "0 9 * * 1-5" weekdays at 09:00, "0 9 * * 1" Mondays at 09:00, "0 9 1 * *" the 1st of each month. At most every ${MIN_INTERVAL_MIN} minutes. ` +
        "Returns the schedule in words and the next 3 runs.",
      {
        name: z.string().min(1).max(80).describe('A short name, e.g. "Daily GitHub digest"'),
        instruction: z
          .string()
          .min(10)
          .max(8000)
          .describe("What to do on each run, written for you to follow alone: what to look at (repositories, boards, data) and what the report should contain"),
        cron: z.string().min(1).max(100).describe("Standard 5-field cron in the timezone"),
        timezone: z.string().max(64).optional().describe(`IANA timezone; default the organisation's (${config.timezone})`),
        ...deliveryArgs,
      },
      async (args) => {
        try {
          const slack = slackFor(args.slack, o);
          if (!slack.ok) return fail(slack.error);
          const draft: RoutineDraft = {
            name: args.name,
            instruction: args.instruction,
            cron: args.cron,
            ...(args.timezone ? { timezone: args.timezone } : {}),
            ...(args.email ? { email: args.email } : {}),
            ...(slack.value !== undefined ? { slack: slack.value } : {}),
            ...(args.console !== undefined ? { console: args.console } : {}),
          };
          const res = await service.create(draft, o.requester, { ownerOnly: o.byOwner === true });
          if (!res.ok) return fail(res.error);
          const r = res.routine;
          return ok(
            `Created routine ${r.id} "${oneLine(r.name)}": ${r.scheduleText} (${r.schedule.timezone}). Next runs: ${runTimes(r)}. ` +
              `Reports go to ${recipientsText(r)}. ${READ_ONLY_NOTE}${emailNote(config, r)} The owner can change or pause it on the Routines page.`,
          );
        } catch (err) {
          return fail(`Could not create the routine: ${errorText(err)}`);
        }
      },
    ),
    tool(
      "routine_list",
      "List the routines: id, name, schedule, next runs, recipients, last run and instruction.",
      {},
      async () => {
        try {
          const { routines } = await service.list();
          if (!routines.length) return ok("There are no routines yet.");
          return ok(`${routines.length} routine${routines.length === 1 ? "" : "s"}:\n${routines.map(routineLine).join("\n")}`);
        } catch (err) {
          return fail(`Could not list the routines: ${errorText(err)}`);
        }
      },
      { annotations: { readOnlyHint: true, openWorldHint: false } },
    ),
    tool(
      "routine_update",
      "Change a routine by id (from routine_list): pause it (enabled false), resume it (enabled true), or change its name, instruction, schedule, timezone or recipients. Fields left out are kept; email replaces the whole list.",
      {
        id: z.string().min(1).max(60),
        name: z.string().min(1).max(80).optional(),
        instruction: z.string().min(10).max(8000).optional(),
        cron: z.string().min(1).max(100).optional(),
        timezone: z.string().max(64).optional(),
        enabled: z.boolean().optional().describe("false pauses the routine, true resumes it"),
        ...deliveryArgs,
      },
      async ({ id, slack, ...rest }) => {
        try {
          const target = slackFor(slack, o);
          if (!target.ok) return fail(target.error);
          const draft: RoutineDraft = Object.fromEntries(Object.entries({ ...rest, slack: target.value }).filter(([, v]) => v !== undefined));
          const res = await service.update(id, draft, { ownerOnly: o.byOwner === true });
          if (!res.ok) return fail(res.error);
          const r = res.routine;
          const state = r.enabled ? `Next runs: ${runTimes(r) || "none"}.` : "It is paused: it does not run until it is resumed.";
          return ok(`Updated routine ${r.id} "${oneLine(r.name)}": ${r.scheduleText} (${r.schedule.timezone}). ${state} Reports go to ${recipientsText(r)}.${emailNote(config, r)}`);
        } catch (err) {
          return fail(`Could not update the routine: ${errorText(err)}`);
        }
      },
    ),
    tool(
      "routine_delete",
      "Delete a routine by id (from routine_list). Its run history goes; its console conversation stays.",
      { id: z.string().min(1).max(60) },
      async ({ id }) => {
        try {
          return (await service.remove(id)) ? ok(`Deleted routine ${id}.`) : fail(`There is no routine ${id}. List them with routine_list.`);
        } catch (err) {
          return fail(`Could not delete the routine: ${errorText(err)}`);
        }
      },
    ),
    tool(
      "routine_run_now",
      "Run a routine now, by id, in the background: its report goes to the routine's own recipients as on a scheduled run.",
      { id: z.string().min(1).max(60) },
      async ({ id }) => {
        try {
          const started = await service.runNow(id);
          if (!started.ok) return fail(started.error);
          const view = await service.get(id);
          return ok(`Started a run of ${id}. The report goes to ${view ? recipientsText(view) : "the routine's recipients"} when it is done (usually within a few minutes).`);
        } catch (err) {
          return fail(`Could not start the run: ${errorText(err)}`);
        }
      },
    ),
  ];
}

/** Pointer's rule for routines. */
export function routinesPromptRule(config: Config, requesterSlackId?: string): string {
  const email = emailReady(config)
    ? "Email is set up."
    : "Email is not set up: if someone wants reports by email, still add the addresses, and tell them the owner must set up Email on the Integrations page before anything is emailed.";
  const me = requesterSlackId
    ? `For "me" on Slack, use slack "me" (a DM to the person asking).`
    : "The owner in the console has no Slack account here: for Slack, use a channel id or a person's user id (find them with slack_find_user).";
  return [
    `- Routines: you can do work on your own on a schedule. When someone asks for something recurring ("every day", "each Monday", "every morning at 8", "remind me weekly", "send me … every week"), create a routine with routine_create instead of doing it once: a short name, an instruction written for you to follow alone on each run (what to look at and what the report should contain), and a 5-field cron you convert from their words, in the organisation's timezone (${config.timezone}) unless they name another one. ` +
      "Then restate the schedule in words with the next run time from the tool's result, and say that each run is read-only (it looks things up and reports; it changes nothing) and that the report goes only to the recipients listed.",
    `- Routine recipients: email addresses (ask for the address when they want email and gave none), a Slack channel or user id, and the console (on by default). ${me} ${email}`,
    `- List routines with routine_list; pause, resume or change one with routine_update; delete with routine_delete; run one now with routine_run_now. Routines run at most every ${MIN_INTERVAL_MIN} minutes. Creating, changing and deleting a routine after you have read outside content in this turn needs the user's confirmation, like other writes.`,
  ].join("\n");
}

/** Pointer's tools to create, list, change and run routines from a conversation. */
export function routinesChatIntegration(config: Config, ctx: ChatIntegrationContext, service = services.get(ctx.configRepo)): ChatIntegration | undefined {
  if (!service) return undefined;
  const tools = routineTools({
    service,
    config,
    requester: ctx.requester,
    ...(ctx.requesterSlackId ? { requesterSlackId: ctx.requesterSlackId } : {}),
    byOwner: ctx.ownerConversation === true,
  });
  return {
    key: ROUTINES_SERVER_KEY,
    // alwaysLoad: the chat session has no ToolSearch tool, so these must never be deferred behind it.
    server: createSdkMcpServer({ name: ROUTINES_SERVER_KEY, version: "1.0.0", tools, alwaysLoad: true }),
    allToolNames: ROUTINE_TOOL_NAMES.map(routineToolName),
    readOnlyToolNames: ROUTINE_READ_TOOL_NAMES.map(routineToolName),
    promptRule: routinesPromptRule(config, ctx.requesterSlackId),
  };
}
