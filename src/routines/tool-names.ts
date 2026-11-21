/** The names of Pointer's routine tools (the "routines" MCP server), for the chat integration and the confirm gate. */
export const ROUTINES_SERVER_KEY = "routines";
export const ROUTINE_TOOL_NAMES = ["routine_create", "routine_list", "routine_update", "routine_delete", "routine_run_now"] as const;
/** Tools chat subagents and routine runs may call. */
export const ROUTINE_READ_TOOL_NAMES = ["routine_list"] as const;

export const routineToolName = (tool: string) => `mcp__${ROUTINES_SERVER_KEY}__${tool}`;

/** Creating, changing and deleting a routine: gated after outside content (confirm-gate.ts), like app writes. */
export const ROUTINE_WRITE_TOOLS = ["routine_create", "routine_update", "routine_delete"].map(routineToolName);
/** Starts a run to the routine's own recipients: an echo of what Pointer asked, never outside content. */
export const ROUTINE_RUN_TOOL = routineToolName("routine_run_now");
