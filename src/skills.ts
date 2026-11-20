import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Config, ConfigRepo } from "./core/config.js";
import { decrypt, encrypt } from "./core/crypto.js";
import { encodePath } from "./github.js";
import { connectionForRepo } from "./github-access.js";
import type { Store } from "./core/store.js";
import { SKILLS_PLUGIN, SKILL_NAME_RE, type Team, type TeamSkills } from "./team.js";

/**
 * The team's skills library: Claude skills (a folder with a SKILL.md, whose
 * frontmatter names and describes the skill, plus optional scripts and
 * reference files) the owner installs from a GitHub folder or pastes. Kept in
 * the store, encrypted like the other team data; written out as a local plugin
 * (`.claude-plugin/plugin.json` + `skills/<name>/…`) next to a repo task's
 * checkout, never inside it, and for Pointer's chat in the service's temp dir.
 * Agents get the skills assigned to them preloaded (AgentDefinition.skills);
 * Pointer can load any installed skill with the Skill tool.
 *
 * Store layout: `skills/index.enc` lists the skills (their metadata);
 * `skills/<name>/<version>/<path>` holds each file. A new install of a name
 * gets a new version, so the index switches over in one write; the old
 * version's files are blanked (the store has no delete).
 */

export const SKILL_LIMITS = {
  /** All of one skill's files together. */
  maxBytes: 2 * 1024 * 1024,
  maxFiles: 100,
  /** Folders read from GitHub for one skill (the skill folder included). */
  maxDirs: 40,
  maxSkills: 50,
  maxPathChars: 200,
  maxSegmentChars: 100,
  /** As Claude's skills specification limits it. */
  maxDescriptionChars: 1024,
  /** A SKILL.md pasted on the page. */
  maxPastedBytes: 256 * 1024,
} as const;

export interface SkillSource {
  /** The folder that holds SKILL.md, as https://github.com/<owner>/<repo>/tree/<ref>/<path>. */
  url: string;
  repo?: string;
  path?: string;
  ref?: string;
}

export interface SkillFile {
  path: string;
  size: number;
}

export type SkillAssignment = "all" | string[];

/** One installed skill's metadata record. */
export interface SkillMeta {
  name: string;
  description: string;
  /** Absent for a pasted SKILL.md. */
  source?: SkillSource;
  /** The frontmatter's licence line, if any. */
  license?: string;
  files: SkillFile[];
  bytes: number;
  hasScripts: boolean;
  installedAt: string;
  /** "all" = every agent, including agents added later; a list = those agents (see skillView). */
  assignedTo: SkillAssignment;
  /** Where its files are in the store: skills/<name>/<version>/. */
  version: string;
}

/** A skill as the console shows it: `assignedTo` is "all" or the agents whose skills list names it. */
export type SkillView = Omit<SkillMeta, "version">;

/** What an install would add, shown before the owner installs it. */
export interface SkillPreview {
  /** From the frontmatter; empty when SKILL.md has none. */
  name: string;
  description: string;
  license?: string;
  /** A licence file in the skill's folder: its path and first line (e.g. "Apache License"). */
  licenseFile?: { path: string; title: string };
  source?: SkillSource;
  /** Every file, binaries and unsafe paths included, so the owner sees why an install is refused. */
  files: (SkillFile & { binary?: boolean })[];
  bytes: number;
  hasScripts: boolean;
  /** The frontmatter's fields as text, e.g. allowed-tools. */
  frontmatter: Record<string, string>;
  /** SKILL.md as written, for the page to render. */
  skillMd: string;
  /** Set when a skill of this name is installed: installing replaces it. */
  installed?: { installedAt: string; source?: SkillSource };
  /** Why it cannot be installed; empty when it can. */
  problems: string[];
}

