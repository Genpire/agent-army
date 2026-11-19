import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useToast } from "@astryxdesign/core/Toast";
import { ClipboardDocumentIcon } from "@heroicons/react/24/outline";

export interface CopyFieldProps {
  label: string;
  value: string;
  description?: string;
}

/** A read-only value with a copy button: URLs to paste into Slack or GitHub, generated secrets. */
export function CopyField({ label, value, description }: CopyFieldProps) {
  const showToast = useToast();
  return (
    <HStack gap={2} vAlign="end">
      <TextInput label={label} value={value} description={description} isReadOnly />
      <IconButton
        label={`Copy ${label.toLowerCase()}`}
        tooltip="Copy"
        icon={<Icon icon={ClipboardDocumentIcon} />}
        clickAction={async () => {
          await navigator.clipboard.writeText(value);
          showToast({ body: "Copied", type: "info", uniqueID: `copy-${label}` });
        }}
      />
    </HStack>
  );
}
