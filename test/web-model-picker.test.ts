import { describe, expect, it } from "vitest";
import { ENGINE_MODEL_RE, MODEL_ID_RE, modelIdProblem } from "../src/ai/model-ids.js";
import { MODEL_ID_RE as SERVER_MODEL_ID_RE } from "../src/ai/ai-providers.js";
import { AgentSpecSchema, EngineModelSchema, defaultTeam } from "../src/team/team.js";
import type { CatalogModel, ModelList } from "../src/ai/model-catalog.js";
import {
  contextText,
  currentItem,
  customIdProblem,
  customItem,
  filterItems,
  listStatus,
  mergeModels,
  noMatchText,
  pickerItems,
  searchItems,
  shouldGroup,
} from "../web/src/lib/modelPicker.js";

const claude: CatalogModel[] = [
  { id: "claude-fable-5-2", label: "Fable 5.2", contextWindow: 1_000_000, family: "Fable" },
  { id: "claude-opus-5-5", label: "Opus 5.5", contextWindow: 1_000_000, family: "Opus" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5", contextWindow: 1_000_000, family: "Sonnet" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5", contextWindow: 1_000_000, family: "Haiku" },
  { id: "claude-fable-5-1", label: "Fable 5.1", contextWindow: 1_000_000, family: "Fable" },
  { id: "claude-opus-5", label: "Opus 5", contextWindow: 1_000_000, family: "Opus" },
  { id: "claude-opus-4-8", label: "Opus 4.8", contextWindow: 1_000_000, family: "Opus" },
  { id: "claude-sonnet-5", label: "Sonnet 5", contextWindow: 1_000_000, family: "Sonnet" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", contextWindow: 200_000, family: "Haiku" },
  { id: "claude-sonnet-4-5-20250929", label: "Sonnet 4.5", family: "Sonnet", deprecated: true },
];
const same = [{ value: "", label: "Same as Pointer", description: "The model Pointer runs on" }];
const values = (items: { auxiliaryData?: { value: string } }[]) => items.map((i) => i.auxiliaryData?.value);

describe("the model picker's rows", () => {
  it("puts the special choices first, then the models grouped by family when the list is long, deprecated ones last", () => {
    const items = pickerItems(same, claude);
    expect(values(items)).toEqual(["", ...claude.map((m) => m.id)]);
    expect(items[0]).toMatchObject({ label: "Same as Pointer", auxiliaryData: { kind: "special", description: "The model Pointer runs on" } });
    expect(items[1]).toMatchObject({ id: "model:claude-fable-5-2", label: "Fable 5.2", auxiliaryData: { kind: "model", group: "Fable", description: "claude-fable-5-2 · 1M context" } });
    expect(items.at(-1)!.auxiliaryData).toMatchObject({ group: "Deprecated", description: "claude-sonnet-4-5-20250929 · deprecated" });
    // A short list, or one family, is not grouped.
    expect(shouldGroup(claude.slice(0, 3))).toBe(false);
    expect(pickerItems([], claude.slice(0, 3)).every((i) => i.auxiliaryData?.group === undefined)).toBe(true);
    // Notes (a price) join the description; a special's value is never listed twice.
    const priced = pickerItems([{ value: "claude-opus-5-5", label: "Default: Opus 5.5" }], claude, (m) => (m.id === "claude-sonnet-5-5" ? "$2 in, $10 out" : undefined));
    expect(values(priced).filter((v) => v === "claude-opus-5-5")).toHaveLength(1);
    expect(priced.find((i) => i.auxiliaryData?.value === "claude-sonnet-5-5")!.auxiliaryData!.description).toBe("claude-sonnet-5-5 · 1M context · $2 in, $10 out");
  });

  it("adds the models set elsewhere that the list lacks, once each", () => {
    const merged = mergeModels(claude.slice(0, 2), [{ id: "claude-opus-5-5", label: "dup" }, { id: "kimi-k3[1m]", label: "kimi-k3[1m]", description: "Set under Integrations" }]);
    expect(merged.map((m) => m.id)).toEqual(["claude-fable-5-2", "claude-opus-5-5", "kimi-k3[1m]"]);
  });

  it("writes context windows the way providers do", () => {
    expect(contextText(1_000_000)).toBe("1M context");
    expect(contextText(1_048_576)).toBe("1M context");
    expect(contextText(1_050_000)).toBe("1.05M context");
    expect(contextText(200_000)).toBe("200K context");
    expect(contextText(131_072)).toBe("128K context");
    expect(contextText(undefined)).toBeUndefined();
    expect(contextText(0)).toBeUndefined();
  });
});

describe("filtering the rows", () => {
  const items = pickerItems(same, claude);
  it("matches every word in the name, the id, the description or the family, in any case", () => {
    expect(values(filterItems(items, "opus"))).toEqual(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8"]);
    expect(values(filterItems(items, "OPUS 5.5"))).toEqual(["claude-opus-5-5"]);
    expect(values(filterItems(items, "claude-haiku"))).toEqual(["claude-haiku-5-5", "claude-haiku-4-5"]);
    expect(values(filterItems(items, "200k"))).toEqual(["claude-haiku-4-5"]);
    expect(values(filterItems(items, "deprecated"))).toEqual(["claude-sonnet-4-5-20250929"]);
    expect(values(filterItems(items, "same"))).toEqual([""]);
    expect(filterItems(items, "   ")).toBe(items);
    expect(filterItems(items, "gpt")).toEqual([]);
  });

  it("offers a typed id that the list lacks as a choice of its own, checked with the server's rule", () => {
    expect(values(searchItems(items, "claude-opus-5-5", "provider"))).toEqual(["claude-opus-5-5"]);
    const typed = searchItems(items, "  claude-mythos-5-2 ", "provider");
    expect(typed.at(-1)).toMatchObject({ id: "custom:claude-mythos-5-2", label: "Use “claude-mythos-5-2”", auxiliaryData: { value: "claude-mythos-5-2", kind: "custom" } });
    // A provider's id may hold brackets and tildes; an engine's may not.
    expect(customItem("kimi-k3[1m]", items, "provider")).toBeDefined();
    expect(customItem("kimi-k3[1m]", items, "engine")).toBeUndefined();
    expect(customItem("gemini-4-carbon", items, "engine")).toBeDefined();
    expect(customItem("has space", items, "provider")).toBeUndefined();
    expect(customItem("x".repeat(101), items, "provider", 100)).toBeUndefined();
    expect(customItem("", items, "provider")).toBeUndefined();
  });

  it("says why a typed text cannot be a model id when nothing matches", () => {
    expect(noMatchText("gemini 4", "engine")).toBe("No model matches. A model id is letters, digits and . _ : / -, like the CLI's --model takes.");
    expect(noMatchText("my-model", "engine")).toBe("No model matches.");
    expect(noMatchText("", "provider")).toBe("No model matches.");
    expect(customIdProblem("a b", "provider")).toBe("A model id has no spaces or other special characters.");
    expect(customIdProblem("x".repeat(120), "engine")).toBe("Model ids are at most 100 characters.");
  });
});

describe("the saved value and the list's status", () => {
  const items = pickerItems(same, claude);
  it("shows the saved value's row, or the id as saved, or nothing for an empty value without a choice", () => {
    expect(currentItem("", items)?.label).toBe("Same as Pointer");
    expect(currentItem("claude-opus-5-5", items)?.label).toBe("Opus 5.5");
    expect(currentItem("claude-opus-4-1", items, (id) => `${id} is not listed`)).toMatchObject({ label: "claude-opus-4-1", auxiliaryData: { kind: "custom", description: "claude-opus-4-1 is not listed" } });
    expect(currentItem("", pickerItems([], claude))).toBeNull();
  });

  it("says whether the list is live or built in, and why", () => {
    const live: ModelList = { models: claude, live: true, fetchedAt: "2026-11-21T10:00:00Z", source: "Anthropic" };
    expect(listStatus(live)).toBe("Live from Anthropic: 10 models.");
    expect(listStatus({ ...live, live: false, reason: "Anthropic is not connected yet: this is the built-in list." })).toBe("Anthropic is not connected yet: this is the built-in list.");
    expect(listStatus({ ...live, models: claude.slice(0, 1), live: false })).toBe("Built-in list: 1 model.");
    expect(listStatus(undefined)).toBeUndefined();
  });
});

describe("model id rules shared by the server and the picker", () => {
  it("are one rule: the providers' and the engines'", () => {
    expect(SERVER_MODEL_ID_RE).toBe(MODEL_ID_RE);
    expect(modelIdProblem("us.anthropic.claude-haiku-4-5-20251001-v1:0", "provider")).toBeUndefined();
    expect(modelIdProblem("~anthropic/claude-opus-latest", "provider")).toBeUndefined();
    expect(ENGINE_MODEL_RE.test("models/gemini-4-neon")).toBe(true);
    expect(ENGINE_MODEL_RE.test("-gemini")).toBe(false);
  });

  it("check AgentSpec.engineModel: optional, empty by default, an engine model id when set", () => {
    const base = defaultTeam().agents[0]!;
    const { engineModel: _drop, ...older } = base;
    // An agent saved before the field existed.
    expect(AgentSpecSchema.parse(older).engineModel).toBe("");
    expect(AgentSpecSchema.parse({ ...base, engine: "gemini", engineModel: " gemini-4-carbon " }).engineModel).toBe("gemini-4-carbon");
    expect(AgentSpecSchema.safeParse({ ...base, engineModel: "gemini 4" }).success).toBe(false);
    expect(AgentSpecSchema.safeParse({ ...base, engineModel: "x".repeat(101) }).success).toBe(false);
    expect(EngineModelSchema.safeParse("").success).toBe(true);
    // Every built-in agent has the field.
    expect(defaultTeam().agents.every((a) => a.engineModel === "")).toBe(true);
  });
});
