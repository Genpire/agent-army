import type { LessonsContext } from "./agents.js";

/**
 * The lessons library: what earlier tasks on a repository got wrong, or nearly
 * did, and how to avoid it, filed by area. Unlike project notes (one curated
 * text), lessons accumulate. (Contract stub: the store, the folder written out
 * for each run and the prompt section are filled in by the lessons work.)
 */

/** The orchestrator prompt's section on the lessons written out for this run; "" when there are none. */
export function lessonsSection(lessons: LessonsContext | undefined): string {
  if (!lessons?.count) return "";
  return "";
}
