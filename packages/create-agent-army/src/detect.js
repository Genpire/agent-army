// Which provider CLIs are installed and logged in. Read-only: every check is a `probe`.
import { dirname, join } from "node:path";

/** @typedef {import("./types.js").Detection} Detection */
/** @typedef {import("./types.js").ProviderId} ProviderId */
/** @typedef {import("./types.js").Runner} Runner */
/** @typedef {import("./types.js").Fs} Fs */

/** @param {string} text */
const firstLine = (text) => text.trim().split(/\r?\n/)[0]?.trim() ?? "";

/**
 * @param {Partial<Detection> & Pick<Detection, "id" | "label" | "cli">} d
 * @returns {Detection}
 */
const detection = (d) => ({ installed: false, ready: false, status: "not installed", details: {}, ...d });

/** @param {Runner} run */
async function detectFly(run) {
  let cli = "fly";
  let version = await run.probe(cli, ["version"]);
  if (version.notFound) {
    cli = "flyctl";
    version = await run.probe(cli, ["version"]);
  }
  if (version.notFound) return detection({ id: "fly", label: "Fly.io", cli: "fly" });
  const who = await run.probe(cli, ["auth", "whoami"]);
  const account = who.code === 0 ? firstLine(who.stdout) : "";
  return detection({
    id: "fly",
    label: "Fly.io",
    cli,
    installed: true,
    ready: who.code === 0,
    account: account || undefined,
    status: who.code === 0 ? `logged in${account ? ` as ${account}` : ""}` : `installed, not logged in (run: ${cli} auth login)`,
  });
}

/** @param {Runner} run */
async function detectRailway(run) {
  const version = await run.probe("railway", ["--version"]);
  if (version.notFound) return detection({ id: "railway", label: "Railway", cli: "railway" });
  const who = await run.probe("railway", ["whoami", "--json"]);
  if (who.code !== 0) {
    return detection({
      id: "railway",
      label: "Railway",
      cli: "railway",
      installed: true,
      status: "installed, not logged in (run: railway login)",
    });
  }
  /** @type {{ id: string, name: string }[]} */
  let workspaces = [];
  let account = "";
  try {
    const parsed = /** @type {{ email?: unknown, name?: unknown, workspaces?: unknown }} */ (JSON.parse(who.stdout));
    account = typeof parsed.email === "string" ? parsed.email : typeof parsed.name === "string" ? parsed.name : "";
    if (Array.isArray(parsed.workspaces)) {
      workspaces = parsed.workspaces
        .filter((w) => w && typeof w.id === "string")
        .map((w) => ({ id: String(w.id), name: typeof w.name === "string" ? w.name : String(w.id) }));
    }
  } catch {
    account = firstLine(who.stdout);
  }
  return detection({
    id: "railway",
    label: "Railway",
    cli: "railway",
    installed: true,
    ready: true,
    account: account || undefined,
    status: `logged in${account ? ` as ${account}` : ""}`,
    details: { workspaces },
  });
}

/**
 * @param {Runner} run
 * @param {Record<string, string | undefined>} env
 */
async function detectRender(run, env) {
  const apiKey = Boolean(env.RENDER_API_KEY);
  const version = await run.probe("render", ["--version"]);
  if (version.notFound) {
    return detection({
      id: "render",
      label: "Render",
      cli: "render",
      status: "in the browser (Deploy to Render button; the Render CLI is not needed)",
      details: { apiKey },
    });
  }
  const who = await run.probe("render", ["whoami", "-o", "text"]);
  return detection({
    id: "render",
    label: "Render",
    cli: "render",
    installed: true,
    ready: who.code === 0,
    status: `in the browser (Render CLI ${who.code === 0 ? "logged in" : "not logged in"})`,
    details: { apiKey },
  });
}

/**
 * The root of an Agent Army clone at or above `cwd` (it has deploy/gcp.sh), if any.
 * @param {string} cwd
 * @param {Fs} fs
 */
