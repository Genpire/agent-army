// Docker on this computer: the image with a named volume, on http://localhost:<port>.
import { APP_PORT } from "../constants.js";
import { CommandError } from "../exec.js";
import { keysFileName } from "../files.js";

/** @typedef {import("../types.js").Provider} Provider */

/**
 * The `docker run` arguments. The keys are passed as `-e NAME` (the value comes from the
 * environment of the docker command), so they never appear on a command line.
 * @param {{ name: string, image: string, port: number }} options
 */
export function dockerRunArgs({ name, image, port }) {
  return [
    "run",
    "--detach",
    "--name",
    name,
    "--restart",
    "unless-stopped",
    // Reaps the task workers' child processes.
    "--init",
    // Headless Chromium runs out of shared memory with Docker's 64 MB default.
    "--shm-size",
    "1g",
    // This computer only: the deployment is open until the admin account is created.
    "--publish",
    `127.0.0.1:${port}:${APP_PORT}`,
    "--volume",
    `${name}-data:/data`,
    "--env",
    "MASTER_KEY",
    "--env",
    "SETUP_TOKEN",
    "--env",
    "REQUIRE_MASTER_KEY=1",
    "--env",
    "STORAGE=fs",
    "--env",
    "DATA_DIR=/data",
    "--env",
    "RUNNER=local",
    image,
  ];
}

/** @type {Provider} */
export const docker = {
  id: "docker",
  label: "Docker (this computer)",
  installUrl: "https://docs.docker.com/get-started/get-docker/",
  loginCommand: "Start Docker Desktop (on Linux: sudo systemctl start docker)",
  requiresCli: () => true,

  plan: ({ options }) =>
    `Container ${options.name} with the volume ${options.name}-data on http://localhost:${options.port} (this computer only).`,

  async deploy(ctx) {
    const { name, image, port } = ctx.options;
    const url = `http://localhost:${port}`;

    const existing = await ctx.run.probe("docker", ["container", "inspect", name]);
    if (existing.code === 0 && !ctx.run.dryRun) {
      throw new CommandError(`A container named ${name} already exists.`, {
        hint: `Choose another --name, or remove it first: docker rm -f ${name}`,
      });
    }
    ctx.saveKeys({ AGENT_ARMY_URL: url });

    ctx.out.step(`Pulling ${image} (about 1 GB)`);
    try {
      await ctx.run.run("docker", ["pull", image]);
    } catch (err) {
      if (!(err instanceof CommandError)) throw err;
      // A local build (--image agent-army:dev) can't be pulled, and needn't be.
      const local = await ctx.run.probe("docker", ["image", "inspect", image]);
      if (local.code !== 0) {
        err.hint = `If the image is private, make the package public on GitHub, or log in first: docker login ghcr.io`;
        throw err;
      }
      ctx.out.warn(`Could not pull ${image}; using the copy already on this computer.`);
    }

    ctx.out.step("Starting the container");
    await ctx.run.run("docker", ["volume", "create", `${name}-data`], { capture: true });
    ctx.created.push({ what: `Docker volume ${name}-data (the data)`, remove: `docker volume rm ${name}-data` });
    await ctx.run.run("docker", dockerRunArgs({ name, image, port }), {
      env: { MASTER_KEY: ctx.secrets.masterKey, SETUP_TOKEN: ctx.secrets.setupToken },
      inputLabel: "MASTER_KEY and SETUP_TOKEN come from the environment",
      capture: true,
    });
    ctx.created.push({ what: `Docker container ${name}`, remove: `docker rm -f ${name}` });

    const keys = keysFileName(name);
    return {
      url,
      waitForHealth: true,
      notes: [
        "This runs on this computer only. Slack needs a public HTTPS address: put a tunnel in front",
        `  (for example: cloudflared tunnel --url ${url}) or deploy to a cloud provider.`,
        `Logs:    docker logs -f ${name}`,
        `Update:  docker pull ${image} && docker rm -f ${name}, then start it again with the same keys:`,
        `         set -a && . ./${keys} && set +a && docker ${dockerRunArgs({ name, image, port }).join(" ")}`,
        `Remove:  docker rm -f ${name} && docker volume rm ${name}-data  (deletes the data)`,
      ],
      notHealthyHint: `docker logs ${name}`,
    };
  },
};