export type SkillInput = { url: string } | { skillMd: string };

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/** `fetch`, or a fake in tests. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ---------- SKILL.md frontmatter ----------

const FM_KEY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*:(?:[ \t]+(.*))?$/;
const BLOCK_HEADER = /^([|>])([+-]?)\d*\s*(?:#.*)?$/;

const unquoteItem = (s: string) => {
  const t = s.trim();
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
};

const ESCAPES: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\", "/": "/", r: "", "0": "", " ": " " };

/** A double- or single-quoted scalar (continuation lines folded with spaces); undefined when the quote is not closed. */
function quoted(text: string): string | undefined {
  const q = text[0]!;
  let out = "";
  for (let i = 1; i < text.length; i++) {
    const c = text[i]!;
    if (q === "'" && c === "'") {
      if (text[i + 1] === "'") {
        out += "'";
        i++;
        continue;
      }
      return /^\s*(#.*)?$/.test(text.slice(i + 1)) ? out : undefined;
    }
    if (q === '"' && c === "\\") {
      const n = text[++i];
      if (n === "u" && /^[0-9a-fA-F]{4}$/.test(text.slice(i + 1, i + 5))) {
        out += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
        i += 4;
      } else if (n !== undefined) out += ESCAPES[n] ?? n;
      continue;
    }
    if (q === '"' && c === '"') return /^\s*(#.*)?$/.test(text.slice(i + 1)) ? out : undefined;
    out += c;
  }
  return undefined;
}

/** One frontmatter value as text: plain, quoted, block (| or >), a list (joined with ", ") or a one-level map. */
function scalar(raw: string, cont: string[]): string | undefined {
  const lines = cont.map((l) => l.replace(/\t/g, "  "));
  const nonEmpty = lines.filter((l) => l.trim());
  if (BLOCK_HEADER.test(raw)) {
    if (!nonEmpty.length) return "";
    const indent = Math.min(...nonEmpty.map((l) => l.length - l.trimStart().length));
    const body = lines.map((l) => (l.trim() ? l.slice(indent) : ""));
    if (raw.startsWith("|")) return body.join("\n").trimEnd();
    // Folded: lines join with spaces, a blank line is a line break.
    return body
      .join("\n")
      .split(/\n{2,}/)
      .map((p) => p.replace(/\n/g, " "))
      .join("\n")
      .trim();
  }
  if (raw.startsWith('"') || raw.startsWith("'")) return quoted([raw, ...nonEmpty.map((l) => l.trim())].join(" "));
  if (raw.startsWith("[")) {
    const flow = [raw, ...nonEmpty.map((l) => l.trim())].join(" ").trim();
    if (!flow.endsWith("]")) return undefined;
    return flow
      .slice(1, -1)
      .split(",")
      .map(unquoteItem)
      .filter(Boolean)
      .join(", ");
  }
  if (raw === "" && nonEmpty.length) {
    const items = nonEmpty.map((l) => l.trim());
    if (items.every((l) => l === "-" || l.startsWith("- "))) {
      return items
        .map((l) => unquoteItem(l.slice(1)))
        .filter(Boolean)
        .join(", ");
    }
    if (/^[A-Za-z0-9_][A-Za-z0-9_.-]*\s*:/.test(items[0]!)) return items.join("; ");
    return items.join(" ");
  }
  const plain = raw.replace(/\s+#.*$/, "").trim();
  return [plain, ...nonEmpty.map((l) => l.trim())].filter(Boolean).join(" ");
}

export type Frontmatter = Result<{ fields: Record<string, string>; body: string }>;

/**
 * The frontmatter block at the top of a SKILL.md: `---`, then `key: value`
 * lines, then `---`. A small YAML subset (plain, quoted and block scalars,
 * lists, one-level maps), enough for skills; every value comes back as text.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const lines = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trimEnd() !== "---") {
    return { ok: false, error: "SKILL.md must start with its frontmatter: a line with ---, then name: and description:, then another ---." };
  }
  const end = lines.findIndex((l, i) => i > 0 && (l.trimEnd() === "---" || l.trimEnd() === "..."));
  if (end < 0) return { ok: false, error: "The frontmatter of SKILL.md is not closed with a --- line." };
  const block = lines.slice(1, end);
  const fields: Record<string, string> = {};
  for (let i = 0; i < block.length; ) {
    const line = block[i]!;
    const lineNo = i + 2;
    if (!line.trim() || line.trimStart().startsWith("#")) {
      i++;
      continue;
    }
    if (/^\s/.test(line)) return { ok: false, error: `Line ${lineNo} of SKILL.md's frontmatter is indented where a new key was expected.` };
    const m = line.trimEnd().match(FM_KEY);
    if (!m) return { ok: false, error: `Line ${lineNo} of SKILL.md's frontmatter is not "key: value".` };
    const key = m[1]!;
    if (Object.hasOwn(fields, key)) return { ok: false, error: `SKILL.md's frontmatter has "${key}" twice.` };
    i++;
    const cont: string[] = [];
    while (i < block.length && (block[i]!.trim() === "" || /^\s/.test(block[i]!))) cont.push(block[i++]!);
    while (cont.length && !cont.at(-1)!.trim()) cont.pop();
    const value = scalar((m[2] ?? "").trim(), cont);
    if (value === undefined) return { ok: false, error: `The value of "${key}" in SKILL.md's frontmatter is not closed (a quote or bracket is missing).` };
    fields[key] = value;
  }
  return { ok: true, fields, body: lines.slice(end + 1).join("\n") };
}

export type ParsedSkillMd = Result<{ name: string; description: string; license?: string; fields: Record<string, string> }>;

/** SKILL.md's frontmatter, checked: a `name` the library can use and a `description`. */
export function parseSkillMd(text: string): ParsedSkillMd {
  const fm = parseFrontmatter(text);
  if (!fm.ok) return fm;
  const name = (fm.fields.name ?? "").trim();
  const description = (fm.fields.description ?? "").trim();
  if (!name) return { ok: false, error: "SKILL.md's frontmatter has no name." };
  if (!SKILL_NAME_RE.test(name)) {
    return {
      ok: false,
      error: `The skill name "${name.slice(0, 80)}" is not valid: use up to 64 lowercase letters, digits and dashes, starting with a letter or digit.`,
    };
  }
  if (!description) return { ok: false, error: "SKILL.md's frontmatter has no description: it tells agents when to use the skill." };
  if (description.length > SKILL_LIMITS.maxDescriptionChars) {
    return { ok: false, error: `The description is ${description.length} characters; skills allow at most ${SKILL_LIMITS.maxDescriptionChars}.` };
  }
  const license = fm.fields.license?.trim().slice(0, 200);
  return { ok: true, name, description, ...(license ? { license } : {}), fields: fm.fields };
}

// ---------- Files: paths, text, scripts, licence ----------

/**
 * A file's path inside a skill, or null when it is unsafe: absolute, a drive
 * letter, a backslash, an empty, "." or ".." segment, control characters, or
 * too long. Paths are kept as written (no normalising), so a stored path is
 * exactly the one that was checked.
 */
export function safeSkillPath(path: string): string | null {
  if (!path || path.length > SKILL_LIMITS.maxPathChars) return null;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path) || path.includes("\\")) return null;
  if (/[\x00-\x1f\x7f]/.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === ".." || s.trim() !== s || s.length > SKILL_LIMITS.maxSegmentChars)) return null;
  return path;
}

