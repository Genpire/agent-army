import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { promisify } from "node:util";
import { strToU8, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REPORT_SCHEMA, type Report, type SharedFile, orchestratorPrompt, parseReport } from "../src/agents.js";
import { type AttachmentInfo, AttachmentRepo } from "../src/attachments.js";
import type { CodeHost, HostViewer } from "../src/code-host.js";
import { type Config, ConfigSchema } from "../src/config.js";
import { deriveKey } from "../src/crypto.js";
import { NOTES_MAX_CHARS, NotesRepo } from "../src/notes.js";
import { type CodeHostKind, repoPath } from "../src/repo-id.js";
import { FsStore } from "../src/store.js";
import { REPO_RULES, type AgentSpec, defaultTeam, rosterText } from "../src/team.js";
import { type CheckInfo, GitHub, type PrRef, type StatusInfo } from "../src/github.js";
import { BROWSER_SERVER, BROWSER_TOOLS, browserServer } from "../src/browser.js";
import type { PlanItem } from "../src/progress.js";
import type { Task, ThreadState } from "../src/tasks.js";
import {
  type ExecFile,
  FALLBACK_COMMIT_EMAIL,
  FIX_RUN_MAX_MS,
  type FollowChecksDeps,
  GIT_SAFETY_ARGS,
  type GitRun,
  checkoutRepo,
  commitArgs,
  commitIdentity,
  configSecrets,
  draftPrBody,
  firstRunTimeoutMs,
  fixComment,
  fixRunTimeoutMs,
  followPrChecks,
  gitEnv,
  gitRunner,
  jobDeadline,
  makeRedactor,
  materializeAttachments,
  notesToSave,
  planChecklist,
  prFooter,
  prLabel,
  prRef,
  publishBranch,
  publishPr,
  resultHeadline,
  saveProjectNotes,
  saveUnfinishedPr,
  smartCommitSafe,
  snapshotGitConfig,
  screenshotFailureLine,
  screenshotsSection,
  stoppedComment,
  stoppedSlackText,
  subagentLabel,
  taskPrompt,
  taskTimeoutMin,
  teamQueryOptions,
  threadStateAfter,
  usd,
  wipTitle,
} from "../src/worker.js";

const baseConfig = (): Config => ConfigSchema.parse({});

const NO_WRITER = /no enabled agent can change code/i;

const designer: AgentSpec = {
  id: "designer",
  name: "Dana",
  role: "Designer",
  emoji: ":art:",
  description: "Reviews UI changes for layout, accessibility and consistency with the design system.",
  instructions: "You are the Designer. Look at the UI the change touches and report problems with fixes.",
  access: "read",
  model: "",
  effort: "",
  enabled: true,
};

describe("orchestratorPrompt", () => {
  it("uses Pointer's name, the org, the roster and the owner's instructions", () => {
    const config = baseConfig();
    config.orgName = "Acme";
    config.team.pointer.name = "Atlas";
    config.team.pointer.instructions = "Always write commit-style PR titles.";
    config.team.agents[0]!.name = "Sara";
    const prompt = orchestratorPrompt(config);
    expect(prompt).toContain("You are Atlas");
    expect(prompt).toContain("Acme");
    expect(prompt).toContain(rosterText(config.team));
    expect(prompt).toContain("- coder: Sara, Coder (can change code).");
    expect(prompt).toContain("Always write commit-style PR titles.");
    expect(prompt).toContain(REPO_RULES.trim());
  });

  it("keeps the workflow, publishing and blocked rules", () => {
    const prompt = orchestratorPrompt(baseConfig());
    expect(prompt).toMatch(/acceptance criteria/i);
    expect(prompt).toMatch(/at most three rounds/i);
    expect(prompt).toMatch(/git diff/);
    expect(prompt).toMatch(/You do not edit files yourself/);
    expect(prompt).toMatch(/pushes the branch and opens the pull request/);
    expect(prompt).toMatch(/report it as blocked/i);
    expect(prompt).toMatch(/"Change code" access/);
    expect(prompt).toMatch(/becomes the pull request description/);
    expect(prompt).not.toMatch(NO_WRITER);
  });

  it("is driven by the roster, not by fixed agent ids", () => {
    const config = baseConfig();
    config.team.agents = [{ ...config.team.agents[0]!, id: "builder", name: "Bob", role: "Builder" }, designer];
    const prompt = orchestratorPrompt(config);
    expect(prompt).toContain("- builder: Bob, Builder (can change code).");
    expect(prompt).toContain("- designer: Dana, Designer (looks only).");
    expect(prompt).not.toMatch(/\bcoder\b|\breviewer\b|\bqa\b/);
    expect(prompt).not.toMatch(NO_WRITER);
  });

  it("leaves disabled agents out of the roster", () => {
    const config = baseConfig();
    config.team.agents.find((a) => a.id === "writer")!.enabled = false;
    const prompt = orchestratorPrompt(config);
    expect(prompt).not.toContain("- writer:");
    expect(prompt).toContain("- researcher:");
  });

  it("warns when no enabled agent can change code", () => {
    const config = baseConfig();
    for (const a of config.team.agents) if (a.access === "write") a.enabled = false;
    const prompt = orchestratorPrompt(config);
    expect(prompt).toMatch(NO_WRITER);
    expect(prompt).not.toContain("- coder:");
  });

  it("copes with an empty team", () => {
    const config = baseConfig();
    config.team.agents = [];
    const prompt = orchestratorPrompt(config);
    expect(prompt).toContain("(no agents enabled)");
    expect(prompt).toMatch(NO_WRITER);
  });
});

describe("report", () => {
  it("asks for the verifying agents' verdicts", () => {
    expect(REPORT_SCHEMA.properties.verification.description).toBe(
      "Checks actually run and their real results, and the verdicts of the agents who verified.",
    );
  });

  it("falls back to a Pointer title", () => {
    expect(parseReport(undefined, "plain").title).toBe("Pointer update");
    expect(parseReport({ kind: "answer", summary: "s" }, "").title).toBe("Pointer update");
  });
});

describe("subagentLabel", () => {
  it("labels a known agent with its emoji, name and role", () => {
    const team = defaultTeam();
    team.agents[0]!.name = "Sara";
    expect(subagentLabel(team, "coder")).toBe(":hammer_and_wrench: Sara (Coder)");
    expect(subagentLabel(team, "reviewer")).toBe(":mag: Reviewer");
  });

  it("falls back for unknown or missing types", () => {
    const team = defaultTeam();
    expect(subagentLabel(team, "general-purpose")).toBe(":robot_face: general-purpose");
    expect(subagentLabel(team, undefined)).toBe(":robot_face: agent");
  });
});

describe("teamQueryOptions", () => {
  it("builds the subagents, permissions and system prompt from the configured team", () => {
    const config = baseConfig();
    config.team.agents.find((a) => a.id === "writer")!.enabled = false;
    config.team.agents.push(designer);
    const opts = teamQueryOptions(config);
    expect(Object.keys(opts.agents)).toEqual(["coder", "reviewer", "qa", "researcher", "hr", "scout", "designer"]);
    expect(opts.agents.designer!.tools).toEqual(["Read", "Glob", "Grep", "WebSearch", "WebFetch"]);
    expect(opts.allowedTools).toEqual(
      expect.arrayContaining(["Read", "Glob", "Grep", "Bash", "Agent", "Task", "Edit", "Write", "WebSearch", "WebFetch"]),
    );
    expect(opts.systemPrompt).toEqual({ type: "preset", preset: "claude_code", append: orchestratorPrompt(config) });
  });

  it("runs the task at the repo task effort", () => {
    const config = baseConfig();
    expect(teamQueryOptions(config).effort).toBe("medium");
    config.team.pointer.taskEffort = "high";
    expect(teamQueryOptions(config).effort).toBe("high");
  });

  it("does not allow editing when no agent can change code", () => {
    const config = baseConfig();
    for (const a of config.team.agents) if (a.access === "write") a.enabled = false;
    const opts = teamQueryOptions(config);
    expect(opts.allowedTools).not.toContain("Edit");
    expect(opts.allowedTools).not.toContain("Write");
    expect(opts.allowedTools).toEqual(expect.arrayContaining(["WebSearch", "WebFetch", "Bash", "Agent"]));
  });
});

const NOTES_HEADING = "Project notes from earlier tasks (may be outdated; verify before relying on them)";

