// Railway: a project with one service on the prebuilt image, a volume at /data and a
// railway.app domain. Every step is a documented non-interactive command of the Railway CLI (v5).
import { APP_PORT } from "../constants.js";
import { CommandError } from "../exec.js";

/** @typedef {import("../types.js").Provider} Provider */

export const RAILWAY_SERVICE = "agent-army";

/**
 * The https:// address from `railway domain --json`: {"domain": "https://..."} for a new
 * domain, {"domains": ["https://...", ...]} when the service already has some.
 * @param {string} stdout
 * @returns {string | undefined}
 */
export function parseRailwayDomain(stdout) {
  /** @param {unknown} value */
  const asUrl = (value) => {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const v = value.trim().replace(/\/+$/, "");
    return /^https?:\/\//.test(v) ? v.replace(/^http:/, "https:") : `https://${v}`;
  };
  try {
    const parsed = /** @type {{ domain?: unknown, domains?: unknown }} */ (JSON.parse(stdout));
    const one = asUrl(parsed.domain);
    if (one) return one;
    if (Array.isArray(parsed.domains)) {
      const railwayDomain = parsed.domains.find((d) => typeof d === "string" && d.includes(".railway.app"));
      return asUrl(railwayDomain ?? parsed.domains[0]);
    }
  } catch {
    // not JSON: look for the host in the text
  }
  const match = stdout.match(/[a-z0-9][a-z0-9.-]*\.up\.railway\.app/i);
  return match ? `https://${match[0].toLowerCase()}` : undefined;
}

/** The project id from `railway init --json`. @param {string} stdout */
function projectId(stdout) {
  try {
    const parsed = /** @type {{ id?: unknown }} */ (JSON.parse(stdout));
    return typeof parsed.id === "string" && /^[A-Za-z0-9-]+$/.test(parsed.id) ? parsed.id : undefined;
  } catch {
    return undefined;
  }
}

/** The variables the server needs (MASTER_KEY and SETUP_TOKEN are set separately, on stdin). @param {string} url */
export const railwayVariables = (url) => [
  "STORAGE=fs",
  "DATA_DIR=/data",
  "RUNNER=local",
  "REQUIRE_MASTER_KEY=1",
  "BROWSER=on",
  `PORT=${APP_PORT}`,
  // The volume is mounted as root and the image runs as node.
  "RAILWAY_RUN_UID=0",
  // Give the server time to stop cleanly on redeploys (Railway's default is 0 s).
  "RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30",
  `PUBLIC_URL=${url}`,
];

