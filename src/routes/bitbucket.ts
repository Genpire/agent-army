/** Bitbucket admin routes (/api/bitbucket/…) and webhook. Placeholder until the Bitbucket work package replaces it. */
import { Router } from "express";
import type { IntegrationRouteDeps } from "./types.js";

export function bitbucketRoutes(_deps: IntegrationRouteDeps): Router {
  return Router();
}
