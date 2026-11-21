// Google Cloud Run: inside a clone, run the repo's deploy/gcp.sh (with the keys made here stored in
// Secret Manager first, which the script then keeps); anywhere else, open it in Cloud Shell.
import { join } from "node:path";
import { CLOUD_SHELL_URL, REPO_URL } from "../constants.js";
import { CommandError } from "../exec.js";
import { askForUrl } from "./render.js";

/** @typedef {import("../types.js").Provider} Provider */
/** @typedef {import("../types.js").Context} Context */

const PROJECT_RE = /^[a-z][a-z0-9:.-]{4,62}$/;

/** @param {Context} ctx */
const cloneOf = (ctx) => /** @type {string | undefined} */ (ctx.detection.details.clone);

/**
 * gcp.sh's settings. Always on (MIN_INSTANCES=1) on a 1 vCPU / 2 GiB server, since repo tasks run in
 * the worker job. Values already in the environment win.
 * @param {{ project: string, region: string, name: string, env: Record<string, string | undefined> }} options
 */
export function gcpScriptEnv({ project, region, name, env }) {
  return {
    PROJECT: project,
    REGION: region,
    NAME: name,
    MIN_INSTANCES: env.MIN_INSTANCES ?? "1",
    SERVICE_CPU: env.SERVICE_CPU ?? "1",
    SERVICE_MEMORY: env.SERVICE_MEMORY ?? "2Gi",
  };
}

/** @type {Provider} */
export const gcloud = {
  id: "gcloud",
  label: "Google Cloud Run",
  installUrl: "https://cloud.google.com/sdk/docs/install",
  loginCommand: "gcloud auth login",
  requiresCli: (ctx) => Boolean(cloneOf(ctx)),
  defaultRegion: "us-central1",

  async prepare(ctx) {
    if (!cloneOf(ctx)) return;
    const current = /** @type {string | undefined} */ (ctx.detection.details.project);
    let project = ctx.options.project ?? current;
    if (!ctx.options.project && ctx.prompt.interactive) project = await ctx.prompt.ask("Google Cloud project id", current ?? "");
    if (!project) {
      throw new CommandError("No Google Cloud project is set.", {
        hint: "Pass --project <id>, or run: gcloud config set project <id>",
      });
    }
    if (!PROJECT_RE.test(project)) throw new CommandError(`"${project}" is not a Google Cloud project id.`);
    ctx.answers.project = project;
  },

  plan: (ctx) =>
    cloneOf(ctx)
      ? `Cloud Run service ${ctx.options.name} and job ${ctx.options.name}-worker in ${ctx.answers.project} (${ctx.options.region}) with deploy/gcp.sh: ` +
        "one always-on 1 vCPU / 2 GiB server (about $53/month) plus each task's job time."
      : "Google Cloud Shell in your browser, which clones the repository and runs deploy/gcp.sh there.",

  async deploy(ctx) {
    const clone = cloneOf(ctx);
    const { name, region } = ctx.options;
    if (!clone) return cloudShell(ctx);

    const project = /** @type {string} */ (ctx.answers.project);
    const g = ["--project", project, "--quiet"];
    /** @param {string[]} args @param {import("../types.js").RunOptions} [options] */
    const gcloudRun = (args, options = {}) => ctx.run.run("gcloud", args, options);

    ctx.out.step("Enabling Secret Manager");
    await gcloudRun(["services", "enable", "secretmanager.googleapis.com", ...g]);

    ctx.out.step("Storing the keys in Secret Manager (gcp.sh keeps secrets that already exist)");
    let keysAreOurs = true;
    let tokenIsOurs = true;
    for (const [secret, value, label] of /** @type {const} */ ([
      [`${name}-master-key`, ctx.secrets.masterKey, "MASTER_KEY"],
      [`${name}-setup-token`, ctx.secrets.setupToken, "SETUP_TOKEN"],
    ])) {
      const exists = (await ctx.run.probe("gcloud", ["secrets", "describe", secret, "--project", project])).code === 0;
      if (exists) {
        ctx.out.line(`${secret} already exists: keeping it (an earlier deployment named ${name}).`);
        if (label === "MASTER_KEY") keysAreOurs = false;
        else tokenIsOurs = false;
        continue;
      }
      if (label === "MASTER_KEY") ctx.saveKeys({ GOOGLE_CLOUD_PROJECT: project, GOOGLE_CLOUD_REGION: region });
      await gcloudRun(["secrets", "create", secret, "--replication-policy", "automatic", "--data-file=-", ...g], {
        input: value,
        inputLabel: `${label} on stdin`,
        capture: true,
      });
      ctx.created.push({ what: `Secret Manager secret ${secret}`, remove: `gcloud secrets delete ${secret} --project ${project}` });
    }

    ctx.out.step("Running deploy/gcp.sh: Cloud Build builds the image, then the job and the service are deployed (10 to 15 minutes)");
    ctx.created.push(
      { what: `Cloud Run service ${name}`, remove: `gcloud run services delete ${name} --region ${region} --project ${project}` },
      { what: `Cloud Run job ${name}-worker`, remove: `gcloud run jobs delete ${name}-worker --region ${region} --project ${project}` },
      { what: `Bucket gs://${project}-${name}-data (the data)`, remove: `gcloud storage rm --recursive gs://${project}-${name}-data` },
      {
        what: `Service accounts ${name}-server and ${name}-worker`,
        remove:
          `gcloud iam service-accounts delete ${name}-server@${project}.iam.gserviceaccount.com --project ${project} && ` +
          `gcloud iam service-accounts delete ${name}-worker@${project}.iam.gserviceaccount.com --project ${project}`,
      },
      { what: `Artifact Registry repository ${name}`, remove: `gcloud artifacts repositories delete ${name} --location ${region} --project ${project}` },
    );
    await ctx.run.run("bash", [join("deploy", "gcp.sh")], {
      cwd: clone,
      env: gcpScriptEnv({ project, region, name, env: ctx.env }),
      showEnv: true,
    });

    const described = await gcloudRun(
      ["run", "services", "describe", name, "--region", region, "--project", project, "--format", "value(status.url)"],
      { capture: true, dryRunStdout: `https://${name}-<project-number>.${region}.run.app` },
    );
    const url = described.stdout.trim().split(/\s+/)[0] || undefined;

    return {
      url,
      waitForHealth: Boolean(url),
      setupTokenHint: tokenIsOurs ? undefined : `gcloud secrets versions access latest --secret ${name}-setup-token --project ${project}`,
      masterKeyHint: keysAreOurs ? undefined : `in Secret Manager: ${name}-master-key (project ${project})`,
      notes: [
        `Update: run deploy/gcp.sh again with the same PROJECT, REGION and NAME (or this installer, from the clone).`,
        `Logs:   gcloud run services logs read ${name} --region ${region} --project ${project}`,
      ],
      notHealthyHint: `gcloud run services logs read ${name} --region ${region} --project ${project}`,
    };
  },
};