/** Extensions that are never text, refused without being downloaded. */
const BINARY_EXTENSIONS = new Set(
  "png jpg jpeg gif webp bmp ico tif tiff psd pdf zip gz tgz bz2 xz 7z rar tar jar war whl egg woff woff2 ttf otf eot mp3 mp4 m4a wav ogg mov avi webm wasm so dylib dll exe bin class pyc pyo o a db sqlite docx xlsx pptx doc xls ppt odt".split(
    " ",
  ),
);

const extensionOf = (path: string) => {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
};

export const hasBinaryExtension = (path: string) => BINARY_EXTENSIONS.has(extensionOf(path));

/** The bytes as UTF-8 text, or null when they are not text (a NUL byte or invalid UTF-8). */
export function decodeText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const SCRIPT_EXTENSIONS = new Set("py sh bash zsh fish js mjs cjs ts mts cts rb pl php ps1 lua r jl go rs swift kts".split(" "));

/** A script: in a scripts/ folder, a code file, or a file that starts with #!. */
export function isScript(path: string, text?: string): boolean {
  if (path.split("/").slice(0, -1).includes("scripts")) return true;
  if (SCRIPT_EXTENSIONS.has(extensionOf(path))) return true;
  return Boolean(text?.startsWith("#!"));
}

const LICENSE_FILE = /^(licen[cs]e|copying)(\.(txt|md))?$/i;

