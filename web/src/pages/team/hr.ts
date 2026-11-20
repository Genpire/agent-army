/**
 * The HR recommendations' vocabulary: proposal kinds and statuses as tokens,
 * the agent fields a change can touch, and the API calls. The shapes come
 * from src/hr.ts (type-only), so the page and the API cannot drift apart.
 */
import type { TokenColor } from "@astryxdesign/core/Token";
import type { ChangeField, DecisionResult, HrProposal, HrReview, ProposalKind, ProposalStatus } from "../../../../src/team/hr.js";
import { api } from "../../lib/api";
import type { Access } from "../../lib/types";

export type { AgentChanges, ChangeField, HrProposal, HrReview } from "../../../../src/team/hr.js";

/** Mirrors HR_AGENT_ID in src/hr.ts: the HR agent of the default team. */
export const HR_AGENT_ID = "hr";

/** What a review costs at most (HR_BUDGET_USD in src/hr.ts). */
export const REVIEW_BUDGET = "$0.50";

export const KIND_INFO: Record<ProposalKind, { label: string; color: TokenColor; description: string }> = {
  hire: { label: "Hire", color: "green", description: "Adds a new agent to the team." },
  change: { label: "Change", color: "blue", description: "Changes an agent's settings." },
  retire: { label: "Retire", color: "orange", description: "Disables an agent; it is never deleted." },
  skill: { label: "Skill", color: "purple", description: "A skill to find for the skills library." },
};

export const STATUS_INFO: Record<Exclude<ProposalStatus, "open">, { label: string; color: TokenColor }> = {
  applied: { label: "Applied", color: "green" },
  dismissed: { label: "Dismissed", color: "gray" },
};

export const FIELD_LABEL: Record<ChangeField, string> = {
  name: "Name",
  role: "Role",
  emoji: "Emoji",
  description: "When it is used",
  instructions: "Instructions",
  access: "Access",
  model: "Model",
  effort: "Effort",
  skills: "Skills",
};

const ACCESS_RANK: Record<Access, number> = { read: 0, run: 1, write: 2 };

/** True when a change gives the agent more access than it has. */
export const raisesAccess = (from: Access | undefined, to: Access | undefined): boolean =>
  from !== undefined && to !== undefined && ACCESS_RANK[to] > ACCESS_RANK[from];

export type Decision = Extract<DecisionResult, { ok: true }>;

const proposalPath = (review: HrReview, proposal: HrProposal, action: "apply" | "dismiss") =>
  `/api/hr/reviews/${encodeURIComponent(review.id)}/proposals/${encodeURIComponent(proposal.id)}/${action}`;

export const hrApi = {
  reviews: () => api.get<{ reviews: HrReview[] }>("/api/hr/reviews"),
  review: () => api.post<{ review: HrReview }>("/api/hr/review"),
  apply: (review: HrReview, proposal: HrProposal) => api.post<Decision>(proposalPath(review, proposal, "apply")),
  dismiss: (review: HrReview, proposal: HrProposal) => api.post<Decision>(proposalPath(review, proposal, "dismiss")),
  addHr: () => api.post("/api/hr/agent"),
};
