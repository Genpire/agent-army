import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Selector } from "@astryxdesign/core/Selector";
import { StackItem } from "@astryxdesign/core/Stack";
import { TextInput } from "@astryxdesign/core/TextInput";
import { MagnifyingGlassIcon, PlusIcon } from "@heroicons/react/24/outline";
import { ALL_CATEGORIES } from "./model";

export interface HubToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** ALL_CATEGORIES or a category. */
  category: string;
  onCategoryChange: (category: string) => void;
  categories: readonly string[];
  onAddCustom: () => void;
}

/** One search over everything, a category filter, and a custom app. Wraps under the search on phones. */
export function HubToolbar({ query, onQueryChange, category, onCategoryChange, categories, onAddCustom }: HubToolbarProps) {
  return (
    <HStack gap={3} vAlign="end" wrap="wrap">
      <StackItem size="fill">
        <TextInput
          type="search"
          label="Search integrations and apps"
          isLabelHidden
          placeholder="Search, e.g. GitHub, issues, payments"
          startIcon={MagnifyingGlassIcon}
          enterKeyHint="search"
          value={query}
          onChange={onQueryChange}
          width="100%"
        />
      </StackItem>
      <HStack gap={3} vAlign="end">
        <Selector
          label="Category"
          isLabelHidden
          options={[{ value: ALL_CATEGORIES, label: "All categories" }, ...categories.map((c) => ({ value: c, label: c }))]}
          value={category}
          onChange={onCategoryChange}
        />
        <Button label="Custom app" variant="secondary" icon={<Icon icon={PlusIcon} size="sm" />} onClick={onAddCustom} />
      </HStack>
    </HStack>
  );
}
