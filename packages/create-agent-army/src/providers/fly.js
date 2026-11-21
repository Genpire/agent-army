// Fly.io: one always-on Machine (8 GB) running the prebuilt image, with a volume at /data.
import { CommandError } from "../exec.js";
import { localName } from "../files.js";

/** @typedef {import("../types.js").Provider} Provider */

export const FLY_VOLUME = "agent_army_data";

/**
 * The fly.toml for the prebuilt image. Names and regions are validated before they get here.
 * @param {{ name: string, region: string, image: string }} options
 */
export function flyToml({ name, region, image }) {
  return `# Agent Army on Fly.io (Pointer and its team), written by create-agent-army.
# Update to the newest image:  fly deploy --app ${name} --config ${flyConfigName(name)}
# One Machine only: per-thread queues, event dedupe and running tasks live in memory.
app = "${name}"
primary_region = "${region}"
kill_signal = "SIGTERM"
kill_timeout = 300

[build]
  # The prebuilt public image: no build step.
  image = "${image}"

[env]
  STORAGE = "fs"
  DATA_DIR = "/data"
  # Repo checkouts go on the volume: a Machine's root filesystem is limited to 8 GB
  # and the image takes about 4 GB of it. Each task's folder is removed when it ends.
  WORK_DIR = "/data"
  RUNNER = "local"
  REQUIRE_MASTER_KEY = "1"
  # Change it (fly certs add, then fly deploy) when you add a custom domain.
  PUBLIC_URL = "https://${name}.fly.dev"

[[mounts]]
  source = "${FLY_VOLUME}"
  destination = "/data"
  initial_size = "20gb"
  auto_extend_size_threshold = 80
  auto_extend_size_increment = "5GB"
  auto_extend_size_limit = "60GB"
  snapshot_retention = 7

[http_service]
  internal_port = 8080
  force_https = true
  # Always on: Pointer keeps working after Slack gets its 200, and repo tasks run
  # for hours as child processes.
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
  [http_service.concurrency]
    type = "requests"
    soft_limit = 40
    hard_limit = 80

  [[http_service.checks]]
    grace_period = "60s"
    interval = "30s"
    method = "GET"
    timeout = "5s"
    path = "/healthz"

[[restart]]
  policy = "always"

[[vm]]
  # 3 parallel repo tasks need about 2-3 GB each plus the server. Shared CPUs drop to a
  # baseline once their burst balance is spent; for heavy builds use size = "performance-2x".
  size = "shared-cpu-4x"
  memory = "8gb"
`;
}

/** @param {string} name */
export const flyConfigName = (name) => `${localName(name)}.fly.toml`;

/** @type {Provider} */
export const fly = {
  id: "fly",
  label: "Fly.io",
  installUrl: "https://fly.io/docs/flyctl/install/",
  loginCommand: "fly auth login",
  requiresCli: () => true,
  defaultRegion: "iad",

  plan: ({ options }) =>
    `Fly.io app ${options.name} in ${options.region}: one always-on shared-cpu-4x Machine with 8 GB and a 20 GB volume (about $54/month).`,

  async deploy(ctx) {
    const { name, region, org, image } = ctx.options;
    const cli = ctx.detection.installed ? ctx.detection.cli : "fly";
    const config = flyConfigName(name);
    const url = `https://${name}.fly.dev`;
    /** @param {string[]} args @param {import("../types.js").RunOptions} [options] */
    const fly = (args, options = {}) => ctx.run.run(cli, args, { cwd: ctx.cwd, ...options });

    ctx.saveKeys({ AGENT_ARMY_URL: url });

    ctx.out.step(`Creating the Fly.io app ${name}`);
    try {
      await fly(["apps", "create", name, ...(org ? ["--org", org] : [])]);
    } catch (err) {
      if (err instanceof CommandError) {
        err.hint = "Fly.io app names are global: if this one is taken, choose another --name.";
      }
      throw err;
    }
    ctx.created.push({ what: `Fly.io app ${name}, with its volume and secrets`, remove: `${cli} apps destroy ${name} --yes` });

    ctx.out.step("Creating the 20 GB volume for /data");
    await fly(["volumes", "create", FLY_VOLUME, "--app", name, "--region", region, "--size", "20", "--yes"]);

    ctx.out.step("Storing MASTER_KEY and SETUP_TOKEN as Fly secrets");
    await fly(
      ["secrets", "set", "--app", name, "--stage", `MASTER_KEY=${ctx.secrets.masterKey}`, `SETUP_TOKEN=${ctx.secrets.setupToken}`],
      { capture: true },
    );

    ctx.out.step(`Writing ${config}`);
    if (ctx.run.dryRun) ctx.out.line(ctx.out.dim(`# ${config}: the prebuilt image, 8 GB, always on, /healthz checks, volume at /data`));
    else ctx.fs.writeFile(`${ctx.cwd}/${config}`, flyToml({ name, region, image }));

    ctx.out.step(`Deploying ${image} (the first start pulls about 1 GB)`);
    await fly(["deploy", "--app", name, "--config", config, "--ha=false", "--wait-timeout", "15m"]);

    return {
      url,
      waitForHealth: true,
      notes: [
        `Update to the newest image:  ${cli} deploy --app ${name} --config ${config}`,
        `Logs:                        ${cli} logs --app ${name}`,
        `Custom domain:               ${cli} certs add army.example.com --app ${name}, then set PUBLIC_URL in ${config}`,
        `Remove everything:           ${cli} apps destroy ${name}  (deletes the volume and its data)`,
      ],
      notHealthyHint:
        `See what the Machine is doing with: ${cli} logs --app ${name}. If the image could not be pulled, ` +
        `the package ${image.split(":")[0]} must be public.`,
    };
  },
};
