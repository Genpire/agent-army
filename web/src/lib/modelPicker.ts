/**
 * The model picker's logic as plain functions (components/ModelPicker.tsx
 * renders it): the rows it offers (the choices that are not a model, then the
 * source's models, grouped by family when that helps), how a query filters
 * them, and a model id typed by hand, checked with the server's own rule
 * (src/ai/model-ids.ts).
 */
import type { SearchableItem } from "@astryxdesign/core/Typeahead";
import { type ModelIdKind, modelIdProblem } from "../../../src/ai/model-ids.js";
import type { CatalogModel, ModelList } from "./types";

/** A choice that is not a model id: "Same as Pointer", "Claude default", "The CLI's default" (value "" in each). */
export interface PickerSpecial {
  value: string;
  label: string;
  description?: string;
}

export interface PickerItemData {
  /** What is saved: a model id, or a special choice's value. */
  value: string;
  description: string;
  kind: "special" | "model" | "custom";
  /** The family heading the row is listed under (Typeahead groups rows by it). */
  group?: string;
}

export type PickerItem = SearchableItem<PickerItemData>;

/** Grouping helps once the list is long and has more than one family. */
const GROUP_AFTER = 8;
const DEPRECATED_GROUP = "Deprecated";

const round2 = (n: number) => String(Math.round(n * 100) / 100);

/** "1M context", "200K context", "128K context" (131,072 tokens); undefined without a number. */
export function contextText(tokens: number | undefined): string | undefined {
  if (!tokens || tokens <= 0 || !Number.isFinite(tokens)) return undefined;
  const k = tokens % 1024 === 0 ? 1024 : 1000;
  if (tokens >= k * k) return `${round2(tokens / (k * k))}M context`;
  if (tokens >= k) return `${round2(tokens / k)}K context`;
  return `${tokens} tokens of context`;
}

/** A model's line under its name: its id, context window, a note from the provider, and whether it is deprecated. */
export function modelDescription(m: CatalogModel, extra?: string): string {
  return [m.id, contextText(m.contextWindow), m.description, m.deprecated ? "deprecated" : undefined, extra].filter(Boolean).join(" · ");
}

/** The list, then the models it does not have (ids set elsewhere), each once. */
export function mergeModels(list: CatalogModel[], extra: CatalogModel[] = []): CatalogModel[] {
  const seen = new Set<string>();
  return [...list, ...extra].filter((m) => !seen.has(m.id) && Boolean(seen.add(m.id)));
}

export const shouldGroup = (models: CatalogModel[]): boolean =>
  models.length > GROUP_AFTER && new Set(models.map((m) => m.family).filter(Boolean)).size > 1;

/**
 * Every row: the special choices first, then the models (current ones before
 * deprecated ones, which go under their own heading), under family headings
 * when the list is long enough to need them.
 */
export function pickerItems(specials: PickerSpecial[], models: CatalogModel[], describe?: (m: CatalogModel) => string | undefined): PickerItem[] {
  const grouped = shouldGroup(models);
  const items: PickerItem[] = specials.map((s) => ({ id: `special:${s.value}`, label: s.label, auxiliaryData: { value: s.value, description: s.description ?? "", kind: "special" } }));
  const seen = new Set(specials.map((s) => s.value));
  for (const m of [...models.filter((x) => !x.deprecated), ...models.filter((x) => x.deprecated)]) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const group = m.deprecated ? DEPRECATED_GROUP : grouped ? (m.family ?? "Other") : undefined;
    items.push({ id: `model:${m.id}`, label: m.label || m.id, auxiliaryData: { value: m.id, description: modelDescription(m, describe?.(m)), kind: "model", ...(group ? { group } : {}) } });
  }
  return items;
}

const searchText = (item: PickerItem) =>
  [item.label, item.auxiliaryData?.value, item.auxiliaryData?.description, item.auxiliaryData?.group].filter(Boolean).join(" ").toLowerCase();

/** The rows matching every word of the query, in the label, the id, the description or the family ("opus 5", "gemini-4", "1m"). */
export function filterItems(items: PickerItem[], query: string): PickerItem[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return items;
  return items.filter((item) => {
    const text = searchText(item);
    return words.every((w) => text.includes(w));
  });
}

/** Why a typed model id cannot be used, or undefined: the server's rule for that kind, and the field's length. */
export const customIdProblem = (id: string, kind: ModelIdKind, maxLength?: number): string | undefined => modelIdProblem(id.trim(), kind, maxLength);

/** A row for the typed text as a model id, when it is one and the list does not have it. */
export function customItem(query: string, items: PickerItem[], kind: ModelIdKind, maxLength?: number): PickerItem | undefined {
  const id = query.trim();
  if (!id || items.some((i) => i.auxiliaryData?.value === id) || customIdProblem(id, kind, maxLength)) return undefined;
  return { id: `custom:${id}`, label: `Use “${id}”`, auxiliaryData: { value: id, description: "A model id typed by hand, sent as it is", kind: "custom" } };
}

/** What a query shows: the matching rows, and the typed id as a choice of its own when it is a new, valid id. */
export function searchItems(items: PickerItem[], query: string, kind: ModelIdKind, maxLength?: number): PickerItem[] {
  const custom = customItem(query, items, kind, maxLength);
  return [...filterItems(items, query), ...(custom ? [custom] : [])];
}

/** What the menu says when nothing matches: and, when the text cannot be a model id, why. */
export function noMatchText(query: string, kind: ModelIdKind, maxLength?: number): string {
  const id = query.trim();
  const problem = id ? customIdProblem(id, kind, maxLength) : undefined;
  return problem ? `No model matches. ${problem}` : "No model matches.";
}

/** The row for the saved value: from the list, else the saved id as it is (with `describe`'s words); null for an empty value without a choice for it. */
export function currentItem(value: string, items: PickerItem[], describe?: (id: string) => string): PickerItem | null {
  const listed = items.find((i) => i.auxiliaryData?.value === value);
  if (listed) return listed;
  if (!value) return null;
  return { id: `custom:${value}`, label: value, auxiliaryData: { value, description: describe?.(value) ?? "Not in the list", kind: "custom" } };
}

/** Where the list came from, for the line under the picker. */
export function listStatus(list: ModelList | undefined): string | undefined {
  if (!list) return undefined;
  const count = `${list.models.length} model${list.models.length === 1 ? "" : "s"}`;
  return list.live ? `Live from ${list.source}: ${count}.` : (list.reason ?? `Built-in list: ${count}.`);
}
