/**
 * The Skills page's shapes, from the server's own types (type-only imports),
 * and the small helpers the page and the Team page's agent drawer share.
 */
import type { SkillCandidate } from "../../../../src/skills/skill-scout.js";
import type { SKILL_LIMITS, SkillAssignment, SkillPreview, SkillSource, SkillView } from "../../../../src/skills/skills.js";
import type { AgentSpec } from "../../lib/types";

export type { SkillAssignment, SkillCandidate, SkillPreview, SkillSource, SkillView };

/** GET /api/skills */
export interface SkillList {
  skills: SkillView[];
  limits: typeof SKILL_LIMITS;
}

/** GET /api/skills/:name */
export interface SkillDetail {
  skill: SkillView;
  skillMd: string;
}

/** POST /api/skills/find */
export interface FindResult {
  candidates: SkillCandidate[];
  costUsd?: number;
}

/** Where to add a skill from: a GitHub folder or a pasted SKILL.md. */
export type SkillInput = { url: string } | { skillMd: string };

export const skillPath = (name: string) => `/api/skills/${encodeURIComponent(name)}`;

/** "12 KB", "1.4 MB" */
export const formatBytes = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} bytes`);

/** "anthropics/skills · skills/pdf", or "Pasted" for a skill without a source. */
export function sourceLabel(source: SkillSource | undefined): string {
  if (!source) return "Pasted";
  return source.repo ? `${source.repo}${source.path ? ` · ${source.path}` : ""}` : source.url;
}

/** "All agents", "Coder and QA", "Coder, QA and 2 more", "Nobody yet". */
export function assignedLabel(assigned: SkillAssignment, agents: Pick<AgentSpec, "id" | "name">[]): string {
  if (assigned === "all") return "All agents";
  const names = assigned.map((id) => agents.find((a) => a.id === id)?.name ?? id);
  if (names.length === 0) return "Nobody yet";
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`;
}

/** SKILL.md without its frontmatter block, for rendering. */
export function skillBody(skillMd: string): string {
  const text = skillMd.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return text;
  const end = text.indexOf("\n---", 4);
  if (end < 0) return text;
  return text.slice(text.indexOf("\n", end + 1) + 1).trim();
}

/** Frontmatter fields shown on their own, beyond name, description and licence (e.g. allowed-tools). */
export const extraFields = (frontmatter: Record<string, string>) =>
  Object.entries(frontmatter).filter(([key]) => !["name", "description", "license"].includes(key));
