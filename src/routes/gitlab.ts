/** GitLab admin routes (/api/gitlab/…) and webhook. Placeholder until the GitLab work package replaces it. */
import { Router } from "express";
import type { IntegrationRouteDeps } from "./types.js";

export function gitlabRoutes(_deps: IntegrationRouteDeps): Router {
  return Router();
}