describe("project notes", () => {
  afterEach(() => vi.restoreAllMocks());

  it("puts the repo's notes in the orchestrator prompt under a cautious heading", () => {
    const projectNotes = "- Tests: npm test (needs Node 22)\n- Migrations live in db/";
    const prompt = orchestratorPrompt(baseConfig(), { projectNotes });
    expect(prompt).toContain(NOTES_HEADING);
    expect(prompt).toContain(projectNotes);
    expect(prompt.indexOf(NOTES_HEADING)).toBeLessThan(prompt.indexOf(projectNotes));
    // Notes are reference material: the ground rules still come after and take precedence.
    expect(prompt.indexOf(projectNotes)).toBeLessThan(prompt.indexOf(REPO_RULES.trim()));
  });

  it("omits the notes section when there are no notes", () => {
    expect(orchestratorPrompt(baseConfig())).not.toContain(NOTES_HEADING);
    expect(orchestratorPrompt(baseConfig(), {})).not.toContain(NOTES_HEADING);
    expect(orchestratorPrompt(baseConfig(), { projectNotes: "  \n " })).not.toContain(NOTES_HEADING);
  });

  it("always asks Pointer to curate the notes in its report, never in the checkout", () => {
    for (const prompt of [orchestratorPrompt(baseConfig()), orchestratorPrompt(baseConfig(), { projectNotes: "x" })]) {
      expect(prompt).toMatch(/projectNotes/);
      expect(prompt).toMatch(/every task \(changes, answers and blocked tasks alike\)/);
      expect(prompt).toMatch(/6000 characters/);
      expect(prompt).toMatch(/Return "" to leave them unchanged/);
      expect(prompt).toMatch(/never write them into a file/i);
    }
  });

  it("passes the notes through teamQueryOptions", () => {
    const config = baseConfig();
    const opts = teamQueryOptions(config, { projectNotes: "- uses pnpm" });
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: orchestratorPrompt(config, { projectNotes: "- uses pnpm" }),
    });
    expect(teamQueryOptions(config).systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: orchestratorPrompt(config),
    });
  });

  it("requires projectNotes in the report schema", () => {
    expect(REPORT_SCHEMA.required).toContain("projectNotes");
    const prop = REPORT_SCHEMA.properties.projectNotes;
    expect(prop.type).toBe("string");
    expect(prop.description).toMatch(/full updated project notes for this repository/);
    expect(prop.description).toMatch(/6000 characters/);
    expect(prop.description).toMatch(/how to build, test and run/);
    expect(prop.description).toMatch(/obsolete/);
    expect(prop.description).toMatch(/no secrets or tokens/i);
    expect(prop.description).toMatch(/Return "" to leave them unchanged/);
  });

  it("parses projectNotes from the report, defaulting to empty", () => {
    const base = { kind: "answer", title: "t", summary: "s", verification: "", risks: "" };
    expect(parseReport({ ...base, projectNotes: "- uses pnpm" }, "").projectNotes).toBe("- uses pnpm");
    expect(parseReport(base, "").projectNotes).toBe("");
    expect(parseReport({ ...base, projectNotes: 42 }, "").projectNotes).toBe("");
    expect(parseReport(undefined, "plain").projectNotes).toBe("");
  });

  it("decides what to save: nothing when empty or unchanged, trimmed text otherwise", () => {
    expect(notesToSave("- a", "")).toBeNull();
    expect(notesToSave("- a", "  \n ")).toBeNull();
    expect(notesToSave("", "")).toBeNull();
    expect(notesToSave("- a\n- b", "- a\n- b")).toBeNull();
    expect(notesToSave("- a\n- b", "\n- a\n- b  \n")).toBeNull();
    expect(notesToSave("- a", "- a\n- b")).toBe("- a\n- b");
    expect(notesToSave("", "  - first note \n")).toBe("- first note");
  });

  it("truncates notes that are too long at the last newline before the limit", () => {
    const line = `- ${"x".repeat(97)}\n`; // 100 chars
    const reported = line.repeat(NOTES_MAX_CHARS / 100 + 5);
    const saved = notesToSave("", reported)!;
    expect(saved.length).toBeLessThanOrEqual(NOTES_MAX_CHARS);
    expect(saved).toBe(line.repeat(NOTES_MAX_CHARS / 100).trimEnd());
    expect(reported.startsWith(saved)).toBe(true);

    const noNewlines = "y".repeat(NOTES_MAX_CHARS + 50);
    expect(notesToSave("", noNewlines)).toBe("y".repeat(NOTES_MAX_CHARS));

    // Unchanged once truncated: nothing to save.
    expect(notesToSave(saved, reported)).toBeNull();
  });

  it("saves changed notes and leaves unchanged ones alone", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-worker-notes-")));
    const notes = new NotesRepo(store, deriveKey("k"));
    expect(await saveProjectNotes(notes, "acme/api", "", "- uses pnpm")).toBe(true);
    expect((await notes.get("acme/api"))!.text).toBe("- uses pnpm");

    const put = vi.spyOn(notes, "put");
    expect(await saveProjectNotes(notes, "acme/api", "- uses pnpm", "- uses pnpm\n")).toBe(false);
    expect(await saveProjectNotes(notes, "acme/api", "- uses pnpm", "")).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it("redacts known credentials from the notes it stores", async () => {
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-worker-notes-")));
    const notes = new NotesRepo(store, deriveKey("k"));
    const redact = makeRedactor(["sk-ant-secret123"]);
    await saveProjectNotes(notes, "acme/api", "", "- API key sk-ant-secret123 works", redact);
    expect((await notes.get("acme/api"))!.text).toBe("- API key [redacted] works");
  });

  it("never fails the task when saving fails, and keeps note content out of the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = { put: vi.fn().mockRejectedValue(new Error("bucket unavailable")) };
    expect(await saveProjectNotes(throwing, "acme/api", "", "- secret-ish detail")).toBe(false);
    expect(log).toHaveBeenCalledWith("[worker] could not save project notes: bucket unavailable");

    const refusing = { put: vi.fn().mockResolvedValue({ ok: false, error: "Repos look like owner/repo." }) };
    expect(await saveProjectNotes(refusing, "acme/api", "", "- another detail")).toBe(false);
    expect(log).toHaveBeenCalledWith("[worker] could not save project notes: Repos look like owner/repo.");

    const logged = log.mock.calls.flat().join("\n");
    expect(logged).not.toContain("secret-ish detail");
    expect(logged).not.toContain("another detail");
  });
});

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const THREAD = { channel: "C1", threadTs: "100.1" };

/** A real, encrypted AttachmentRepo seeded like a Slack thread: a design, a screenshot and a zip. */
async function seededRepo(): Promise<AttachmentRepo> {
  const store = new FsStore(await mkdtemp(join(tmpdir(), "army-worker-att-store-")));
  const repo = new AttachmentRepo(store, deriveKey("k"));
  const zip = zipSync({
    "mobile/index.html": strToU8("<p>mobile</p>"),
    "mobile/css/site.css": strToU8("p{color:red}"),
    "../../evil.txt": strToU8("escaped"),
    "/abs.txt": strToU8("absolute"),
    "mobile\\..\\..\\win.txt": strToU8("windows"),
  });
  const add = async (name: string, mime: string, bytes: Uint8Array, sourceId: string) => {
    const r = await repo.add(THREAD, { name, mime, bytes, source: "slack", sourceId });
    if (!r.ok) throw new Error(r.error);
  };
  await add("Chat Section.html", "text/html", strToU8("<section>chat</section>"), "F1");
  await add("image.png", "image/png", PNG, "F2");
  await add("Mobile-html.zip", "application/zip", zip, "F3");
  return repo;
}

/** Every file under dir, relative, with forward slashes. */
async function tree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split(sep).join("/"))
    .sort();
}

/** A stand-in repo for names and failures the real AttachmentRepo would never produce. */
function stubRepo(files: { name: string; bytes: Uint8Array | null | Error; mime?: string }[]) {
  const infos: AttachmentInfo[] = files.map((f, i) => ({
    id: `a-0000000${i}`,
    name: f.name,
    mime: f.mime ?? "application/octet-stream",
    size: 1,
    source: "slack",
    addedAt: "2026-11-18T00:00:00.000Z",
  }));
  return {
    list: vi.fn(async () => infos),
    get: vi.fn(async (_thread: unknown, id: string) => {
      const bytes = files[infos.findIndex((i) => i.id === id)]!.bytes;
      if (bytes instanceof Error) throw bytes;
      return bytes ? Buffer.from(bytes) : null;
    }),
  };
}

