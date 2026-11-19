import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import type { ReactNode } from "react";

/** One settings group: what it is on the start side, its fields on the end side (folds to one column when narrow). */
export function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <Grid columns={{ minWidth: 320 }} gap={10}>
      <VStack gap={1}>
        <Heading level={3} accessibilityLevel={2}>
          {title}
        </Heading>
        <Text type="supporting">{description}</Text>
      </VStack>
      <VStack gap={5}>{children}</VStack>
    </Grid>
  );
}

export function SaveRow({ label, isDirty, isInvalid, pending, onSave }: { label: string; isDirty: boolean; isInvalid?: boolean; pending: boolean; onSave: () => void }) {
  return (
    <HStack gap={3} vAlign="center">
      <Button label={label} variant="primary" isLoading={pending} isDisabled={!isDirty || isInvalid} onClick={onSave} />
      {isDirty && <Text type="supporting">Unsaved changes</Text>}
    </HStack>
  );
}
