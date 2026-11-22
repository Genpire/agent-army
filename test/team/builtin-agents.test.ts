import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/core/config.js";
import { defaultHrAgent } from "../../src/team/hr.js";
import { buildOffice } from "../../src/team/office.js";
import { AgentSpecSchema, TeamSchema, agentLabel, buildRepoAgents, defaultTeam, rosterText } from "../../src/team/team.js";
import { officeLayout } from "../../web/src/pages/office/layout.js";
import { isInside } from "../../web/src/pages/office/paths.js";
import { missingBuiltins, routeTarget, slugId, targetAgentId } from "../../web/src/pages/team/team.js";

/** The built-in agents: the default team's roles, their working rules, and how the Team page adds one a saved team lacks. */

const agent = (id: string) => {
  const found = defaultTeam().agents.find((a) => a.id === id);
  if (!found) throw new Error(`no built-in agent ${id}`);
  return found;
};

describe("the Failure Reviewer", () => {
  // Looked up without throwing, so a missing agent fails each test rather than the whole file.
  const fr = defaultTeam().agents.find((a) => a.id === "failure-reviewer")!;

  it("is a built-in agent that runs commands on Claude, enabled, after QA", () => {
    expect(fr).toMatchObject({
      id: "failure-reviewer",
      name: "Failure Reviewer",
      role: "Failure reviewer",
      emoji: ":rotating_light:",
      access: "run",
      engine: "claude",
      enabled: true,
    });
    const ids = defaultTeam().agents.map((a) => a.id);
    expect(ids.indexOf("failure-reviewer")).toBe(ids.indexOf("qa") + 1);
  });

  it("passes the agent schema unchanged, and the default team still parses", () => {
    expect(AgentSpecSchema.parse(fr)).toEqual(fr);
    expect(TeamSchema.parse(defaultTeam())).toEqual(defaultTeam());
    expect(ConfigSchema.parse({}).team).toEqual(defaultTeam());
    expect(new Set(defaultTeam().agents.map((a) => a.id)).size).toBe(defaultTeam().agents.length);
  });

  it("is used for what happens when things go wrong, and only reports", () => {
    expect(fr.description).toMatch(/^Reviews only what happens when things go wrong/);
    for (const topic of ["deleted mid-flow", "cancellation", "two requests at once", "a step failing midway", "retries and timeouts"]) {
      expect(fr.description).toContain(topic);
    }
    expect(fr.description).toContain("Reports findings; does not fix them.");
  });

  it("goes through the failure checklist", () => {
    for (const item of [
      "Data or an account deleted mid-flow",
      "Cancel or abort halfway",
      "two requests at once, a double submit, two payments at the same time, races",
      "(idempotency)",
      "A step failing midway: what is left behind, whether it is rolled back or compensated, and whether a retry is safe",
      "Timeouts, and slow or failing external services",
      "Permissions revoked or sessions expired",
      "Invalid or stale state",
      "Limits: empty, missing or huge inputs",
    ]) {
      expect(fr.instructions).toContain(item);
    }
  });

  it("inspects the diff without touching the checkout, and replies with a verdict and findings", () => {
    expect(fr.instructions).toContain("`git diff` against the base branch you are given");
    expect(fr.instructions).toContain("read the code paths it touches end to end");
    expect(fr.instructions).toContain("run a targeted test or check");
    expect(fr.instructions).toContain(
      "Do not modify files in the checkout. Write a throwaway script only in a temporary folder outside the checkout, and remove it when you are done.",
    );
    expect(fr.instructions).toContain('"VERDICT: approve" or "VERDICT: changes requested"');
    expect(fr.instructions).toContain("file, line, the failure scenario (what happens, step by step), severity (blocker / should-fix / nit) and a concrete fix");
  });

  it("gets commands but no file edits in a repo task, and shows in the roster", () => {
    const repo = buildRepoAgents(defaultTeam())["failure-reviewer"]!;
    expect(repo.tools).toContain("Bash");
    expect(repo.tools).not.toContain("Edit");
    expect(repo.tools).not.toContain("Write");
    expect(rosterText(defaultTeam())).toContain("- failure-reviewer: Failure Reviewer, Failure reviewer (can run commands). Reviews only what happens when things go wrong");
    expect(agentLabel(fr)).toBe(":rotating_light: Failure Reviewer (Failure reviewer)");
  });

  it("gets a desk in the office with the rest of the default team", () => {
    const now = Date.parse("2026-11-19T15:00:00.000Z");
    const view = buildOffice({ team: defaultTeam(), tasks: [], timelines: new Map(), conversations: [], now, dayStart: now - 3_600_000 });
    expect(view.people.map((p) => p.id)).toContain("failure-reviewer");
    const layout = officeLayout(view.people, view.meetings);
    const desks = layout.desks.filter((d) => d.personId);
    expect(desks.map((d) => d.personId).sort()).toEqual(view.people.map((p) => p.id).sort());
    for (const d of layout.desks) expect(layout.obstacles.some((o) => isInside(o, d.door)), d.key).toBe(false);
    // HR keeps its own corner.
    expect(defaultHrAgent().id).toBe("hr");
  });
});

