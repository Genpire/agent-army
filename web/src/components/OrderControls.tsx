import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { ArrowDownIcon, ArrowUpIcon, XMarkIcon } from "@heroicons/react/24/outline";

export interface OrderControlsProps {
  /** The row's name, for the buttons' accessible names: "Move Gemini up". */
  name: string;
  /** The row's place in the list, from 0. */
  index: number;
  /** How many rows the list has. */
  count: number;
  /** Moves the row one place: -1 up, 1 down. */
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  /** Why the row cannot be removed (the list needs it); undefined when it can. */
  removeDisabledMessage?: string;
  /** While a change is saving. */
  isDisabled?: boolean;
}

/**
 * Move up, move down and remove for one row of an ordered list (a route's
 * providers, an agent's fallbacks). The moves are left out while the list
 * has a single row.
 */
export function OrderControls({ name, index, count, onMove, onRemove, removeDisabledMessage, isDisabled }: OrderControlsProps) {
  return (
    <HStack gap={1} vAlign="center">
      {count > 1 && (
        <>
          <IconButton
            label={`Move ${name} up`}
            tooltip="Move up"
            icon={<Icon icon={ArrowUpIcon} />}
            size="sm"
            variant="ghost"
            isDisabled={isDisabled || index === 0}
            onClick={() => onMove(-1)}
          />
          <IconButton
            label={`Move ${name} down`}
            tooltip="Move down"
            icon={<Icon icon={ArrowDownIcon} />}
            size="sm"
            variant="ghost"
            isDisabled={isDisabled || index === count - 1}
            onClick={() => onMove(1)}
          />
        </>
      )}
      <IconButton
        label={`Remove ${name}`}
        tooltip={removeDisabledMessage ?? "Remove"}
        icon={<Icon icon={XMarkIcon} />}
        size="sm"
        variant="ghost"
        isDisabled={isDisabled || Boolean(removeDisabledMessage)}
        onClick={onRemove}
      />
    </HStack>
  );
}
