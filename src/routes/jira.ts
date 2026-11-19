/** Jira admin routes (/api/jira/…) and webhook. Placeholder until the Jira work package replaces it. */
import { Router } from "express";
import type { IntegrationRouteDeps } from "./types.js";

export function jiraRoutes(_deps: IntegrationRouteDeps): Router {
  return Router();
}
