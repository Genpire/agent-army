/**
 * The office talk's API (routes/office.ts) as the page sees it. The web
 * imports these type-only (web/src/pages/office/), so the page and the server
 * cannot drift apart. Types and the list of kinds only: nothing here needs
 * another module at runtime.
 */
import type { OfficeTalkSettings } from "../core/config.js";

/** What people do together in the office (the page's activities). Gaming takes two: one playing alone has no talk. */
export const TALK_KINDS = ["chat", "coffee", "foosball", "pingpong", "pinball", "gaming"] as const;
export type TalkKind = (typeof TALK_KINDS)[number];

/** Who wrote a conversation. */
export type TalkProviderId = "gemini" | "chat";

export interface TalkLine {
  /** A person's id: an agent id, or "pointer" for the lead. */
  speaker: string;
  text: string;
}

/** POST /api/office/talk's body. */
export interface TalkRequest {
  activityId: string;
  kind: TalkKind;
  /** People ids: enabled agents' ids or "pointer", checked against the team by the route. */
  people: string[];
}

/** Why there is no conversation now: switched off, a limit reached, or no model to ask (or the call failed). */
export type TalkReason = "off" | "limit" | "unavailable";

/** POST /api/office/talk's answer: the lines and who wrote them, or none and why. */
export type TalkAnswer = { lines: TalkLine[]; provider: TalkProviderId; model: string } | { lines: []; reason: TalkReason };

/** POST /api/office/talk/settings's body: config.office.talk. A model is set only with "gemini" or "chat". */
export type TalkSettings = OfficeTalkSettings;

/** GET /api/office/talk/settings: the settings, the calls counted today (UTC) and which providers are there. */
export interface TalkSettingsView extends TalkSettings {
  usedToday: number;
  available: Record<TalkProviderId, boolean>;
}
