import { decrypt, encrypt } from "./core/crypto.js";
import { CODE_HOST_KINDS, type CodeHostKind, REPO_FORMAT_HINT, isRepoId, repoHost, repoId, repoPath } from "./repo-id.js";
import type { Store } from "./core/store.js";

/**
 * Project notes: what the team has learned about one repository (how to build
 * and test it, conventions, gotchas). Read at the start of every repo task and
 * curated at the end, so knowledge accumulates instead of being rediscovered.
 * Never written into the checkout (the worker commits the whole tree).
 */
export interface ProjectNotes {
  repo: string;
  text: string;
  updatedAt: string;
}

export const NOTES_MAX_CHARS = 8000;

/**
 * One flat file per repository, named without letter case:
 *   owner/repo                → notes/owner__repo.enc (GitHub, as before)
 *   gitlab:group/sub/project  → notes/gitlab~group~sub~project.enc
 *   bitbucket:workspace/repo  → notes/bitbucket~workspace~repo.enc
 * "~" is not allowed in repository ids, so the other hosts' names never clash
 * with GitHub's and read back unambiguously. Ids are checked first (no "." or
 * ".." segments), and no name holds a "/" or ":", so a key never leaves notes/.
 */
function keyFor(repo: string): string {
  const id = repo.toLowerCase();
  const host = repoHost(id);
  const name = host === "github" ? id.replace("/", "__") : `${host}~${repoPath(id).replaceAll("/", "~")}`;
  return `notes/${name}.enc`;
}

function repoFromKey(key: string): string {
  const name = key.slice("notes/".length, -".enc".length);
  const [host, ...path] = name.split("~");
  if (path.length && CODE_HOST_KINDS.includes(host as CodeHostKind)) return repoId(host as CodeHostKind, path.join("/"));
  return name.replace("__", "/");
}

export class NotesRepo {
  /** Serialises writes so concurrent appends (Slack, worker, admin page) don't lose each other. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly key: Buffer,
  ) {}

  async get(repo: string): Promise<ProjectNotes | null> {
    if (!isRepoId(repo)) return null;
    const blob = await this.store.get(keyFor(repo));
    // The store has no delete; deleted notes are an empty blob.
    return blob && blob.length > 0 ? (JSON.parse(decrypt(this.key, blob)) as ProjectNotes) : null;
  }

  /** Replace the notes for a repo. Empty text deletes them. Returns false if the text is too long. */
  put(repo: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.exclusive(() => this.putNow(repo, text));
  }

  /** Add one bullet, e.g. from Slack ("remember for owner/repo that …"). */
  append(repo: string, note: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return this.exclusive(async () => {
      const line = note.replace(/\s+/g, " ").trim();
      if (!line) return { ok: false as const, error: "Nothing to note." };
      const current = (await this.get(repo))?.text ?? "";
      return this.putNow(repo, current ? `${current}\n- ${line}` : `- ${line}`);
    });
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async putNow(repo: string, text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!isRepoId(repo)) return { ok: false, error: REPO_FORMAT_HINT };
    const clean = text.trim();
    if (clean.length > NOTES_MAX_CHARS) {
      return { ok: false, error: `Project notes are limited to ${NOTES_MAX_CHARS} characters; condense them.` };
    }
    if (!clean) {
      await this.store.put(keyFor(repo), "");
      return { ok: true };
    }
    const notes: ProjectNotes = { repo, text: clean, updatedAt: new Date().toISOString() };
    await this.store.put(keyFor(repo), encrypt(this.key, JSON.stringify(notes)));
    return { ok: true };
  }

  async list(): Promise<{ repo: string; updatedAt: string; chars: number }[]> {
    const keys = (await this.store.list("notes/")).filter((k) => k.endsWith(".enc"));
    const all = await Promise.all(keys.map((k) => this.get(repoFromKey(k)).catch(() => null)));
    return all
      .filter((n): n is ProjectNotes => n !== null)
      .map((n) => ({ repo: n.repo, updatedAt: n.updatedAt, chars: n.text.length }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