/** A licence file at the top of the skill's folder, with its first line. */
function licenseFileOf(files: { path: string; text?: string }[]): { path: string; title: string } | undefined {
  const file = files.find((f) => !f.path.includes("/") && LICENSE_FILE.test(f.path));
  if (!file) return undefined;
  const title =
    (file.text ?? "")
      .split("\n")
      .map((l) => l.replace(/^#+\s*/, "").trim())
      .find(Boolean) ?? "";
  return { path: file.path, title: title.slice(0, 120) };
}

/** A file as fetched or pasted, before it is checked. `text` is absent for binaries and files that were not read. */
export interface RawFile {
  path: string;
  size: number;
  text?: string;
  binary?: boolean;
  /** Why this file cannot be installed (e.g. a symlink). */
  problem?: string;
}

/** A skill's files, checked against the limits: the preview, with `problems` empty when it can be installed. */
export function checkFiles(files: RawFile[], source?: SkillSource): SkillPreview {
  const problems: string[] = [];
  const skillFile = files.find((f) => f.path === "SKILL.md");
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  let parsed: ParsedSkillMd | undefined;
  let fields: Record<string, string> = {};
  if (!skillFile) problems.push("There is no SKILL.md at the top of this folder.");
  else if (skillFile.text === undefined) problems.push("SKILL.md is not a text file.");
  else {
    parsed = parseSkillMd(skillFile.text);
    if (!parsed.ok) problems.push(parsed.error);
    const fm = parseFrontmatter(skillFile.text);
    if (fm.ok) fields = fm.fields;
  }
  if (files.length > SKILL_LIMITS.maxFiles) problems.push(`It has ${files.length} files; a skill may have at most ${SKILL_LIMITS.maxFiles}.`);
  if (bytes > SKILL_LIMITS.maxBytes) problems.push(`It is ${formatBytes(bytes)}; a skill may be at most ${formatBytes(SKILL_LIMITS.maxBytes)}.`);
  const unsafe = files.filter((f) => safeSkillPath(f.path) === null);
  if (unsafe.length) problems.push(`Unsafe file paths: ${unsafe.map((f) => JSON.stringify(f.path.slice(0, 80))).join(", ")}.`);
  const binaries = files.filter((f) => f.binary || (f.text === undefined && !f.problem && safeSkillPath(f.path) !== null));
  if (binaries.length) {
    const shown = binaries.slice(0, 10).map((f) => f.path).join(", ");
    problems.push(`Only text files can be installed; these are not text: ${shown}${binaries.length > 10 ? ` and ${binaries.length - 10} more` : ""}.`);
  }
  for (const f of files) if (f.problem) problems.push(`${f.path} ${f.problem}`);
  const licenseFile = licenseFileOf(files);
  return {
    name: parsed?.ok ? parsed.name : (fields.name ?? "").trim().slice(0, 80),
    description: parsed?.ok ? parsed.description : (fields.description ?? "").trim().slice(0, SKILL_LIMITS.maxDescriptionChars),
    ...(parsed?.ok && parsed.license ? { license: parsed.license } : {}),
    ...(licenseFile ? { licenseFile } : {}),
    ...(source ? { source } : {}),
    files: files.map((f) => ({ path: f.path, size: f.size, ...(f.binary || (f.text === undefined && !f.problem) ? { binary: true } : {}) })),
    bytes,
    hasScripts: files.some((f) => isScript(f.path, f.text)),
    frontmatter: fields,
    skillMd: skillFile?.text ?? "",
    problems,
  };
}

/**
 * The licence kept with an installed skill: the frontmatter's, with the
 * licence file's first line when that says more (frontmatter often only says
 * "Complete terms in LICENSE.txt"), or the file's first line alone.
 */
export function licenseLine(p: Pick<SkillPreview, "license" | "licenseFile">): string | undefined {
  const title = p.licenseFile?.title;
  if (!p.license) return title ? `${title} (${p.licenseFile!.path})`.slice(0, 200) : undefined;
  return title && !p.license.toLowerCase().includes(title.toLowerCase()) ? `${p.license} (${title})`.slice(0, 200) : p.license;
}

export const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** A pasted SKILL.md as a single-file skill. */
export function pastedFiles(skillMd: string): RawFile[] {
  return [{ path: "SKILL.md", size: Buffer.byteLength(skillMd, "utf8"), text: skillMd }];
}

// ---------- GitHub folders ----------

export interface GitHubSkillLocation {
  owner: string;
  repo: string;
  /** Where the folder may be: the ref and path, tried in order (a branch name can hold slashes). Ref absent = the default branch. */
  candidates: { ref?: string; path: string }[];
}

const GH_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const URL_HELP = "Use the address of a skill's folder on GitHub, like https://github.com/anthropics/skills/tree/main/skills/pdf.";

/**
 * A GitHub skill folder from its URL: https://github.com/<owner>/<repo>, …/tree/<ref>/<path>,
 * or …/blob/<ref>/<path>/SKILL.md (the folder that holds it).
 */
export function parseGitHubSkillUrl(input: string): Result<{ location: GitHubSkillLocation }> {
  const bad = { ok: false as const, error: URL_HELP };
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return bad;
  }
  if (url.protocol !== "https:" || !["github.com", "www.github.com"].includes(url.hostname) || url.username || url.password || url.port) return bad;
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((p) => {
      try {
        return decodeURIComponent(p);
      } catch {
        return "\0";
      }
    });
  const [owner, rawRepo, kind, ...rest] = parts;
  const repo = rawRepo?.replace(/\.git$/, "");
  if (!owner || !repo || !GH_NAME.test(owner) || !GH_NAME.test(repo) || repo === "." || repo === "..") return bad;
  if (kind === undefined) return { ok: true, location: { owner, repo, candidates: [{ path: "" }] } };
  if ((kind !== "tree" && kind !== "blob") || rest.length === 0) return bad;
  let segments = rest;
  if (kind === "blob") {
    if (segments.at(-1) !== "SKILL.md") return { ok: false, error: "That is a file, not a folder. Use the folder that holds SKILL.md, or the address of SKILL.md itself." };
    segments = segments.slice(0, -1);
    if (segments.length === 0) return bad;
  }
  if (segments.some((s) => s === "." || s === ".." || s.includes("\0") || s.includes("\\"))) return bad;
  const candidates: { ref?: string; path: string }[] = [];
  for (let k = 1; k <= Math.min(3, segments.length); k++) candidates.push({ ref: segments.slice(0, k).join("/"), path: segments.slice(k).join("/") });
  return { ok: true, location: { owner, repo, candidates } };
}

const encodeSegments = (path: string) => path.split("/").map(encodeURIComponent).join("/");

const folderUrl = (owner: string, repo: string, ref: string, path: string) =>
  `https://github.com/${owner}/${repo}/tree/${encodeSegments(ref)}${path ? `/${encodeSegments(path)}` : ""}`;

interface ContentsEntry {
  type: string;
  name: string;
  path: string;
  size?: number;
  download_url?: string | null;
}

class GitHubFetchError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Reads a skill folder from GitHub through the contents API. Never puts the token in a URL or an error. */
export async function fetchGitHubSkill(
  location: GitHubSkillLocation,
  opts: { fetch: FetchLike; token?: string },
): Promise<Result<{ files: RawFile[]; source: SkillSource }>> {
  const { owner, repo } = location;
  const repoName = `${owner}/${repo}`;
  const headers = (accept = "application/vnd.github+json"): Record<string, string> => ({
    accept,
    "user-agent": "agent-army",
    "x-github-api-version": "2022-11-28",
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
  });
  const api = async (path: string, accept?: string): Promise<Response> => {
    let res: Response;
    try {
      res = await opts.fetch(`https://api.github.com${path}`, { headers: headers(accept) });
    } catch {
      throw new GitHubFetchError("Couldn't reach GitHub. Try again.", 0);
    }
    if (res.ok) return res;
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 404) throw new GitHubFetchError("not found", 404);
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      throw new GitHubFetchError(
        opts.token
          ? "GitHub's request limit for this connection is used up. Try again later."
          : "GitHub's limit for requests without a token is used up (60 an hour). Try again later, or add a GitHub connection that can read this repository.",
        res.status,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new GitHubFetchError(
        `GitHub refused to read ${repoName} (HTTP ${res.status}). Private repositories need a GitHub connection that is allowed to read them.`,
        res.status,
      );
    }
    throw new GitHubFetchError(`GitHub answered HTTP ${res.status} for ${repoName}.`, res.status);
  };
  const json = async <T>(res: Response): Promise<T> => (await res.json()) as T;
  const contentsPath = (path: string, ref: string) =>
    `/repos/${owner}/${repo}/contents${path ? `/${encodePath(path)}` : ""}?ref=${encodeURIComponent(ref)}`;

  try {
    // The folder: the first ref/path split GitHub knows (branch names may hold slashes).
    let found: { ref: string; path: string; entries: ContentsEntry[] } | undefined;
    for (const candidate of location.candidates) {
      const ref = candidate.ref ?? (await json<{ default_branch?: string }>(await api(`/repos/${owner}/${repo}`))).default_branch ?? "main";
      try {
        const listing = await json<ContentsEntry[] | ContentsEntry>(await api(contentsPath(candidate.path, ref)));
        if (!Array.isArray(listing)) return { ok: false, error: "That is a file, not a folder. Use the folder that holds SKILL.md." };
        found = { ref, path: candidate.path, entries: listing };
        break;
      } catch (err) {
        if (!(err instanceof GitHubFetchError) || err.status !== 404) throw err;
      }
    }
    if (!found) {
      const privateHint = opts.token ? "" : ", or the repository is private: private repositories need a GitHub connection that is allowed to read them";
      return { ok: false, error: `GitHub has no such folder in ${repoName}${privateHint}.` };
    }

    // Every file under the folder, folder by folder, checked against the limits before anything is downloaded.
    const root = found.path;
    const listed: (ContentsEntry & { rel: string })[] = [];
    const others: RawFile[] = [];
    const queue: ContentsEntry[][] = [found.entries];
    let dirs = 1;
    while (queue.length) {
      for (const entry of queue.shift()!) {
        if (root && !entry.path.startsWith(`${root}/`)) return { ok: false, error: "GitHub listed a file outside the folder." };
        const rel = root ? entry.path.slice(root.length + 1) : entry.path;
        if (entry.type === "dir") {
          if (++dirs > SKILL_LIMITS.maxDirs) return { ok: false, error: `This folder has more than ${SKILL_LIMITS.maxDirs} folders; it is too large for a skill.` };
          if (safeSkillPath(rel) === null) others.push({ path: rel, size: 0, problem: "is a folder with an unsafe name." });
          else queue.push(await json<ContentsEntry[]>(await api(contentsPath(entry.path, found.ref))));
        } else if (entry.type === "file") {
          listed.push({ ...entry, rel });
        } else {
          others.push({ path: rel, size: 0, problem: `is a ${entry.type.slice(0, 20)}; a skill can only hold regular files.` });
        }
        if (listed.length + others.length > SKILL_LIMITS.maxFiles) {
          return { ok: false, error: `This folder has more than ${SKILL_LIMITS.maxFiles} files; a skill may have at most ${SKILL_LIMITS.maxFiles}.` };
        }
      }
    }
    const listedBytes = listed.reduce((sum, e) => sum + (e.size ?? 0), 0);
    if (listedBytes > SKILL_LIMITS.maxBytes) {
      return { ok: false, error: `This folder holds ${formatBytes(listedBytes)}; a skill may be at most ${formatBytes(SKILL_LIMITS.maxBytes)}.` };
    }
    if (!listed.some((e) => e.rel === "SKILL.md")) {
      return { ok: false, error: `There is no SKILL.md in ${folderUrl(owner, repo, found.ref, root)}. Use the folder that holds it.` };
    }

    // The files' contents: with a token through the API (private repositories), else raw.githubusercontent.com (no API limit).
    const download = async (entry: ContentsEntry & { rel: string }): Promise<RawFile> => {
      const size = entry.size ?? 0;
      if (hasBinaryExtension(entry.rel)) return { path: entry.rel, size, binary: true };
      if (safeSkillPath(entry.rel) === null) return { path: entry.rel, size, problem: "has an unsafe name." };
      let res: Response;
      if (opts.token) res = await api(contentsPath(entry.path, found!.ref), "application/vnd.github.raw+json");
      else {
        const raw = entry.download_url ?? "";
        if (!raw.startsWith(`https://raw.githubusercontent.com/${owner}/${repo}/`)) throw new GitHubFetchError(`GitHub gave no download address for ${entry.rel}.`, 0);
        try {
          res = await opts.fetch(raw, { headers: { "user-agent": "agent-army" } });
        } catch {
          throw new GitHubFetchError("Couldn't reach GitHub. Try again.", 0);
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new GitHubFetchError(`Couldn't download ${entry.rel} (HTTP ${res.status}).`, res.status);
        }
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const text = decodeText(bytes);
      return text === null ? { path: entry.rel, size: bytes.byteLength, binary: true } : { path: entry.rel, size: bytes.byteLength, text };
    };
    const files: RawFile[] = [];
    for (let i = 0; i < listed.length; i += 6) files.push(...(await Promise.all(listed.slice(i, i + 6).map(download))));
    files.push(...others);
    files.sort((a, b) => (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
    const source: SkillSource = { url: folderUrl(owner, repo, found.ref, root), repo: repoName, ...(root ? { path: root } : {}), ref: found.ref };
    return { ok: true, files, source };
  } catch (err) {
    if (err instanceof GitHubFetchError) return { ok: false, error: err.status === 404 ? `GitHub has no such folder in ${repoName}.` : err.message };
    return { ok: false, error: `Couldn't read the skill from GitHub: ${errorText(err).slice(0, 200)}` };
  }
}

// ---------- The library ----------

const INDEX_KEY = "skills/index.enc";
const fileKey = (name: string, version: string, path: string) => `skills/${name}/${version}/${path}`;

interface Fetched {
  at: number;
  files: RawFile[];
  source?: SkillSource;
}

/** How long a preview's download is kept, so Install installs exactly what was previewed without fetching again. */
const PREVIEW_TTL_MS = 10 * 60_000;
const PREVIEW_CACHE_MAX = 20;

export interface SkillLibraryDeps {
  /** For assignments: agents' skills lists live in the team. Absent = read-only use (the worker). */
  configRepo?: ConfigRepo;
  fetch?: FetchLike;
  now?: () => Date;
  /** How long the index is cached in memory; the web service is the only writer. */
  ttlMs?: number;
}

export class SkillLibrary {
  private cache: { at: number; skills: SkillMeta[] } | undefined;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly fetched = new Map<string, Fetched>();

  constructor(
    private readonly store: Store,
    private readonly key: Buffer,
    private readonly deps: SkillLibraryDeps = {},
  ) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Every installed skill, by name. */
  async list(fresh = false): Promise<SkillMeta[]> {
    const ttl = this.deps.ttlMs ?? 5_000;
    if (!fresh && this.cache && Date.now() - this.cache.at < ttl) return this.cache.skills;
    const blob = await this.store.get(INDEX_KEY);
    const skills = blob && blob.length ? ((JSON.parse(decrypt(this.key, blob)) as { skills?: SkillMeta[] }).skills ?? []) : [];
    const valid = skills.filter((s) => SKILL_NAME_RE.test(s.name)).sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { at: Date.now(), skills: valid };
    return valid;
  }

  async get(name: string): Promise<SkillMeta | undefined> {
    return (await this.list()).find((s) => s.name === name);
  }

  /** A skill's files with their text. A file missing from the store is an error: the skill is incomplete. */
  async readFiles(meta: SkillMeta): Promise<{ path: string; text: string }[]> {
    const out: { path: string; text: string }[] = [];
    for (let i = 0; i < meta.files.length; i += 8) {
      const batch = meta.files.slice(i, i + 8).map(async (f) => {
        if (safeSkillPath(f.path) === null) throw new Error(`skill ${meta.name} has an unsafe path`);
        const blob = await this.store.get(fileKey(meta.name, meta.version, f.path));
        if (!blob || !blob.length) throw new Error(`skill ${meta.name} is missing ${f.path}`);
        return { path: f.path, text: decrypt(this.key, blob) };
      });
      out.push(...(await Promise.all(batch)));
    }
    return out;
  }

  /** SKILL.md's text, or undefined when the skill is not installed. */
  async skillMd(name: string): Promise<string | undefined> {
    const meta = await this.get(name);
    if (!meta) return undefined;
    const blob = await this.store.get(fileKey(meta.name, meta.version, "SKILL.md"));
    return blob && blob.length ? decrypt(this.key, blob) : undefined;
  }

  /** The files an input names: pasted, or read from GitHub (with the connection allowed to read the repository, else without a token). */
  private async gather(input: SkillInput, config: Config, reuse: boolean): Promise<Result<{ files: RawFile[]; source?: SkillSource }>> {
    if ("skillMd" in input) {
      if (Buffer.byteLength(input.skillMd, "utf8") > SKILL_LIMITS.maxPastedBytes) {
        return { ok: false, error: `A pasted SKILL.md may be at most ${formatBytes(SKILL_LIMITS.maxPastedBytes)}.` };
      }
      return { ok: true, files: pastedFiles(input.skillMd) };
    }
    const parsed = parseGitHubSkillUrl(input.url);
    if (!parsed.ok) return parsed;
    const cacheKey = input.url.trim();
    const cached = this.fetched.get(cacheKey);
    if (reuse && cached && Date.now() - cached.at < PREVIEW_TTL_MS) return { ok: true, files: cached.files, ...(cached.source ? { source: cached.source } : {}) };
    const { owner, repo } = parsed.location;
    const token = connectionForRepo(config, `${owner}/${repo}`)?.token;
    const fetched = await fetchGitHubSkill(parsed.location, { fetch: this.deps.fetch ?? fetch, ...(token ? { token } : {}) });
    if (!fetched.ok) return fetched;
    this.fetched.delete(cacheKey);
    this.fetched.set(cacheKey, { at: Date.now(), files: fetched.files, source: fetched.source });
    while (this.fetched.size > PREVIEW_CACHE_MAX) this.fetched.delete(this.fetched.keys().next().value!);
    return { ok: true, files: fetched.files, source: fetched.source };
  }

  /** What installing would add: files, frontmatter, scripts, licence, and what blocks it. Installs nothing. */
  async preview(input: SkillInput, config: Config): Promise<Result<{ preview: SkillPreview }>> {
    const gathered = await this.gather(input, config, false);
    if (!gathered.ok) return gathered;
    const preview = checkFiles(gathered.files, gathered.source);
    const existing = preview.name ? await this.get(preview.name) : undefined;
    if (existing) preview.installed = { installedAt: existing.installedAt, ...(existing.source ? { source: existing.source } : {}) };
    else if ((await this.list()).length >= SKILL_LIMITS.maxSkills) preview.problems.push(`The library holds at most ${SKILL_LIMITS.maxSkills} skills. Remove one first.`);
    return { ok: true, preview };
  }

  /**
   * Installs a skill, replacing one of the same name (its assignment is kept
   * unless `assignedTo` is given; a new skill goes to every agent by default).
   * A GitHub folder previewed in the last minutes is installed as previewed.
   */
  install(input: SkillInput, config: Config, assignedTo?: SkillAssignment): Promise<Result<{ skill: SkillMeta }>> {
    return this.exclusive(async () => {
      const gathered = await this.gather(input, config, true);
      if (!gathered.ok) return gathered;
      const preview = checkFiles(gathered.files, gathered.source);
      if (preview.problems.length) return { ok: false, error: preview.problems[0]! };
      const skills = await this.list(true);
      const existing = skills.find((s) => s.name === preview.name);
      if (!existing && skills.length >= SKILL_LIMITS.maxSkills) return { ok: false, error: `The library holds at most ${SKILL_LIMITS.maxSkills} skills. Remove one first.` };
      const assignment = assignedTo ?? existing?.assignedTo ?? "all";
      const checked = await this.checkAssignment(assignment);
      if (!checked.ok) return checked;

      const version = `${this.now().getTime().toString(36)}${randomBytes(3).toString("hex")}`;
      const files = gathered.files.map((f) => ({ path: f.path, text: f.text ?? "" }));
      const license = licenseLine(preview);
      for (const f of files) await this.store.put(fileKey(preview.name, version, f.path), encrypt(this.key, f.text));
      const meta: SkillMeta = {
        name: preview.name,
        description: preview.description,
        ...(preview.source ? { source: preview.source } : {}),
        ...(license ? { license } : {}),
        files: files.map((f) => ({ path: f.path, size: Buffer.byteLength(f.text, "utf8") })),
        bytes: files.reduce((sum, f) => sum + Buffer.byteLength(f.text, "utf8"), 0),
        hasScripts: preview.hasScripts,
        installedAt: this.now().toISOString(),
        assignedTo: assignment,
        version,
      };
      await this.writeIndex([...skills.filter((s) => s.name !== meta.name), meta]);
      await this.applyAssignment(meta.name, assignment);
      if (existing) await this.blank(existing);
      if ("url" in input) this.fetched.delete(input.url.trim());
      return { ok: true, skill: meta };
    });
  }

  /** Gives a skill to every agent ("all", including agents added later) or to the listed ones (their skills lists are updated). */
  assign(name: string, assignedTo: SkillAssignment): Promise<Result<{ skill: SkillMeta }>> {
    return this.exclusive(async () => {
      const skills = await this.list(true);
      const meta = skills.find((s) => s.name === name);
      if (!meta) return { ok: false, error: `No skill named ${name} is installed.` };
      const checked = await this.checkAssignment(assignedTo);
      if (!checked.ok) return checked;
      const updated: SkillMeta = { ...meta, assignedTo };
      await this.writeIndex(skills.map((s) => (s.name === name ? updated : s)));
      await this.applyAssignment(name, assignedTo);
      return { ok: true, skill: updated };
    });
  }

  /** Removes a skill: out of the index and every agent's skills list; its files are blanked. False when it is not installed. */
  remove(name: string): Promise<boolean> {
    return this.exclusive(async () => {
      const skills = await this.list(true);
      const meta = skills.find((s) => s.name === name);
      if (!meta) return false;
      await this.writeIndex(skills.filter((s) => s.name !== name));
      await this.deps.configRepo?.update((c) => {
        for (const a of c.team.agents) a.skills = a.skills.filter((s) => s !== name);
      });
      await this.blank(meta);
      return true;
    });
  }

  private async checkAssignment(assignedTo: SkillAssignment): Promise<Result<object>> {
    if (assignedTo === "all" || !this.deps.configRepo) return { ok: true };
    const team = (await this.deps.configRepo.load(true)).team;
    const unknown = assignedTo.find((id) => !team.agents.some((a) => a.id === id));
    if (unknown) return { ok: false, error: `There is no agent with the id ${unknown.slice(0, 40)}.` };
    const full = team.agents.find((a) => assignedTo.includes(a.id) && a.skills.length >= 50);
    if (full) return { ok: false, error: `${full.name} already has 50 skills, the most an agent can have.` };
    return { ok: true };
  }

  /** "all": no agent needs it in its own list. A list: exactly those agents have it. */
  private async applyAssignment(name: string, assignedTo: SkillAssignment): Promise<void> {
    await this.deps.configRepo?.update((c) => {
      for (const a of c.team.agents) {
        const has = a.skills.includes(name);
        const wanted = assignedTo !== "all" && assignedTo.includes(a.id);
        if (wanted && !has) a.skills = [...a.skills, name];
        if (!wanted && has) a.skills = a.skills.filter((s) => s !== name);
      }
    });
  }

  private async writeIndex(skills: SkillMeta[]): Promise<void> {
    const sorted = [...skills].sort((a, b) => a.name.localeCompare(b.name));
    await this.store.put(INDEX_KEY, encrypt(this.key, JSON.stringify({ skills: sorted })));
    this.cache = { at: Date.now(), skills: sorted };
  }

  /** The store has no delete: a replaced or removed version's files are overwritten with nothing. */
  private async blank(meta: SkillMeta): Promise<void> {
    for (const f of meta.files) {
      await this.store
        .put(fileKey(meta.name, meta.version, f.path), "")
        .catch((err: unknown) => console.error(`[skills] could not blank a file of ${meta.name}:`, errorText(err).slice(0, 200)));
    }
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}

/** The console's view of a skill: "all", or the agents whose own skills list names it. */
export function skillView(meta: SkillMeta, team: Pick<Team, "agents">): SkillView {
  const { version: _version, ...rest } = meta;
  return { ...rest, assignedTo: meta.assignedTo === "all" ? "all" : team.agents.filter((a) => a.skills.includes(meta.name)).map((a) => a.id) };
}

// ---------- The plugin the agents load ----------

export const PLUGIN_MANIFEST = {
  name: SKILLS_PLUGIN,
  version: "1.0.0",
  description: "The team's skills library, installed in the Agent Army console.",
};

/** What the query options need from installed skills. */
export const teamSkillsOf = (skills: SkillMeta[], pluginDir: string): TeamSkills => ({
  pluginDir,
  skills: skills.map((s) => ({ name: s.name, description: s.description })),
  everyone: skills.filter((s) => s.assignedTo === "all").map((s) => s.name),
});

/**
 * Writes the installed skills into `dir` as a local plugin the Agent SDK
 * loads (`plugins: [{ type: "local", path: dir }]`):
 *   dir/.claude-plugin/plugin.json   { "name": "team-skills", … }
 *   dir/skills/<name>/SKILL.md       and the skill's other files
 * Its skills are then named team-skills:<name>. Undefined when nothing is
 * installed. A skill that cannot be read is left out (logged), never fatal.
 */
export async function materializeSkills(library: Pick<SkillLibrary, "list" | "readFiles">, dir: string): Promise<TeamSkills | undefined> {
  const skills = await library.list(true);
  if (!skills.length) return undefined;
  const root = resolve(dir);
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await writeFile(join(root, ".claude-plugin", "plugin.json"), `${JSON.stringify(PLUGIN_MANIFEST, null, 2)}\n`);
  const written: SkillMeta[] = [];
  for (const meta of skills) {
    const skillRoot = join(root, "skills", meta.name);
    try {
      const files = await library.readFiles(meta);
      for (const f of files) {
        const path = resolve(skillRoot, f.path);
        if (safeSkillPath(f.path) === null || !path.startsWith(skillRoot + sep)) throw new Error("unsafe path");
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, f.text, { flag: "wx", mode: 0o644 });
      }
      written.push(meta);
    } catch (err) {
      console.error(`[skills] left out ${meta.name}: ${errorText(err).slice(0, 200)}`);
      await rm(skillRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return written.length ? teamSkillsOf(written, root) : undefined;
}

/**
 * Pointer's chat (web service): the plugin directory, built once per library
 * version under the service's temp dir and rebuilt when skills are installed,
 * replaced or removed. Assignments need no rebuild (they are read each time).
 * The previous build is kept for answers still running on it.
 */
export class SkillsPluginCache {
  private base: Promise<string> | undefined;
  private built: { fingerprint: string; dir: string; names: string[] } | undefined;
  private previous: string | undefined;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly library: Pick<SkillLibrary, "list" | "readFiles">,
    private readonly baseDir?: string,
  ) {}

  current(): Promise<TeamSkills | undefined> {
    const run = this.chain.then(() => this.currentNow());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async currentNow(): Promise<TeamSkills | undefined> {
    const skills = await this.library.list();
    if (!skills.length) return undefined;
    const fingerprint = createHash("sha256")
      .update(JSON.stringify(skills.map((s) => [s.name, s.version])))
      .digest("hex")
      .slice(0, 16);
    if (this.built?.fingerprint !== fingerprint) {
      this.base ??= this.baseDir ? mkdir(this.baseDir, { recursive: true }).then(() => this.baseDir!) : mkdtemp(join(tmpdir(), "army-skills-"));
      const dir = join(await this.base, fingerprint);
      await rm(dir, { recursive: true, force: true });
      const made = await materializeSkills(this.library, dir);
      if (!made) return undefined;
      // The build before the last one is no longer used by any answer that can still be running.
      if (this.previous && this.previous !== dir) await rm(this.previous, { recursive: true, force: true }).catch(() => undefined);
      this.previous = this.built?.dir;
      this.built = { fingerprint, dir, names: made.skills.map((s) => s.name) };
    }
    const names = new Set(this.built.names);
    return teamSkillsOf(
      skills.filter((s) => names.has(s.name)),
      this.built.dir,
    );
  }
}
