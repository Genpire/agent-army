// Command-line parsing and validation (node:util parseArgs, no dependencies).
import { parseArgs } from "node:util";
import { DEFAULT_IMAGE, DEFAULT_TIMEOUT_MIN, APP_PORT, PROVIDER_IDS } from "./constants.js";

/** @typedef {import("./types.js").Options} Options */
/** @typedef {import("./types.js").ProviderId} ProviderId */

/** A mistake on the command line: shown with the usage hint, exit code 2. */
export class UsageError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

export const USAGE = `Deploy Agent Army (Pointer and its team) with one command.

Usage:
  npm create agent-army@latest [name] -- [options]
  npx create-agent-army [name] [options]

With no options it finds the provider CLIs you are logged in to, asks once, and deploys
the prebuilt image ${DEFAULT_IMAGE}.

Options:
  -p, --provider <id>   fly | railway | render | gcloud | docker | vm
  -n, --name <name>     App, project or container name (3-40 characters: a-z, 0-9, -)
  -r, --region <id>     Fly.io region (default iad) or Cloud Run region (default us-central1)
      --org <name>      Fly.io organization or Railway workspace
      --project <id>    Google Cloud project (default: gcloud's current project)
      --host <target>   vm: the ssh target, e.g. root@203.0.113.7
      --domain <name>   vm: a domain whose DNS A record points at the server
      --image <ref>     The image to deploy (default ${DEFAULT_IMAGE})
      --port <n>        docker: the local port (default ${APP_PORT})
      --timeout <min>   Minutes to wait for the deployment to answer (default ${DEFAULT_TIMEOUT_MIN})
  -y, --yes             Never ask: take the defaults and the flags
      --dry-run         Print every command that would create or change something, run none
      --no-open         Don't open a browser
  -h, --help            Show this help
  -v, --version         Show the version

Examples:
  npm create agent-army@latest
  npm create agent-army@latest -- --provider fly --name my-army --region iad --yes
  npx create-agent-army --provider vm --host root@203.0.113.7 --domain army.example.com
  npx create-agent-army --provider railway --dry-run
`;

const NAME_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9-]{2,40}$/;
const PROJECT_RE = /^[a-z][a-z0-9:.-]{4,62}$/;
const IMAGE_RE = /^[a-z0-9][A-Za-z0-9._/@:-]{0,255}$/;
const HOST_RE = /^[A-Za-z0-9_.@:[\]-]{1,255}$/;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** @param {string} name */
export const isValidName = (name) => NAME_RE.test(name) && !name.includes("--");

/** @param {string} host An ssh target such as root@203.0.113.7 (never an option: no leading "-"). */
export const isValidHost = (host) => HOST_RE.test(host) && !host.startsWith("-");

/**
 * Accepts "https://army.example.com/" too, like install.sh. Returns the bare lowercase name, or undefined.
 * @param {string} input
 */
export function normalizeDomain(input) {
  const domain = input
    .trim()
    .replace(/^[A-Za-z]+:\/\//, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  return DOMAIN_RE.test(domain) ? domain : undefined;
}

/** @param {string} value */
const isProviderId = (value) => /** @type {readonly string[]} */ (PROVIDER_IDS).includes(value);

/**
 * @param {string | undefined} value
 * @param {string} flag
 * @param {number} min
 * @param {number} max
 */
function integer(value, flag, min, max) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UsageError(`${flag} must be a whole number from ${min} to ${max} (got "${value}").`);
  }
  return n;
}

/**
 * Parses and validates the command line (without the "node script" part).
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArguments(argv) {
  /** @type {ReturnType<typeof parse>} */
  let parsed;
  try {
    parsed = parse(argv);
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
  const { values, positionals } = parsed;

  if (positionals.length > 1) {
    throw new UsageError(`Expected at most one name, got: ${positionals.join(" ")}`);
  }
  if (values.name !== undefined && positionals.length === 1 && positionals[0] !== values.name) {
    throw new UsageError("Give the name once: as the first argument or with --name.");
  }
  const name = values.name ?? positionals[0];

  /** @type {ProviderId | undefined} */
  let provider;
  if (values.provider !== undefined) {
    const id = values.provider.toLowerCase();
    const alias = id === "flyio" || id === "fly.io" ? "fly" : id === "gcp" || id === "cloudrun" ? "gcloud" : id;
    if (!isProviderId(alias)) {
      throw new UsageError(`Unknown provider "${values.provider}". Use one of: ${PROVIDER_IDS.join(", ")}.`);
    }
    provider = /** @type {ProviderId} */ (alias);
  }

  if (name !== undefined && !isValidName(name)) {
    throw new UsageError(
      `"${name}" is not a valid name: use 3 to 40 lowercase letters, digits and single dashes, starting with a letter.`,
    );
  }
  if (values.region !== undefined && !REGION_RE.test(values.region)) {
    throw new UsageError(`"${values.region}" is not a region id (for example iad or us-central1).`);
  }
  if (values.project !== undefined && !PROJECT_RE.test(values.project)) {
    throw new UsageError(`"${values.project}" is not a Google Cloud project id.`);
  }
  if (values.org !== undefined && (!/^[^\s-][^\0-\x1f]{0,99}$/.test(values.org))) {
    throw new UsageError(`"${values.org}" is not an organization or workspace name.`);
  }
  if (values.host !== undefined && !isValidHost(values.host)) {
    throw new UsageError(`"${values.host}" is not an ssh target (for example root@203.0.113.7).`);
  }
  /** @type {string | undefined} */
  let domain;
  if (values.domain !== undefined) {
    domain = normalizeDomain(values.domain);
    if (!domain) throw new UsageError(`"${values.domain}" is not a domain name (for example army.example.com).`);
  }
  const image = values.image ?? DEFAULT_IMAGE;
  if (!IMAGE_RE.test(image)) throw new UsageError(`"${image}" is not an image reference.`);

  return {
    provider,
    name,
    region: values.region,
    org: values.org,
    project: values.project,
    host: values.host,
    domain,
    image,
    port: integer(values.port, "--port", 1, 65535) ?? APP_PORT,
    timeout: integer(values.timeout, "--timeout", 1, 120) ?? DEFAULT_TIMEOUT_MIN,
    yes: values.yes ?? false,
    dryRun: values["dry-run"] ?? false,
    open: !(values["no-open"] ?? false),
    help: values.help ?? false,
    version: values.version ?? false,
  };
}

/** @param {string[]} args */
function parse(args) {
  return parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      provider: { type: "string", short: "p" },
      name: { type: "string", short: "n" },
      region: { type: "string", short: "r" },
      org: { type: "string" },
      project: { type: "string" },
      host: { type: "string" },
      domain: { type: "string" },
      image: { type: "string" },
      port: { type: "string" },
      timeout: { type: "string" },
      yes: { type: "boolean", short: "y" },
      "dry-run": { type: "boolean" },
      "no-open": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
}
