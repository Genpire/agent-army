// Every deploy target, by id.
import { docker } from "./docker.js";
import { fly } from "./fly.js";
import { gcloud } from "./gcloud.js";
import { railway } from "./railway.js";
import { render } from "./render.js";
import { vm } from "./vm.js";

/** @typedef {import("../types.js").Provider} Provider */
/** @typedef {import("../types.js").ProviderId} ProviderId */

/** @type {Record<ProviderId, Provider>} */
export const PROVIDERS = { fly, railway, render, gcloud, docker, vm };

/** What each one is, for the menu. @type {Record<ProviderId, string>} */
export const PROVIDER_HINTS = {
  fly: "about $54/month, the CLI does everything",
  railway: "about $10-30/month, usage-billed",
  render: "about $85-135/month, set up in the browser",
  gcloud: "about $53/month plus task time, Cloud Run with a job per task",
  docker: "free, this computer only (no Slack without a tunnel)",
  vm: "your own server from about EUR 9/month, HTTPS with Caddy",
};
