import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { Typeahead, TypeaheadItem } from "@astryxdesign/core/Typeahead";
import type { SearchSource } from "@astryxdesign/core/Typeahead";
import { VStack } from "@astryxdesign/core/VStack";
import { useMemo, useState } from "react";
import { type ModelSource, useModelList } from "../lib/models";
import { type PickerItem, type PickerSpecial, currentItem, listStatus, mergeModels, noMatchText, pickerItems, searchItems } from "../lib/modelPicker";
import type { CatalogModel, ModelList } from "../lib/types";

export interface ModelPickerProps {
  label: string;
  /** Whose models it lists: an AI provider's or a coding engine's. */
  source: ModelSource;
  /** The saved model id, or a special choice's value ("" for the default). */
  value: string;
  onChange: (value: string) => void;
  /** Choices that are not a model id, listed first: "Same as Pointer", "Claude default", "The CLI's default". */
  specials?: PickerSpecial[];
  /** Models to offer that the list may not have (a tier's model typed under Integrations). */
  extra?: CatalogModel[];
  /** More words for some models' rows, by model id (a price). */
  modelNotes?: Record<string, string>;
  /** How a saved model the list does not name runs. */
  describeUnknown?: (id: string) => string;
  description?: string;
  placeholder?: string;
  isOptional?: boolean;
  isDisabled?: boolean;
  disabledMessage?: string;
  /** The longest id the field it saves to takes. */
  maxLength?: number;
}

/**
 * A model picker for any source: it loads the source's models when it opens
 * (live from the provider, or the built-in list, and says which), searches
 * them by name, id or family, groups them by family when the list is long,
 * and takes a model id typed by hand, checked with the server's rule.
 */
export function ModelPicker({
  label,
  source,
  value,
  onChange,
  specials = [],
  extra = [],
  modelNotes = {},
  describeUnknown,
  description,
  placeholder,
  isOptional,
  isDisabled,
  disabledMessage,
  maxLength,
}: ModelPickerProps) {
  const kind = source.kind === "engine" ? "engine" : "provider";
  const { list, loading, error, load } = useModelList(source);
  const [query, setQuery] = useState("");

  // The callers build these on every render: their content, not their identity, decides when the rows change
  // (a new search source makes the menu start over).
  const inputs = JSON.stringify([specials, extra, modelNotes]);
  const rowsOf = useMemo(() => {
    const [s, e, notes] = JSON.parse(inputs) as [PickerSpecial[], CatalogModel[], Record<string, string>];
    return (loaded: ModelList | undefined) => pickerItems(s, mergeModels(loaded?.models ?? [], e), (m) => notes[m.id]);
  }, [inputs]);
  const rows = useMemo(() => rowsOf(list), [rowsOf, list]);

  const searchSource = useMemo<SearchSource<PickerItem>>(
    () => ({
      bootstrap: async () => rowsOf(await load()),
      search: async (q) => searchItems(rowsOf(await load()), q, kind, maxLength),
    }),
    [rowsOf, load, kind, maxLength],
  );

  const selected = currentItem(value, rows, describeUnknown);
  const status = error ? `The list could not be loaded: ${error}` : (listStatus(list) ?? "Open the list to see the models, or type a model id.");

  return (
    <VStack gap={1}>
      <Typeahead<PickerItem>
        label={label}
        searchSource={searchSource}
        value={selected}
        onChange={(item) => onChange(item?.auxiliaryData?.value ?? "")}
        onChangeQuery={setQuery}
        renderItem={(item) => <TypeaheadItem item={item} description={item.auxiliaryData?.description || undefined} />}
        hasEntriesOnFocus
        debounceMs={0}
        maxMenuItems={500}
        emptySearchText={noMatchText(query, kind, maxLength)}
        placeholder={placeholder ?? "Search by name or id, or type a model id"}
        description={description}
        isOptional={isOptional}
        isDisabled={isDisabled}
        disabledMessage={disabledMessage}
        width="100%"
      />
      {selected?.auxiliaryData?.description && (
        <Text type="supporting" color="secondary">
          {selected.auxiliaryData.description}
        </Text>
      )}
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Text type="supporting" color="secondary">
          {status}
        </Text>
        <Button
          label="Refresh list"
          size="sm"
          variant="ghost"
          isLoading={loading}
          isDisabled={isDisabled}
          clickAction={async () => {
            await load(true);
          }}
        />
      </HStack>
    </VStack>
  );
}
