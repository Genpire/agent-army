/**
 * What each integration's routes (src/routes/<integration>.ts) get from the
 * server. Admin routes live under /api/<integration>/… behind requireAdmin
 * (the JSON body parser is already applied to /api); webhook routes live
 * outside /api and parse their own raw bodies.
 */
import type { Request, RequestHandler } from "express";
import type { ConfigRepo } from "../core/config.js";
import type { ConversationService } from "../chat/conversations.js";
import type { Store } from "../core/store.js";
import type { TaskRepo } from "../tasks/tasks.js";
import type { WebhookDeps } from "../integrations/code-hosts/webhook.js";

export interface IntegrationRouteDeps {
  configRepo: ConfigRepo;
  store: Store;
  tasks: TaskRepo;
  masterKey: Buffer;
  requireAdmin: RequestHandler;
  /** Brute-force brake for unauthenticated routes that check a secret. */
  throttle: RequestHandler;
  /** This deployment's public address (PUBLIC_URL, else the request's), without a trailing slash. */
  baseUrl: (req: Request) => string;
  /** Starts a repo task outside Slack, as the monday.com automation does (a console conversation per task). */
  startDirectTask: ConversationService["startDirectTask"];
  /** What review follow-ups need (Slack, tasks, runner, console threads, store, spending): see webhook.ts. */
  webhookDeps: WebhookDeps;
}