/** @type {Provider} */
export const railway = {
  id: "railway",
  label: "Railway",
  installUrl: "https://docs.railway.com/cli#installing-the-cli",
  loginCommand: "railway login",
  requiresCli: () => true,

  async prepare(ctx) {
    const workspaces = /** @type {{ id: string, name: string }[]} */ (ctx.detection.details.workspaces ?? []);
    const wanted = ctx.options.org;
    if (wanted) {
      const match = workspaces.find((w) => w.id === wanted || w.name.toLowerCase() === wanted.toLowerCase());
      if (!match && workspaces.length > 0 && !ctx.run.dryRun) {
        throw new CommandError(`No Railway workspace "${wanted}".`, {
          hint: `Use one of: ${workspaces.map((w) => w.name).join(", ")}`,
        });
      }
      ctx.answers.workspace = match?.id ?? wanted;
      return;
    }
    const first = workspaces[0];
    if (workspaces.length === 1 && first) {
      ctx.answers.workspace = first.id;
    } else if (workspaces.length > 1) {
      if (!ctx.prompt.interactive) {
        throw new CommandError("Your Railway account has several workspaces.", {
          hint: `Choose one with --org: ${workspaces.map((w) => w.name).join(", ")}`,
        });
      }
      ctx.answers.workspace = await ctx.prompt.choose(
        "Which Railway workspace?",
        workspaces.map((w) => ({ value: w.id, label: w.name })),
        0,
      );
    }
  },

  plan: ({ options }) =>
    `Railway project ${options.name}: the image, a volume at /data and a railway.app domain (Hobby plan, usage-billed, about $10-30/month).`,

  async deploy(ctx) {
    const { name, image } = ctx.options;
    const service = RAILWAY_SERVICE;
    // The CLI links a folder to the project. Use a new empty one, never the folder you are in,
    // which may already be linked to another project.
    const dir = ctx.run.dryRun ? undefined : ctx.fs.makeTempDir("create-agent-army-railway-");
    /** @param {string[]} args @param {import("../types.js").RunOptions} [options] */
    const railwayRun = (args, options = {}) => ctx.run.run("railway", args, { cwd: dir, capture: true, ...options });

    ctx.saveKeys();

    ctx.out.step(`Creating the Railway project ${name}`);
    if (ctx.run.dryRun) ctx.out.line(ctx.out.dim("# in a new empty folder, which the Railway CLI links to the project"));
    const workspace = ctx.answers.workspace;
    const init = await railwayRun(["init", "--name", name, ...(workspace ? ["--workspace", workspace] : []), "--json"]);
    // {"id": ..., "name": ...}: delete by id, since project names needn't be unique.
    const project = projectId(init.stdout) ?? name;
    ctx.created.push({ what: `Railway project ${name}, with its service, volume and domain`, remove: `railway delete --project ${project} --yes` });

    ctx.out.step(`Adding the ${service} service and a volume at /data`);
    await railwayRun(["add", "--service", service, "--json"]);
    await railwayRun(["volume", "add", "--service", service, "--mount-path", "/data", "--json"]);

    ctx.out.step("Generating the public railway.app domain");
    const domain = await railwayRun(["domain", "--service", service, "--port", String(APP_PORT), "--json"], {
      dryRunStdout: JSON.stringify({ domain: "https://<generated>.up.railway.app" }),
    });
    const url = parseRailwayDomain(domain.stdout);
    if (!url) {
      throw new CommandError("Railway did not return the service's domain.", {
        hint: `In the Railway dashboard: project ${name} > ${service} > Settings > Networking > Generate Domain (port ${APP_PORT}), then run this again with another --name, or finish by hand.`,
      });
    }
    ctx.saveKeys({ AGENT_ARMY_URL: url });

    ctx.out.step("Setting the variables (the keys go on stdin, never on the command line)");
    await railwayRun(["variable", "set", ...railwayVariables(url), "--service", service, "--skip-deploys"]);
    await railwayRun(["variable", "set", "MASTER_KEY", "--stdin", "--service", service, "--skip-deploys"], {
      input: ctx.secrets.masterKey,
      inputLabel: "value on stdin",
    });
    await railwayRun(["variable", "set", "SETUP_TOKEN", "--stdin", "--service", service, "--skip-deploys"], {
      input: ctx.secrets.setupToken,
      inputLabel: "value on stdin",
    });

    ctx.out.step(`Deploying ${image}`);
    await railwayRun(["service", "source", "connect", "--image", image, "--service", service, "--json"]);

    return {
      url,
      waitForHealth: true,
      notes: [
        "Two settings the Railway CLI can't set yet (recommended): in the dashboard, open the project",
        `  ${name} > ${service} > Settings > Deploy: Healthcheck Path /healthz, Restart Policy Always (keep Serverless off).`,
        `Manage it from a folder:    railway link --project ${name} --service ${service}`,
        `Update to the newest image: railway redeploy --from-source --service ${service} --yes  (after railway link)`,
        `Remove everything:          railway delete --project ${name}  (deletes the volume and its data)`,
      ],
      notHealthyHint:
        `Open the project in the Railway dashboard (railway open, after railway link). If ${service} shows staged ` +
        `changes, click Deploy. Its Deploy Logs show why it isn't starting.`,
    };
  },
};