describe("materializeAttachments", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes the thread's files with safe names and expands zips into a subfolder", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "army-worker-att-"));
    const dir = join(root, "attachments");
    const files = await materializeAttachments(await seededRepo(), THREAD, dir);

    expect(await tree(dir)).toEqual([
      "Chat Section.html",
      "Mobile-html/mobile/css/site.css",
      "Mobile-html/mobile/index.html",
      "image.png",
    ]);
    expect(await readFile(join(dir, "Chat Section.html"), "utf8")).toBe("<section>chat</section>");
    expect(new Uint8Array(await readFile(join(dir, "image.png")))).toEqual(PNG);
    expect(await readFile(join(dir, "Mobile-html", "mobile", "index.html"), "utf8")).toBe("<p>mobile</p>");

    expect(files).toEqual([
      { path: join(dir, "Chat Section.html"), name: "Chat Section.html", size: 23 },
      { path: join(dir, "image.png"), name: "image.png", size: PNG.byteLength },
      {
        path: join(dir, "Mobile-html", "mobile", "index.html"),
        name: "mobile/index.html",
        size: 13,
        fromZip: "Mobile-html.zip",
      },
      {
        path: join(dir, "Mobile-html", "mobile", "css", "site.css"),
        name: "mobile/css/site.css",
        size: 12,
        fromZip: "Mobile-html.zip",
      },
    ]);

    // Traversal and absolute entries are skipped: nothing lands outside the zip's folder.
    expect(await tree(root)).toEqual((await tree(dir)).map((f) => `attachments/${f}`));
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).toMatch(/skipped/i);
    expect(logged).not.toContain("escaped");
    expect(logged).not.toContain("evil");
    expect(logged).not.toContain("<p>mobile</p>");
  });

  it("returns nothing and creates nothing when the thread has no files", async () => {
    const root = await mkdtemp(join(tmpdir(), "army-worker-att-"));
    const store = new FsStore(await mkdtemp(join(tmpdir(), "army-worker-att-store-")));
    const repo = new AttachmentRepo(store, deriveKey("k"));
    expect(await materializeAttachments(repo, THREAD, join(root, "attachments"))).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

  it("suffixes duplicate names and strips path separators and dot segments", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = await mkdtemp(join(tmpdir(), "army-worker-att-"));
    const dir = join(root, "attachments");
    const repo = stubRepo([
      { name: "image.png", bytes: strToU8("one") },
      { name: "image.png", bytes: strToU8("two") },
      { name: "IMAGE.png", bytes: strToU8("three") },
      { name: "../../escape.txt", bytes: strToU8("e") },
      { name: "..", bytes: strToU8("dots") },
      { name: "a/b\\c.txt", bytes: strToU8("abc") },
      { name: "design.zip", bytes: zipSync({ "x.html": strToU8("x") }), mime: "application/zip" },
      { name: "design", bytes: strToU8("plain") },
    ]);
    const files = await materializeAttachments(repo, THREAD, dir);
    expect(files.map((f) => f.path.slice(dir.length + 1))).toEqual([
      "image.png",
      "image-2.png",
      "IMAGE-3.png",
      "escape.txt",
      "file",
      "a_b_c.txt",
      join("design", "x.html"),
      "design-2",
    ]);
    for (const f of files) expect(f.path.startsWith(dir + sep)).toBe(true);
    expect(await readFile(join(dir, "image.png"), "utf8")).toBe("one");
    expect(await readFile(join(dir, "image-2.png"), "utf8")).toBe("two");
    expect(await readFile(join(dir, "IMAGE-3.png"), "utf8")).toBe("three");
    expect(await tree(root)).toEqual((await tree(dir)).map((f) => `attachments/${f}`));
  });

  it("skips files that are missing, unreadable or broken zips, and keeps going", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const dir = join(await mkdtemp(join(tmpdir(), "army-worker-att-")), "attachments");
    const repo = stubRepo([
      { name: "gone.png", bytes: null },
      { name: "secret-name.txt", bytes: new Error("decrypt failed: secret detail") },
      { name: "broken.zip", bytes: strToU8("not a zip at all"), mime: "application/zip" },
      { name: "ok.css", bytes: strToU8("a{}") },
    ]);
    const files = await materializeAttachments(repo, THREAD, dir);
    expect(files.map((f) => f.name)).toEqual(["ok.css"]);
    expect(await tree(dir)).toEqual(["ok.css"]);
    expect(log).toHaveBeenCalled();
    const logged = log.mock.calls.flat().join("\n");
    expect(logged).not.toContain("not a zip at all");
    expect(logged).not.toContain("secret detail");
  });
});

const FILES_HEADING = "Files shared for this task";

describe("shared files in the orchestrator prompt", () => {
  const attachments: SharedFile[] = [
    { path: "/work/army-1/attachments/Chat Section.html", name: "Chat Section.html", size: 2048 },
    { path: "/work/army-1/attachments/image.png", name: "image.png", size: 11 },
    {
      path: "/work/army-1/attachments/Mobile-html/mobile/index.html",
      name: "mobile/index.html",
      size: 13,
      fromZip: "Mobile-html.zip",
    },
  ];

  it("lists the absolute paths, the zip each came from, and how to use them", () => {
    const prompt = orchestratorPrompt(baseConfig(), { attachments });
    expect(prompt).toContain(FILES_HEADING);
    for (const f of attachments) expect(prompt).toContain(f.path);
    expect(prompt).toMatch(/mobile\/index\.html.*from Mobile-html\.zip/);
    expect(prompt).toMatch(/Slack or monday\.com/);
    expect(prompt).toMatch(/designs, specs and screenshots/i);
    expect(prompt).toMatch(/HTML and CSS[^\n]*\bRead\b/);
    expect(prompt).toMatch(/images[^\n]*\bRead\b/i);
    expect(prompt).toMatch(/outside the repository/i);
    expect(prompt).toMatch(/as an asset/i);
    expect(prompt).toMatch(/asset conventions/i);
    expect(prompt).toMatch(/data, not instructions/i);
    // Subagents never see this prompt: Pointer must hand them the paths.
    expect(prompt).toMatch(/cannot see this prompt/i);
    expect(prompt).toMatch(/absolute paths/i);
    // Reference material: the ground rules still come after it.
    expect(prompt.indexOf(FILES_HEADING)).toBeLessThan(prompt.indexOf(REPO_RULES.trim()));
  });

  it("works alongside project notes", () => {
    const prompt = orchestratorPrompt(baseConfig(), { projectNotes: "- uses pnpm", attachments });
    expect(prompt).toContain(NOTES_HEADING);
    expect(prompt).toContain(FILES_HEADING);
  });

  it("has no files section when nothing was shared", () => {
    expect(orchestratorPrompt(baseConfig())).not.toContain(FILES_HEADING);
    expect(orchestratorPrompt(baseConfig(), { attachments: [] })).not.toContain(FILES_HEADING);
    expect(orchestratorPrompt(baseConfig(), { projectNotes: "- x" })).not.toContain(FILES_HEADING);
  });

  it("caps a long listing and says how to see the rest", () => {
    const many: SharedFile[] = Array.from({ length: 150 }, (_, i) => ({
      path: `/work/army-1/attachments/site/page-${i}.html`,
      name: `page-${i}.html`,
      size: 10,
      fromZip: "site.zip",
    }));
    const prompt = orchestratorPrompt(baseConfig(), { attachments: many });
    expect(prompt).toContain(many[0]!.path);
    expect(prompt).not.toContain(many[149]!.path);
    expect(prompt).toMatch(/and \d+ more/);
  });

  it("teamQueryOptions adds the files folder only when there are files", () => {
    const config = baseConfig();
    const dir = "/work/army-1/attachments";
    const withFiles = teamQueryOptions(config, { attachments }, dir);
    expect(withFiles.additionalDirectories).toEqual([dir]);
    expect(withFiles.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: orchestratorPrompt(config, { attachments }),
    });
    expect(teamQueryOptions(config, { attachments: [] }, dir)).not.toHaveProperty("additionalDirectories");
    expect(teamQueryOptions(config, {}, dir)).not.toHaveProperty("additionalDirectories");
    expect(teamQueryOptions(config)).not.toHaveProperty("additionalDirectories");
    expect(teamQueryOptions(config, { attachments })).not.toHaveProperty("additionalDirectories");
  });
});

describe("code host credentials in the config", () => {
  const PRIMARY = "github_pat_primary_0000000000000";
  const EXTRA = "ghp_extra_connection_000000000000";
  const withExtra = () =>
    ConfigSchema.parse({
      github: {
        token: PRIMARY,
        allowedOwners: ["Acme"],
        extra: [{ id: "gh-abc123", token: EXTRA, login: "octo-dev", allowed: ["Partner-Co/Acme"] }],
      },
    });

  it("redacts every credential in the config, including every GitHub token and its git header", () => {
    const config = withExtra();
    config.anthropic.apiKey = "sk-ant-secret-key-1";
    config.slack.botToken = "xoxb-secret-bot-token";
    config.slack.signingSecret = "signing-secret-123";
    config.monday.token = "monday-secret-token";
    const redact = makeRedactor(configSecrets(config));
    const headers = [PRIMARY, EXTRA].map((t) => new GitHub(t).gitAuthHeader());
    const leaked = [
      PRIMARY,
      EXTRA,
      ...headers,
      ...headers.map((h) => h.split(" ").pop()!),
      "sk-ant-secret-key-1",
      "xoxb-secret-bot-token",
      "signing-secret-123",
      "monday-secret-token",
    ];
    const text = redact(`fatal: ${leaked.join(" | ")}`);
    for (const secret of leaked) expect(text).not.toContain(secret);
    expect(text).toContain("[redacted]");
    // An empty config has nothing to redact and leaves text alone.
    expect(makeRedactor(configSecrets(ConfigSchema.parse({})))("plain text")).toBe("plain text");
  });

  it("redacts the GitLab and Bitbucket tokens in every form their clients send them", () => {
    const config = withExtra();
    config.gitlab.token = "glpat-secret-gitlab-token-000";
    config.bitbucket.token = "ATATT-secret-bitbucket-token-000";
    config.bitbucket.email = "octo-dev@example.com";
    const basic = (user: string, token: string) => Buffer.from(`${user}:${token}`).toString("base64");
    const leaked = [
      config.gitlab.token,
      basic("oauth2", config.gitlab.token),
      config.bitbucket.token,
      basic("octo-dev@example.com", config.bitbucket.token),
      basic("x-token-auth", config.bitbucket.token),
    ];
    const text = makeRedactor(configSecrets(config))(`fatal: ${leaked.join(" | ")}`);
    for (const secret of leaked) expect(text).not.toContain(secret);
  });
});

