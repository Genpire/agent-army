// Fixed addresses and defaults. A fork changes REPO (and the image) here.

/** The GitHub repository the scripts and buttons come from. */
export const REPO = "Genpire/agent-army";
export const REPO_URL = `https://github.com/${REPO}`;

/** The prebuilt public image (amd64 and arm64), published by the repo's release workflow. */
export const DEFAULT_IMAGE = "ghcr.io/genpire/agent-army:latest";

/** The VM installer (Docker, the app and Caddy for HTTPS). Its options are environment variables. */
export const INSTALL_SH_URL = `https://raw.githubusercontent.com/${REPO}/main/deploy/install.sh`;

/** Render's one-click deploy of the repo's render.yaml Blueprint. */
export const RENDER_DEPLOY_URL = `https://render.com/deploy?repo=${REPO_URL}`;

/** "Open in Cloud Shell": clones the repo and opens its Cloud Run tutorial. */
export const CLOUD_SHELL_URL =
  "https://shell.cloud.google.com/cloudshell/editor?cloudshell_git_repo=" +
  encodeURIComponent(REPO_URL) +
  "&cloudshell_git_branch=main&cloudshell_tutorial=" +
  encodeURIComponent("deploy/gcp-tutorial.md") +
  "&show=terminal";

/** The container's port (the image's PORT). */
export const APP_PORT = 8080;

/** Minutes to wait for /healthz after a deploy. */
export const DEFAULT_TIMEOUT_MIN = 15;

export const PROVIDER_IDS = /** @type {const} */ (["fly", "railway", "render", "gcloud", "docker", "vm"]);