describe("the sharpened default roles", () => {
  it("the Coder confirms the problem in the code first, and stops when it is not there", () => {
    const coder = agent("coder").instructions;
    expect(coder).toContain("confirm the problem is there: find it, or reproduce the bug");
    expect(coder).toContain("If it is not there, or the task does not match the code, change nothing: stop and say what you found");
    expect(coder).toContain("the exact commands you ran with their real output");
  });

  it("QA proves each test red then green with the safe undo, and reports the proof", () => {
    const qa = agent("qa").instructions;
    expect(qa).toContain("Note `git diff --stat` and `git status --short`");
    expect(qa).toContain("`git stash push -u -m red-green-proof -- <product files only>` (never the tests; -u undoes a new product file too)");
    expect(qa).not.toContain("`git stash push -- ");
    expect(qa).toContain("see it fail, restore it with `git stash pop`, run the test again and see it pass");
    expect(qa).toContain("check `git diff --stat` and `git status --short` are what they were");
    expect(qa).toContain(
      "If the change is already committed (a later round), undo it with `git checkout <base> -- <the changed product files>` (deleting the ones it added) and put it back with `git checkout HEAD -- <those files>`, stashing any uncommitted edits to them first (`git stash push -m red-green-proof -- <those files>`) and popping them after.",
    );
    expect(qa).toContain(
      "The proof runs on its own: Pointer has it done after the other verifiers have reported, so that nobody else works in or runs the checkout while the change is undone.",
    );
    expect(qa).toContain("Never leave the change undone and never commit in between.");
    expect(qa).toContain("A test that passes both ways proves nothing: fix the test.");
    expect(qa).toContain("A run that showed no result (no tests found, nothing printed, cut off) is not a pass");
    expect(qa).toMatch(/Reply with "RESULT: pass" or "RESULT: fail",[^\n]*the proof for each test \(its command, failing without the change and passing with it\)/);
  });

  it("the Reviewer looks for tests that cannot fail and results reported without output", () => {
    const reviewer = agent("reviewer").instructions;
    expect(reviewer).toContain("Look for tests that cannot fail: they would pass without the change");
    expect(reviewer).toContain("Look for check results reported without their output, and run those checks again yourself.");
    expect(reviewer).toContain('"VERDICT: approve" or "VERDICT: changes requested"');
  });

  it("every default agent still passes the agent schema unchanged", () => {
    for (const a of defaultTeam().agents) expect(AgentSpecSchema.parse(a), a.id).toEqual(a);
  });
});

describe("adding a built-in agent the team lacks (Team page)", () => {
  const builtins = defaultTeam().agents;
  const saved = builtins.filter((a) => a.id !== "failure-reviewer" && a.id !== "scout");
  const taken = new Set(saved.map((a) => a.id));

  it("offers the built-ins no agent has the id of, in their order", () => {
    expect(missingBuiltins(builtins, taken).map((a) => a.id)).toEqual(["failure-reviewer", "scout"]);
    expect(missingBuiltins(builtins, new Set(builtins.map((a) => a.id)))).toEqual([]);
    // An agent renamed by the owner still has the built-in's id: not offered again.
    expect(missingBuiltins(builtins, new Set([...taken, "scout"])).map((a) => a.id)).toEqual(["failure-reviewer"]);
  });

  it("opens the drawer prefilled for a missing built-in only", () => {
    const missing = missingBuiltins(builtins, taken);
    const fr = agent("failure-reviewer");
    expect(routeTarget(["builtin", "failure-reviewer"], { agents: saved, builtins: missing, isFull: false })).toEqual({ kind: "builtin", agent: fr });
    // One the team has, an unknown id, or a full team: no drawer.
    expect(routeTarget(["builtin", "coder"], { agents: saved, builtins, isFull: false })).toBeUndefined();
    expect(routeTarget(["builtin", "designer"], { agents: saved, builtins: missing, isFull: false })).toBeUndefined();
    expect(routeTarget(["builtin", "failure-reviewer"], { agents: saved, builtins: missing, isFull: true })).toBeUndefined();
  });

  it("keeps the other routes as they were", () => {
    const coder = agent("coder");
    expect(routeTarget(["new-agent"], { agents: saved, builtins, isFull: false })).toEqual({ kind: "new" });
    expect(routeTarget(["new-agent"], { agents: saved, builtins, isFull: true })).toBeUndefined();
    expect(routeTarget(["agent", "coder"], { agents: saved, builtins, isFull: true })).toEqual({ kind: "edit", agent: coder });
    expect(routeTarget(["agent", "failure-reviewer"], { agents: saved, builtins, isFull: false })).toBeUndefined();
    expect(routeTarget([], { agents: saved, builtins, isFull: false })).toBeUndefined();
  });

  it("saves a built-in under its own id, whatever the name, and a new agent under one made from its name", () => {
    const scout = agent("scout");
    expect(slugId(scout.name, taken)).toBe("skills-scout");
    expect(targetAgentId({ kind: "builtin", agent: scout }, scout.name, taken)).toBe("scout");
    expect(targetAgentId({ kind: "builtin", agent: scout }, "Diego", taken)).toBe("scout");
    expect(targetAgentId({ kind: "edit", agent: agent("coder") }, "Sara", taken)).toBe("coder");
    expect(targetAgentId({ kind: "new" }, "Designer", taken)).toBe("designer");
    expect(targetAgentId({ kind: "new" }, "Coder", taken)).toBe("coder-2");
  });
});