describe("commitIdentity", () => {
  it("authors commits as the token owner's GitHub noreply address, so Vercel links them to a team member", () => {
    expect(commitIdentity("Pointer", { id: 1234567, login: "octo-dev" })).toEqual({
      name: "Pointer (via octo-dev)",
      email: "1234567+octo-dev@users.noreply.github.com",
    });
  });

  it("falls back to an address GitHub links to nobody when the owner is unknown or malformed", () => {
    for (const viewer of [undefined, { id: 0, login: "x" }, { id: 5, login: "bad login" }, { id: 5, login: "a@b" }]) {
      expect(commitIdentity("Pointer", viewer)).toEqual({ name: "Pointer", email: FALLBACK_COMMIT_EMAIL });
    }
    expect(FALLBACK_COMMIT_EMAIL).not.toContain("users.noreply.github.com");
  });

  it("is the GitHub client's own identity, also for a string id (another host's viewer)", () => {
    const github = new GitHub("ghp_identity_token_000000");
    expect(github.commitIdentity("Pointer", { id: 1234567, login: "octo-dev" })).toEqual(commitIdentity("Pointer", { id: 1234567, login: "octo-dev" }));
    expect(commitIdentity("Pointer", { id: "1234567", login: "octo-dev" })).toEqual({ name: "Pointer", email: FALLBACK_COMMIT_EMAIL });
  });
});

// ---------- The repo task on any code host, through a fake CodeHost ----------

const HOST_TOKEN = "glpat-fake-host-token-0123456789";
const HOST_HEADER = `Authorization: Basic ${Buffer.from(`oauth2:${HOST_TOKEN}`).toString("base64")}`;
const MR_URL = "https://gitlab.example.com/acme/web/-/merge_requests/12";
const notUsed = (what: string) => vi.fn(async (): Promise<never> => {
  throw new Error(`${what} is not used here`);
});

/** A GitLab-like code host whose every call is recorded. */
function fakeHost(kind: CodeHostKind = "gitlab") {
  return {
    kind,
    cloneUrl: vi.fn((repo: string) => `https://gitlab.example.com/${repoPath(repo)}.git`),
    gitAuthArgs: vi.fn(() => ["-c", `http.https://gitlab.example.com/.extraheader=${HOST_HEADER}`]),
    secrets: vi.fn(() => [HOST_TOKEN, HOST_HEADER, HOST_HEADER.split(" ").pop()!]),
    viewer: vi.fn(async (): Promise<HostViewer> => ({ id: 42, login: "octo-dev", email: "octo-dev@example.com" })),
    commitIdentity: vi.fn((name: string, viewer: HostViewer | undefined) =>
      viewer?.email ? { name: `${name} (via ${viewer.login})`, email: viewer.email } : { name, email: FALLBACK_COMMIT_EMAIL },
    ),
    defaultBranch: vi.fn(async (_repo: string) => "main"),
    findOpenPr: vi.fn(async (_repo: string, _branch: string): Promise<PrRef | null> => null),
    createPr: vi.fn(
      async (_repo: string, o: { title: string; body: string; head: string; base: string; draft?: boolean }): Promise<PrRef> => ({
        number: 12,
        html_url: MR_URL,
        node_id: "",
        draft: Boolean(o.draft),
      }),
    ),
    commentOnPr: vi.fn(async (_repo: string, _number: number, _body: string) => {}),
    updatePr: vi.fn(async (_repo: string, _number: number, _patch: { title?: string; body?: string }) => {}),
    markReady: vi.fn(async (_repo: string, _pr: PrRef) => {}),
    getPull: notUsed("getPull"),
    prFeedback: vi.fn(async () => []),
    issueComments: vi.fn(async () => []),
    prWebUrl: vi.fn((_repo: string, n: number) => `https://gitlab.example.com/acme/web/-/merge_requests/${n}`),
    checksFor: vi.fn(async (_repo: string, _sha: string): Promise<{ checks: CheckInfo[]; statuses: StatusInfo[] }> => ({ checks: [], statuses: [] })),
    checkAnnotations: vi.fn(async (_repo: string, _check: CheckInfo) => [{ path: "src/app.ts", startLine: 3, level: "failure", title: null, message: "Expected 2" }]),
    jobLog: vi.fn(async (_repo: string, _check: CheckInfo): Promise<string | undefined> => undefined),
    deploymentsFor: vi.fn(async () => []),
    deploymentStatuses: vi.fn(async () => []),
    listRepos: notUsed("listRepos"),
    recentCommits: notUsed("recentCommits"),
    listPulls: notUsed("listPulls"),
    listIssues: notUsed("listIssues"),
    readFile: notUsed("readFile"),
    searchCode: notUsed("searchCode"),
  } satisfies CodeHost;
}