/** Not in a clone: open the repository in Cloud Shell and say what to run there. @param {Context} ctx */
async function cloudShell(ctx) {
  const { name, region } = ctx.options;
  ctx.out.step("Opening Google Cloud Shell in your browser");
  ctx.out.line("This folder is not a clone of Agent Army, so deploy/gcp.sh runs in Cloud Shell instead.");
  await ctx.openUrl(CLOUD_SHELL_URL);
  ctx.out.line();
  ctx.out.line("In Cloud Shell (it opens the repository in a temporary environment):");
  ctx.out.line("  gcloud auth login");
  ctx.out.line("  gcloud config set project <your-project-id>");
  ctx.out.line(`  PROJECT=<your-project-id> REGION=${region} NAME=${name} MIN_INSTANCES=1 SERVICE_CPU=1 SERVICE_MEMORY=2Gi ./deploy/gcp.sh`);
  ctx.out.line("The script prints the address and the setup token at the end.");
  ctx.out.line();
  ctx.out.line(`Or run it from this computer: git clone ${REPO_URL}.git && cd agent-army && npx create-agent-army --provider gcloud`);
  ctx.out.line();
  const url = await askForUrl(ctx, "Paste the address gcp.sh printed (Enter to skip)");
  return {
    url,
    waitForHealth: Boolean(url),
    setupTokenHint: "printed by deploy/gcp.sh",
    masterKeyHint: `in Secret Manager: ${name}-master-key`,
    notes: [],
  };
}
