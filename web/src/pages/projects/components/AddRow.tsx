import { FieldStatus } from "@astryxdesign/core/FieldStatus";
import { HStack } from "@astryxdesign/core/HStack";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";

export interface AddRowProps {
  /** The row's inputs and its add button, laid out on one line (wrapping on narrow screens). */
  children: ReactNode;
  /** Shown under the row. Give the failing inputs `status={{ type: "error" }}` so they are marked too. */
  error?: string;
}

/**
 * The inline form under a table that adds one row. The error sits under the
 * whole row rather than under one field, so the inputs and the button stay
 * aligned on their baseline when it appears.
 */
export function AddRow({ children, error }: AddRowProps) {
  return (
    <VStack gap={2} hAlign="start">
      <HStack gap={2} vAlign="end" wrap="wrap">
        {children}
      </HStack>
      {error && <FieldStatus type="error" variant="detached" message={error} />}
    </VStack>
  );
}