describe("git through the code host", () => {
  it("clones with the host's URL and auth arguments, only on commands that need them, and authors commits as the host says", async () => {
    const host = fakeHost();
    const calls: { args: string[]; cwd: string; env: NodeJS.ProcessEnv }[] = [];
    const run: ExecFile = async (_file, args, opts) => {
      calls.push({ args, cwd: opts.cwd, env: opts.env });
      return { stdout: "\n" };
    };
    const git = gitRunner({ host, cwd: "/work/repo", home: "/work-git/home", redact: makeRedactor(host.secrets()), run });
    const out = await checkoutRepo({ host, repo: "gitlab:acme/platform/web", dir: "/work/repo", workRoot: "/work", git, pointerName: "Pointer", redact: (t) => t });

    expect(out).toEqual({ base: "main", author: { name: "Pointer (via octo-dev)", email: "octo-dev@example.com" } });
    expect(calls[0]!.args).toEqual([
      ...GIT_SAFETY_ARGS,
      "-c",
      `http.https://gitlab.example.com/.extraheader=${HOST_HEADER}`,
      "clone",
      "--depth",
      "50",
      "--no-tags",
      "https://gitlab.example.com/acme/platform/web.git",
      "/work/repo",
    ]);
    expect(calls[0]!.cwd).toBe("/work");
    // Only the clone carries the credentials; nothing is written into .git/config.
    expect(calls.slice(1).map((c) => c.args)).toEqual([
      [...GIT_SAFETY_ARGS, "config", "user.name", "Pointer (via octo-dev)"],
      [...GIT_SAFETY_ARGS, "config", "user.email", "octo-dev@example.com"],
    ]);
    expect(calls.slice(1).every((c) => c.cwd === "/work/repo")).toBe(true);
    expect(host.defaultBranch).toHaveBeenCalledWith("gitlab:acme/platform/web");
  });

  it("runs every git command with no hooks, no fsmonitor and only a minimal environment, never the worker's", async () => {
    expect(GIT_SAFETY_ARGS).toEqual(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "commit.gpgSign=false"]);
    const envs: NodeJS.ProcessEnv[] = [];
    const run: ExecFile = async (_file, _args, opts) => {
      envs.push(opts.env);
      return { stdout: "" };
    };
    const saved = { MASTER_KEY: process.env.MASTER_KEY, TASK_B64: process.env.TASK_B64 };
    process.env.MASTER_KEY = "master-key-of-the-worker-000000";
    process.env.TASK_B64 = "eyJ0YXNrSWQiOiJ0LTEifQ==";
    try {
      const git = gitRunner({ host: fakeHost(), cwd: "/w/repo", home: "/w-git/home", redact: (t) => t, run });
      await git(["status"]);
      await git(["fetch", "origin", "main"], { auth: true });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    for (const env of envs) {
      expect(Object.keys(env).sort()).toEqual(["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "PATH"]);
      expect(env).toMatchObject({ HOME: "/w-git/home", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" });
      expect(JSON.stringify(env)).not.toMatch(/master-key-of-the-worker|eyJ0YXNrSWQi|GIT_CONFIG_PARAMETERS/);
    }
    expect(gitEnv("/h")).not.toHaveProperty("GIT_CONFIG_PARAMETERS");
  });

  it("refuses a clone URL that carries credentials or is not https, before running git", async () => {
    for (const url of [`https://oauth2:${HOST_TOKEN}@gitlab.example.com/acme/web.git`, "http://gitlab.example.com/acme/web.git", "ext::sh -c touch% /tmp/x"]) {
      const host = fakeHost();
      host.cloneUrl.mockReturnValue(url);
      const git = vi.fn(async () => "");
      const err = await checkoutRepo({ host, repo: "gitlab:acme/web", dir: "/w/repo", workRoot: "/w", git, pointerName: "Pointer", redact: (t) => t }).catch(
        (e: Error) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain(HOST_TOKEN);
      expect(git).not.toHaveBeenCalled();
    }
  });

  it("authors commits with the host's fallback when the token owner cannot be looked up", async () => {
    const host = fakeHost();
    host.viewer.mockRejectedValue(new Error(`GitLab GET /user failed (HTTP 401): ${HOST_TOKEN}`));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const git = vi.fn(async (_args: string[]) => "");
    const out = await checkoutRepo({ host, repo: "gitlab:acme/web", dir: "/w/repo", workRoot: "/w", git, pointerName: "Pointer", redact: makeRedactor(host.secrets()) });
    expect(out.author).toEqual({ name: "Pointer", email: FALLBACK_COMMIT_EMAIL });
    expect(JSON.stringify(errors.mock.calls)).not.toContain(HOST_TOKEN);
    errors.mockRestore();
  });

  it("redacts the host's credentials from git errors, even with a redactor that does not know them", async () => {
    const host = fakeHost();
    const run: ExecFile = async (_file, args) => {
      throw Object.assign(new Error(`Command failed: git ${args.join(" ")}`), { stderr: "" });
    };
    for (const redact of [makeRedactor(host.secrets()), (t: string) => t]) {
      const git = gitRunner({ host, cwd: "/w/repo", home: "/w-git/home", redact, run });
      const err = (await git(["push", "origin", "HEAD:refs/heads/army/x"], { auth: true }).catch((e: Error) => e)) as Error;
      expect(err.message).toMatch(/^git push failed: Command failed: git /);
      for (const secret of [HOST_TOKEN, HOST_HEADER, HOST_HEADER.split(" ").pop()!]) expect(err.message).not.toContain(secret);
    }
  });
});

describe("the worker's git against what the agents planted (real git)", () => {
  const plainGit = promisify(execFile);
  /** The test's own git, for setting up and for playing an agent: no user or system config. */
  const testEnv = (home: string) => ({ PATH: process.env.PATH ?? "", HOME: home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  const HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-push", "post-checkout", "reference-transaction", "pre-auto-gc"];

  it("commits and publishes without running planted hooks, filters or fsmonitor, and pushes only to the host", { timeout: 60_000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "army-git-test-")));
    try {
      const home = join(root, "home");
      await mkdir(home);
      const sh = async (cwd: string, ...args: string[]) =>
        (await plainGit("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { cwd, env: testEnv(home) })).stdout.trim();

      // The host's repository, with more history than the worker's depth-50 clone takes, and one the agents would push to instead.
      const remote = join(root, "remote.git");
      const attacker = join(root, "attacker.git");
      const seed = join(root, "seed");
      await sh(root, "init", "--quiet", "--bare", remote);
      await sh(root, "init", "--quiet", "--bare", attacker);
      // So the control push below (from the shallow checkout) is accepted there.
      await sh(root, "--git-dir", attacker, "config", "receive.shallowUpdate", "true");
      await sh(root, "init", "--quiet", seed);
      await writeFile(join(seed, "README.md"), "# web\n");
      await sh(seed, "add", "-A");
      for (let i = 0; i < 55; i += 1) await sh(seed, "commit", "--quiet", "--allow-empty", "-m", `commit ${i}`);
      await sh(seed, "push", "--quiet", remote, "HEAD:refs/heads/main");
      await sh(remote, "symbolic-ref", "HEAD", "refs/heads/main");

      // The host: an https URL that the auth arguments point at the local repository (url.insteadOf),
      // next to the auth header, so every authenticated command carries the header as it would.
      const header = `Authorization: Basic ${Buffer.from(`oauth2:${HOST_TOKEN}`).toString("base64")}`;
      const basic = header.split(" ").pop()!;
      const host = fakeHost();
      host.cloneUrl.mockReturnValue("https://gitlab.example.com/acme/web.git");
      host.gitAuthArgs.mockReturnValue([
        "-c",
        `url.file://${remote}.insteadOf=https://gitlab.example.com/acme/web.git`,
        "-c",
        `http.https://gitlab.example.com/.extraheader=${header}`,
      ]);
      const gitHome = join(root, "git-private", "home");
      await mkdir(gitHome, { recursive: true });
      const repoDir = join(root, "work", "repo");
      await mkdir(join(root, "work"));
      const git = gitRunner({ host, cwd: repoDir, home: gitHome, redact: makeRedactor([HOST_TOKEN, header, basic]) });
      await checkoutRepo({ host, repo: "gitlab:acme/web", dir: repoDir, workRoot: join(root, "work"), git, pointerName: "Pointer", redact: (t) => t });
      expect(await readFile(join(repoDir, ".git", "shallow"), "utf8")).not.toBe("");
      await git(["checkout", "--quiet", "-b", "army/sidebar"]);
      const restore = await snapshotGitConfig(repoDir);

      // What an agent could leave behind: hooks in .git/hooks and in a core.hooksPath folder, a clean
      // filter for every file, an fsmonitor program, a pack-objects hook, a signing program, and remote,
      // push and proxy settings. Each program writes its environment to a ran-* file.
      const evil = join(root, "evil");
      await mkdir(evil);
      const ran = (name: string) => join(root, `ran-${name}`);
      const program = async (path: string, name: string, passThrough = false) => {
        await writeFile(path, `#!/bin/sh\nenv > "${ran(name)}"\n${passThrough ? "cat\n" : "exit 0\n"}`);
        await chmod(path, 0o755);
      };
      for (const hook of HOOKS) {
        await program(join(evil, hook), `hooks-path-${hook}`);
        await program(join(repoDir, ".git", "hooks", hook), `hooks-${hook}`);
      }
      for (const name of ["fsmonitor", "pack-hook", "gpg"]) await program(join(evil, name), name);
      await program(join(evil, "filter"), "filter", true);
      const plant = async () => {
        for (const [key, value] of [
          ["core.hooksPath", evil],
          ["remote.origin.url", `file://${attacker}`],
          ["remote.origin.pushurl", `file://${attacker}`],
          ["filter.evil.clean", join(evil, "filter")],
          ["filter.evil.required", "true"],
          ["core.fsmonitor", join(evil, "fsmonitor")],
          ["uploadpack.packObjectsHook", join(evil, "pack-hook")],
          ["commit.gpgSign", "true"],
          ["gpg.program", join(evil, "gpg")],
          ["http.proxy", "http://127.0.0.1:9"],
        ]) {
          await sh(repoDir, "config", key!, value!);
        }
      };
      await plant();
      await writeFile(join(repoDir, ".gitattributes"), "* filter=evil\n");
      await writeFile(join(repoDir, "app.txt"), "hello\n");

      // The worker's publish: its own config back before each command, then a push from a fresh bare repository.
      const afterAgents: GitRun = async (args, opts) => {
        await restore();
        return git(args, opts);
      };
      await afterAgents(["add", "-A"]);
      expect(await afterAgents(["status", "--porcelain"])).not.toBe("");
      await afterAgents(commitArgs("Collapse the sidebar (ACME-12 #done)"));
      // A process the agents left running plants it all again before the push.
      await plant();
      const privateDir = join(root, "git-private");
      await publishBranch({ host, repo: "gitlab:acme/web", repoDir, branch: "army/sidebar", git, tmp: privateDir });

      // A fix round: another commit, pushed again (a fast-forward of the same branch).
      await writeFile(join(repoDir, "app.txt"), "hello again\n");
      await afterAgents(["add", "-A"]);
      await afterAgents(commitArgs("Fix failing checks: ACME-12 #time 1h"));
      await plant();
      await publishBranch({ host, repo: "gitlab:acme/web", repoDir, branch: "army/sidebar", git, tmp: privateDir });

      const inRemote = (...args: string[]) => sh(root, "--git-dir", remote, ...args);
      expect(await inRemote("log", "--format=%s", "-2", "refs/heads/army/sidebar")).toBe(
        "Fix failing checks: ACME-12 ＃time 1h\nCollapse the sidebar (ACME-12 ＃done)",
      );
      expect(await inRemote("show", "refs/heads/army/sidebar:app.txt")).toBe("hello again");
      expect(await inRemote("rev-parse", "refs/heads/army/sidebar")).toBe(await sh(repoDir, "rev-parse", "HEAD"));
      // Nothing went where the agents pointed origin, nothing they planted ran, and no bare repository is left over.
      expect(await sh(root, "--git-dir", attacker, "for-each-ref")).toBe("");
      expect((await readdir(root)).filter((f) => f.startsWith("ran-"))).toEqual([]);
      expect(await readdir(privateDir)).toEqual(["home"]);
      // The worker's own config is back in the checkout after its commands.
      await restore();
      expect(await sh(repoDir, "config", "--get", "core.hooksPath").catch(() => "")).toBe("");

      // Control: the same push as an agent would run it does fire the traps, with the header in reach.
      await plant();
      await plainGit("git", ["-c", `http.https://gitlab.example.com/.extraheader=${header}`, "push", "--quiet", "origin", "HEAD:refs/heads/stolen"], {
        cwd: repoDir,
        env: testEnv(home),
      });
      expect(await sh(root, "--git-dir", attacker, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/stolen");
      expect(await readFile(ran("hooks-path-pre-push"), "utf8")).toContain(basic);
      // …and a plain `git add` with their config runs their clean filter.
      await writeFile(join(repoDir, "app.txt"), "changed\n");
      await sh(repoDir, "add", "-A");
      expect((await readdir(root)).filter((f) => f.startsWith("ran-"))).toContain("ran-filter");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses to push to an unsafe branch name or a URL that is not plain https, before running git", async () => {
    const git = vi.fn(async (_args: string[]) => "");
    const host = fakeHost();
    for (const branch of ["+refs/heads/main", "main:refs/heads/other", "-delete", "a..b", "x.lock", "a b", "feature/"]) {
      await expect(publishBranch({ host, repo: "gitlab:acme/web", repoDir: "/w/repo", branch, git, tmp: tmpdir() })).rejects.toThrow("Not pushing");
    }
    host.cloneUrl.mockReturnValue(`https://oauth2:${HOST_TOKEN}@gitlab.example.com/acme/web.git`);
    const err = (await publishBranch({ host, repo: "gitlab:acme/web", repoDir: "/w/repo", branch: "army/x", git, tmp: tmpdir() }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("not plain https");
    expect(err.message).not.toContain(HOST_TOKEN);
    expect(git).not.toHaveBeenCalled();
  });

  it("puts the worker's .git/config back, and refuses a .git that is no longer a folder", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "army-config-test-")));
    try {
      const repoDir = join(root, "repo");
      await mkdir(join(repoDir, ".git"), { recursive: true });
      await writeFile(join(repoDir, ".git", "config"), "[user]\n\tname = Pointer\n");
      const restore = await snapshotGitConfig(repoDir);
      await writeFile(join(repoDir, ".git", "config"), "[filter \"x\"]\n\tclean = ./steal\n");
      await restore();
      expect(await readFile(join(repoDir, ".git", "config"), "utf8")).toBe("[user]\n\tname = Pointer\n");

      // A config that is now a link elsewhere is replaced, never written through.
      const elsewhere = join(root, "elsewhere");
      await writeFile(elsewhere, "untouched");
      await rm(join(repoDir, ".git", "config"));
      await symlink(elsewhere, join(repoDir, ".git", "config"));
      await restore();
      expect(await readFile(elsewhere, "utf8")).toBe("untouched");
      expect(await readFile(join(repoDir, ".git", "config"), "utf8")).toBe("[user]\n\tname = Pointer\n");

      await rm(join(repoDir, ".git"), { recursive: true });
      await writeFile(join(repoDir, ".git"), "gitdir: /elsewhere\n");
      await expect(restore()).rejects.toThrow("no longer a folder");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("commit messages and Jira Smart Commits", () => {
  it("neutralises a #command after an issue key, on every line, and leaves the rest alone", () => {
    expect(smartCommitSafe("ACME-1 #done")).toBe("ACME-1 ＃done");
    expect(smartCommitSafe("Fix the login (ACME-12) #comment fixed it #time 2h #resolve")).toBe("Fix the login (ACME-12) ＃comment fixed it ＃time 2h ＃resolve");
    expect(smartCommitSafe("Fixes #12 and #34, see #docs")).toBe("Fixes #12 and #34, see #docs");
    expect(smartCommitSafe("ACME-1: fixes #12")).toBe("ACME-1: fixes #12");
    expect(smartCommitSafe("#done before ACME-1")).toBe("#done before ACME-1");
    expect(smartCommitSafe("Title\n\nBody without a key #done\nacme-7 #close")).toBe("Title\n\nBody without a key #done\nacme-7 ＃close");
  });

  it("commits without hooks and with the neutralised message", () => {
    expect(commitArgs("Ship it: ACME-3 #done")).toEqual(["commit", "--quiet", "--no-verify", "-m", "Ship it: ACME-3 ＃done"]);
  });
});

describe("pull and merge requests through the code host", () => {
  const report: Report = { kind: "change", title: "Collapse the sidebar", summary: "Collapses under 768px.", verification: "", risks: "", projectNotes: "" };

  it("opens a merge request on a gitlab: repository, worded as one", async () => {
    const host = fakeHost();
    const { pr, updated } = await publishPr({ host, repo: "gitlab:acme/web", branch: "army/sidebar", base: "main", title: report.title, body: "Body", redact: (t) => t });
    expect(updated).toBe(false);
    expect(host.createPr).toHaveBeenCalledWith("gitlab:acme/web", { title: "Collapse the sidebar", body: "Body", head: "army/sidebar", base: "main" });
    expect(`Opened ${prLabel(pr.number, host.kind)}: ${report.title}`).toBe("Opened merge request !12: Collapse the sidebar");
    expect(resultHeadline({ userId: "U1", title: report.title, outcome: "published", prUrl: pr.html_url, host: host.kind })).toBe(
      `:white_check_mark: <@U1> *Collapse the sidebar* — <${MR_URL}|review the merge request>`,
    );
  });

  it("keeps GitHub's wording byte for byte", () => {
    const url = "https://github.com/acme/web/pull/3";
    expect(resultHeadline({ userId: "U1", title: "T", outcome: "published", prUrl: url })).toBe(`:white_check_mark: <@U1> *T* — <${url}|review the pull request>`);
    expect(resultHeadline({ userId: "U1", title: "T", outcome: "blocked" })).toBe(":warning: <@U1> *Blocked: T*");
    expect(resultHeadline({ userId: "U1", title: "T", outcome: "answered" })).toBe(":speech_balloon: <@U1> *T*");
    expect(prLabel(3)).toBe("pull request #3");
    expect(prRef(3, "bitbucket")).toBe("#3");
    expect(prLabel(3, "bitbucket")).toBe("pull request #3");
  });

  it("updates the open request on the branch: an update comment, and a draft becomes ready with the finished title", async () => {
    const host = fakeHost();
    const draft: PrRef = { number: 12, html_url: MR_URL, node_id: "", draft: true };
    host.findOpenPr.mockResolvedValue(draft);
    const { pr, updated } = await publishPr({ host, repo: "gitlab:acme/web", branch: "army/sidebar", base: "main", title: "T", body: "B", redact: (t) => t });
    expect([pr, updated]).toEqual([draft, true]);
    expect(host.createPr).not.toHaveBeenCalled();
    expect(host.commentOnPr).toHaveBeenCalledWith("gitlab:acme/web", 12, "**Update: T**\n\nB");
    expect(host.markReady).toHaveBeenCalledWith("gitlab:acme/web", draft);
    expect(host.updatePr).toHaveBeenCalledWith("gitlab:acme/web", 12, { title: "T", body: "B" });
  });

  it("saves unfinished work in a new draft (building its body only then), or comments on the open request", async () => {
    const host = fakeHost();
    const body = vi.fn(async () => "Draft body");
    const saved = await saveUnfinishedPr({ host, repo: "gitlab:acme/web", branch: "army/x", base: "main", title: "WIP: x", body, comment: "Stopped" });
    expect(saved.draft).toBe(true);
    expect(host.createPr).toHaveBeenCalledWith("gitlab:acme/web", { title: "WIP: x", body: "Draft body", head: "army/x", base: "main", draft: true });

    const open = fakeHost();
    open.findOpenPr.mockResolvedValue({ number: 12, html_url: MR_URL, node_id: "", draft: false });
    const lazy = vi.fn(async () => "never");
    await saveUnfinishedPr({ host: open, repo: "gitlab:acme/web", branch: "army/x", base: "main", title: "WIP: x", body: lazy, comment: "Stopped" });
    expect(open.commentOnPr).toHaveBeenCalledWith("gitlab:acme/web", 12, "Stopped");
    expect(open.createPr).not.toHaveBeenCalled();
    expect(lazy).not.toHaveBeenCalled();
  });

  it("says where a stopped task's work is, in the host's words", () => {
    const text = stoppedSlackText({ userId: "U1", reason: "Timed out.", pr: { html_url: MR_URL, number: 12, draft: true }, cost: "", host: "gitlab" });
    expect(text).toContain(`saved in a draft merge request: <${MR_URL}|!12>`);
  });

  it("tells the team a review on GitLab started the follow-up", () => {
    const prompt = taskPrompt({ userId: "octo-dev", instruction: "Address the feedback", trigger: "review", repo: "gitlab:acme/web", base: "main", branch: "army/x", resumed: true, attachments: 0 });
    expect(prompt).toContain("Request from GitLab (user octo-dev):");
    expect(prompt).toContain("This follow-up was started by feedback on the merge request, not by a message in Slack.");
  });
});

describe("following the checks through the code host", () => {
  const failing: CheckInfo = {
    id: 7,
    name: "test",
    status: "completed",
    conclusion: "failure",
    detailsUrl: "https://gitlab.example.com/acme/web/-/jobs/7",
    title: null,
    summary: null,
    text: null,
    app: "gitlab-ci",
  };
  const passing: CheckInfo = { ...failing, id: 8, conclusion: "success", detailsUrl: "https://gitlab.example.com/acme/web/-/jobs/8" };
  const fixed: Report = { kind: "change", title: "Fix the failing test", summary: "Fixed the sum.", verification: "npm test passes", risks: "", projectNotes: "" };

  function setup(o: { run?: { report?: Report; failure?: string }; budget?: number } = {}) {
    const host = fakeHost();
    host.checksFor.mockImplementation(async (_repo, sha) => ({ checks: [sha === "sha-1" ? failing : passing], statuses: [] }));
    host.jobLog.mockResolvedValue(`$ npm test\nFAIL src/app.test.ts\nauth: ${HOST_TOKEN}`);
    let head = "sha-1";
    const gitCalls: string[][] = [];
    const git: GitRun = async (args) => {
      gitCalls.push(args);
      if (args[0] === "rev-parse") return head;
      if (args[0] === "status") return "M src/app.ts";
      if (args[0] === "commit") head = "sha-2";
      if (args[0] === "rev-list") return head === "sha-2" ? "1" : "0";
      return "";
    };
    let t = 0;
    const stages: string[] = [];
    const events: { kind: string; text: string }[] = [];
    const task: Pick<Task, "ci" | "fixRound"> = {};
    const push = vi.fn(async () => "");
    const runRound = vi.fn(async (_prompt: string, _o: { budgetUsd: number; runMs: number; since: string; phaseLabel: string }) => o.run ?? { report: fixed });
    const d: FollowChecksDeps = {
      host,
      repo: "gitlab:acme/web",
      pr: { number: 12 },
      limits: { ciWaitMin: 15, ciFixRounds: 2 },
      deadline: undefined,
      base: "main",
      branch: "army/x",
      request: "Fix the sum",
      budgetLeft: () => o.budget ?? 10,
      git,
      push,
      runRound,
      task,
      timeline: { add: (e) => void events.push({ kind: e.kind, text: e.text }), checks: () => {} },
      onStage: async (text) => void stages.push(text),
      progress: async () => {},
      redact: makeRedactor(host.secrets()),
      now: () => t,
      wait: { pollMs: 1000, graceMs: 0, now: () => t, sleep: async (ms) => void (t += ms) },
    };
    return { d, host, git, gitCalls, push, runRound, stages, events, task };
  }

  it("waits, has the team fix a failing job with the host's annotations and log, pushes, comments and waits again", async () => {
    const { d, host, push, runRound, stages, events, task } = setup();
    const result = await followPrChecks(d);

    expect(result?.outcome).toMatchObject({ state: "passed", fixRounds: 1 });
    expect(host.checksFor).toHaveBeenCalledWith("gitlab:acme/web", "sha-1");
    expect(host.checksFor).toHaveBeenCalledWith("gitlab:acme/web", "sha-2");
    expect(host.checkAnnotations).toHaveBeenCalledWith("gitlab:acme/web", failing);
    expect(host.jobLog).toHaveBeenCalledWith("gitlab:acme/web", failing);

    const [prompt, opts] = runRound.mock.calls[0]!;
    expect(prompt).toContain("The merge request's checks failed after your last push (fix round 1 of 2)");
    expect(prompt).toContain("What failed (from GitLab;");
    expect(prompt).toContain("- src/app.ts:3 failure: Expected 2");
    expect(prompt).toContain("FAIL src/app.test.ts");
    expect(prompt).not.toContain(HOST_TOKEN);
    expect(opts).toMatchObject({ budgetUsd: 10, since: "sha-1", phaseLabel: "Fixing the failing checks (round 1 of 2)" });

    expect(push).toHaveBeenCalledTimes(1);
    expect(host.commentOnPr).toHaveBeenCalledWith("gitlab:acme/web", 12, expect.stringContaining("**Fixed failing checks (round 1):** Fix the failing test"));
    expect(stages).toEqual(["Waiting for the merge request's checks", "Fixing the failing checks (round 1 of 2)", "Waiting for the merge request's checks"]);
    expect(events.map((e) => e.kind)).toEqual(["checks", "fix-round", "push", "checks"]);
    expect(task.fixRound).toMatchObject({ round: 1, rounds: 2, failing: ["test"] });
    expect(task.ci).toEqual({ state: "passed", fixRounds: 1, names: [], total: 1 });
  });

  it("pushes nothing when the fix stops early or is blocked, or the budget is too small", async () => {
    const stopped = setup({ run: { failure: "Timed out after 25 minutes." } });
    expect(await followPrChecks(stopped.d)).toMatchObject({ outcome: { state: "failed" }, note: "Fixing the checks stopped early: Timed out after 25 minutes." });
    expect(stopped.push).not.toHaveBeenCalled();

    const blocked = setup({ run: { report: { ...fixed, kind: "blocked", title: "Needs a secret" } } });
    expect((await followPrChecks(blocked.d))?.note).toContain("**Checks blocked: Needs a secret**");
    expect(blocked.push).not.toHaveBeenCalled();

    const poor = setup({ budget: 0.5 });
    expect((await followPrChecks(poor.d))?.note).toBe("Not enough of the task's budget was left to fix them.");
    expect(poor.runRound).not.toHaveBeenCalled();
    expect(poor.host.commentOnPr).not.toHaveBeenCalled();
  });
});

describe("teamQueryOptions with a browser", () => {
  const shotsDir = "/work/army-1/screenshots";

  it("gives the browser tools and server to agents that can run commands, and opens the screenshots folder", () => {
    const config = baseConfig();
    config.team.agents.push(designer);
    const browser = browserServer(shotsDir, { PATH: "/usr/bin" });
    const opts = teamQueryOptions(config, { browser: { shotsDir } }, undefined, { browser });
    for (const id of ["coder", "reviewer", "qa"]) {
      expect(opts.agents[id]!.tools).toEqual(expect.arrayContaining(BROWSER_TOOLS));
      expect(opts.agents[id]!.mcpServers).toEqual([{ [BROWSER_SERVER]: browser }]);
    }
    // "Looks only" agents cannot start the app, so they get no browser.
    for (const id of ["researcher", "designer"]) {
      expect(opts.agents[id]!.tools).not.toContain(BROWSER_TOOLS[0]);
      expect(opts.agents[id]!.mcpServers).toBeUndefined();
    }
    expect(opts.allowedTools).toEqual(expect.arrayContaining(BROWSER_TOOLS));
    expect(opts.additionalDirectories).toEqual([shotsDir]);
    expect(opts.systemPrompt).toEqual({
      type: "preset",
      preset: "claude_code",
      append: orchestratorPrompt(config, { browser: { shotsDir } }),
    });
  });

  it("has no browser tools and no screenshots folder without a browser", () => {
    const opts = teamQueryOptions(baseConfig(), {}, undefined, {});
    expect(opts.allowedTools).not.toContain(BROWSER_TOOLS[0]);
    expect(opts.agents.coder!.mcpServers).toBeUndefined();
    expect(opts).not.toHaveProperty("additionalDirectories");
  });

  it("opens both the shared files and the screenshots folder", () => {
    const attachments: SharedFile[] = [{ path: "/work/army-1/attachments/a.png", name: "a.png", size: 1 }];
    const opts = teamQueryOptions(baseConfig(), { attachments, browser: { shotsDir } }, "/work/army-1/attachments", {
      browser: browserServer(shotsDir, {}),
    });
    expect(opts.additionalDirectories).toEqual(["/work/army-1/attachments", shotsDir]);
  });
});

describe("secrets of the repo setup and the webhook", () => {
  it("redacts the webhook secret and every repository's variable values", () => {
    const config = ConfigSchema.parse({
      github: { webhookSecret: "whsec_0123456789abcdefghij" },
      repoSetup: {
        "acme/web": { env: { DATABASE_URL: "postgres://user:pw@db/app", STRIPE_KEY: "sk_test_123456" } },
        "acme/api": { env: { API_TOKEN: "api-token-abcdef", PORT: "3000" } },
      },
    });
    const redact = makeRedactor(configSecrets(config));
    const text = redact("whsec_0123456789abcdefghij postgres://user:pw@db/app sk_test_123456 api-token-abcdef port 3000");
    expect(text).toBe("[redacted] [redacted] [redacted] [redacted] port 3000");
  });

  it("leaves plain words and numbers readable", () => {
    const config = ConfigSchema.parse({
      repoSetup: { "acme/web": { env: { NODE_ENV: "development", PORT: "3000", API_KEY: "key-abcdef-123" } } },
    });
    const redact = makeRedactor(configSecrets(config));
    expect(redact("development build on 3000 with key-abcdef-123")).toBe("development build on 3000 with [redacted]");
  });

  it("redacts a long secret whole even when a shorter one is part of it", () => {
    const redact = makeRedactor(["abcdef", "xx-abcdef-yy-long-token"]);
    expect(redact("token xx-abcdef-yy-long-token and abcdef")).toBe("token [redacted] and [redacted]");
  });
});

const PLAN: PlanItem[] = [
  { content: "Read the login code", status: "completed" },
  { content: "Fix the button handler", status: "in_progress" },
  { content: "Add a test", status: "pending" },
];

describe("unfinished work in a draft pull request", () => {
  it("titles the draft with the request's first line, short", () => {
    expect(wipTitle("Fix the login button\nIt does nothing on mobile")).toBe("WIP: Fix the login button");
    expect(wipTitle("\n  Make it faster  ")).toBe("WIP: Make it faster");
    const long = wipTitle("x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(5 + 60);
    expect(long.endsWith("…")).toBe(true);
    expect(wipTitle("  ")).toBe("WIP: unfinished task");
  });

  it("writes the plan as a Markdown checklist", () => {
    expect(planChecklist(PLAN)).toBe("- [x] Read the login code\n- [ ] ▶ Fix the button handler\n- [ ] Add a test");
  });

  it("explains the stop, the plan, the size of the work and how to continue, with the usual footer", () => {
    const footer = prFooter("task-1", "Pointer");
    const body = draftPrBody({ reason: "Timed out after 50 minutes.", plan: PLAN, filesChanged: 3, screenshots: 2, footer });
    expect(body).toBe(
      [
        "**Stopped early:** Timed out after 50 minutes.",
        "The team did not finish this task; this draft keeps its work so far.",
        `### Plan\n${planChecklist(PLAN)}`,
        "3 files changed.",
        'Reply in the Slack thread (for example "continue") to pick it up on this branch.',
        "### Screenshots\n2 screenshots from the browser checks are in the Slack thread.",
        "---\nRequested in Slack · task `task-1` · built by Pointer and the team. A human must review and merge.",
      ].join("\n\n"),
    );
    const bare = draftPrBody({ reason: "Stopped.", plan: [], filesChanged: 1, screenshots: 0, footer });
    expect(bare).not.toContain("### Plan");
    expect(bare).not.toContain("### Screenshots");
    expect(bare).toContain("1 file changed.");
  });

  it("comments on an open pull request with the reason and the plan", () => {
    expect(stoppedComment("The team stopped early: hit the 200-turn limit.", PLAN)).toBe(
      `**Stopped early:** The team stopped early: hit the 200-turn limit.\n\n${planChecklist(PLAN)}\n\nReply in the Slack thread (for example "continue") to pick it up on this branch.`,
    );
    expect(stoppedComment("Stopped.", [])).not.toContain("- [");
  });

  it("tells the requester where the work is and how to continue", () => {
    const pr = { html_url: "https://github.com/acme/web/pull/7", number: 7, draft: true };
    expect(stoppedSlackText({ userId: "U1", reason: "Timed out after 50 minutes.", pr, cost: " · ~$4.20" })).toBe(
      ':warning: <@U1> Stopped: Timed out after 50 minutes. The unfinished work is saved in a draft pull request: <https://github.com/acme/web/pull/7|#7>. Reply here (for example "continue") to pick it up on the same branch. · ~$4.20',
    );
    expect(stoppedSlackText({ userId: "U1", reason: "x.", pr: { ...pr, draft: false }, cost: "" })).toContain(
      "saved in the pull request: <https://github.com/acme/web/pull/7|#7>",
    );
  });
});

describe("pull request texts", () => {
  it("points to the screenshots in Slack only when there are some", () => {
    expect(screenshotsSection(0)).toBe("");
    expect(screenshotsSection(1)).toBe("### Screenshots\n1 screenshot from the browser checks is in the Slack thread.");
  });

  it("explains a missing Slack scope for screenshots", () => {
    expect(screenshotFailureLine("missing_scope")).toBe(
      "Screenshots could not be posted: the Slack app needs the files:write scope (update the app from the admin page).",
    );
    expect(screenshotFailureLine("not_in_channel")).toBe("Screenshots could not be posted (not_in_channel).");
    expect(screenshotFailureLine(undefined)).toBe("Screenshots could not be posted.");
  });

  it("describes a fix round on the pull request", () => {
    expect(fixComment(1, { title: "Fix the type error", summary: "Typed the handler.", verification: "npm test: 42 passed" })).toBe(
      "**Fixed failing checks (round 1):** Fix the type error\n\nTyped the handler.\n\n### Verification\nnpm test: 42 passed",
    );
    expect(fixComment(2, { title: "t", summary: "s", verification: "" })).toBe("**Fixed failing checks (round 2):** t\n\ns");
  });

  it("formats budgets", () => {
    expect(usd(15)).toBe("$15");
    expect(usd(3.2)).toBe("$3.20");
  });
});

describe("taskPrompt", () => {
  const base = {
    userId: "U1",
    instruction: "Fix the login button",
    repo: "acme/web",
    base: "main",
    branch: "army/fix-login-abc123",
    resumed: false,
    attachments: 0,
  };

  it("states the request and where the team is", () => {
    expect(taskPrompt(base)).toBe(
      [
        "Request from Slack (user U1):",
        "Fix the login button",
        "",
        "Repository: acme/web. Base branch: main. You are on branch: army/fix-login-abc123.",
        "This is a fresh branch off the base branch.",
      ].join("\n"),
    );
  });

  it("continues where a stopped run left off", () => {
    const stopped = { reason: "Timed out after 50 minutes.", at: "2026-11-19T10:00:00.000Z" };
    const prompt = taskPrompt({ ...base, instruction: "continue", resumed: true, stopped });
    expect(prompt).toContain("already contains the team's earlier work");
    expect(prompt).toContain("The previous run stopped early (Timed out after 50 minutes; at 2026-11-19T10:00:00.000Z)");
    expect(prompt).toContain("git diff origin/main...HEAD");
    expect(prompt).toMatch(/continue where it left off/);
    // A fresh branch has none of that work.
    expect(taskPrompt({ ...base, stopped })).not.toContain("stopped early");
  });

  it("says a review started the follow-up and adds the feedback and shared files", () => {
    const prompt = taskPrompt({ ...base, resumed: true, trigger: "review", attachments: 2, feedback: "Feedback on pull request #12…" });
    expect(prompt.startsWith("Request from GitHub (user U1):")).toBe(true);
    expect(prompt).toContain("This follow-up was started by feedback on the pull request");
    expect(prompt).toContain('The requester shared 2 file(s) for this task: see "Files shared for this task"');
    expect(prompt.endsWith("\n\nFeedback on pull request #12…")).toBe(true);
    expect(taskPrompt(base)).not.toContain("feedback on the pull request");
  });
});

describe("time limits", () => {
  const start = 1_000_000;
  const min = 60_000;

  it("ends everything 8 minutes before the job's own limit, when there is one", () => {
    expect(jobDeadline(start, "60")).toBe(start + 52 * min);
    expect(jobDeadline(start, undefined)).toBeUndefined();
    expect(jobDeadline(start, "")).toBeUndefined();
    expect(jobDeadline(start, "abc")).toBeUndefined();
    expect(jobDeadline(start, "0")).toBeUndefined();
  });

  it("reads TASK_TIMEOUT_MIN, falling back to 50 when it is unset, empty or invalid", () => {
    expect(taskTimeoutMin("30")).toBe(30);
    expect(taskTimeoutMin(undefined)).toBe(50);
    expect(taskTimeoutMin("")).toBe(50);
    expect(taskTimeoutMin("0")).toBe(50);
    expect(taskTimeoutMin("soon")).toBe(50);
  });

  it("caps the first run by the deadline", () => {
    expect(firstRunTimeoutMs(50, undefined, start)).toBe(50 * min);
    expect(firstRunTimeoutMs(50, start + 52 * min, start)).toBe(50 * min);
    expect(firstRunTimeoutMs(50, start + 30 * min, start)).toBe(30 * min);
    expect(firstRunTimeoutMs(50, start - min, start)).toBe(min);
  });

  it("gives a fix round at most 25 minutes, leaves room for its checks, and starts none with under 10 minutes left", () => {
    expect(fixRunTimeoutMs(undefined, start)).toBe(FIX_RUN_MAX_MS);
    expect(fixRunTimeoutMs(start + 60 * min, start)).toBe(25 * min);
    expect(fixRunTimeoutMs(start + 20 * min, start)).toBe(12 * min);
    expect(fixRunTimeoutMs(start + 10 * min, start)).toBe(2 * min);
    expect(fixRunTimeoutMs(start + 9 * min, start)).toBeNull();
  });
});

describe("threadStateAfter", () => {
  const run = { repo: "acme/web", branch: "army/x-1", userId: "U2", lastRunAt: "2026-11-19T12:00:00.000Z" };
  const previous: ThreadState = {
    repo: "acme/web",
    branch: "army/x-1",
    prUrl: "https://github.com/acme/web/pull/7",
    prNumber: 7,
    requester: "U1",
    lastRunAt: "2026-11-18T12:00:00.000Z",
    stopped: { reason: "Timed out after 50 minutes.", at: "2026-11-18T12:50:00.000Z" },
  };

  it("records a new pull request and who started the thread", () => {
    expect(threadStateAfter(null, { ...run, pr: { url: "https://github.com/acme/web/pull/9", number: 9 } })).toEqual({
      repo: "acme/web",
      branch: "army/x-1",
      prUrl: "https://github.com/acme/web/pull/9",
      prNumber: 9,
      requester: "U2",
      lastRunAt: "2026-11-19T12:00:00.000Z",
    });
  });

  it("keeps the stop for a draft of unfinished work and clears it once the work is published", () => {
    const stopped = { reason: "Budget.", at: "2026-11-19T12:30:00.000Z" };
    expect(threadStateAfter(previous, { ...run, pr: { url: previous.prUrl!, number: 7 }, stopped })?.stopped).toEqual(stopped);
    const finished = threadStateAfter(previous, { ...run, pr: { url: previous.prUrl!, number: 7 } });
    expect(finished).not.toHaveProperty("stopped");
    expect(finished?.requester).toBe("U1");
  });

  it("only moves lastRunAt when the task published nothing", () => {
    expect(threadStateAfter(previous, run)).toEqual({ ...previous, lastRunAt: run.lastRunAt });
    expect(threadStateAfter({ repo: "acme/web", branch: "b" }, run)).toEqual({
      repo: "acme/web",
      branch: "b",
      requester: "U2",
      lastRunAt: run.lastRunAt,
    });
  });

  it("leaves a thread about another repository, or without state, alone", () => {
    expect(threadStateAfter({ ...previous, repo: "acme/api" }, run)).toBeNull();
    expect(threadStateAfter(null, run)).toBeNull();
  });
});