export function findClone(cwd, fs) {
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    if (fs.exists(join(dir, "deploy", "gcp.sh")) && fs.exists(join(dir, "package.json"))) {
      try {
        const pkg = /** @type {{ name?: unknown }} */ (JSON.parse(fs.readFile(join(dir, "package.json"))));
        if (pkg.name === "agent-army") return dir;
      } catch {
        // not ours
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * @param {Runner} run
 * @param {string} cwd
 * @param {Fs} fs
 */
async function detectGcloud(run, cwd, fs) {
  const clone = findClone(cwd, fs);
  const version = await run.probe("gcloud", ["--version"]);
  if (version.notFound) return detection({ id: "gcloud", label: "Google Cloud Run", cli: "gcloud", details: { clone } });
  const [auth, config] = await Promise.all([
    run.probe("gcloud", ["auth", "list", "--filter=status:ACTIVE", "--format=value(account)"]),
    run.probe("gcloud", ["config", "get-value", "project"]),
  ]);
  const account = auth.code === 0 ? firstLine(auth.stdout) : "";
  const project = config.code === 0 ? firstLine(config.stdout).replace(/^\(unset\)$/, "") : "";
  const where = clone ? "deploy/gcp.sh found" : "not in a clone: Cloud Shell";
  return detection({
    id: "gcloud",
    label: "Google Cloud Run",
    cli: "gcloud",
    installed: true,
    ready: Boolean(account),
    account: account || undefined,
    status: account
      ? `logged in as ${account}, ${project ? `project ${project}` : "no project set"}; ${where}`
      : `installed, not logged in (run: gcloud auth login); ${where}`,
    details: { project: project || undefined, clone },
  });
}

/** @param {Runner} run */
async function detectDocker(run) {
  const version = await run.probe("docker", ["--version"]);
  if (version.notFound) return detection({ id: "docker", label: "Docker (this computer)", cli: "docker" });
  const info = await run.probe("docker", ["info", "--format", "{{.ServerVersion}}"]);
  return detection({
    id: "docker",
    label: "Docker (this computer)",
    cli: "docker",
    installed: true,
    ready: info.code === 0,
    status: info.code === 0 ? "running (local only: no public HTTPS, so no Slack)" : "installed, but the Docker daemon is not running",
  });
}

/** @param {Runner} run */
async function detectSsh(run) {
  const version = await run.probe("ssh", ["-V"]);
  if (version.notFound) return detection({ id: "vm", label: "Linux server over SSH", cli: "ssh" });
  return detection({
    id: "vm",
    label: "Linux server over SSH",
    cli: "ssh",
    installed: true,
    ready: true,
    status: "ssh found (needs a server with 8 GB RAM and a domain pointing at it)",
  });
}

/**
 * Checks every provider at once.
 * @param {{ run: Runner, cwd: string, fs: Fs, env: Record<string, string | undefined> }} options
 * @returns {Promise<Detection[]>}
 */
export async function detectProviders({ run, cwd, fs, env }) {
  return Promise.all([
    detectFly(run),
    detectRailway(run),
    detectRender(run, env),
    detectGcloud(run, cwd, fs),
    detectDocker(run),
    detectSsh(run),
  ]);
}

/**
 * The provider to offer first: a cloud CLI that is ready to deploy without questions, then
 * local Docker, and otherwise Render in the browser (nothing to install).
 * @param {Detection[]} found
 * @returns {ProviderId}
 */
export function bestProvider(found) {
  /** @param {ProviderId} id */
  const get = (id) => found.find((d) => d.id === id);
  const ready = (/** @type {ProviderId} */ id) => get(id)?.ready === true;
  if (ready("railway")) return "railway";
  if (ready("fly")) return "fly";
  const gcloud = get("gcloud");
  if (gcloud?.ready && gcloud.details.project && gcloud.details.clone) return "gcloud";
  if (ready("render")) return "render";
  if (ready("docker")) return "docker";
  return "render";
}
