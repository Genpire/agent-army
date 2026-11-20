import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";

/** How one access choice reads. */
export interface AccessChoice {
  label: string;
  description: string;
}

export interface AccessFieldProps {
  value: "read" | "write";
  onChange: (value: "read" | "write") => void;
  appName: string;
  /** Pointer's name. */
  lead: string;
  isDisabled?: boolean;
  /** The choices in the app's own words (Genpire: "Look only", "Design too"); the general ones otherwise. */
  choices?: { read: AccessChoice; write: AccessChoice };
}

/** The general choices: "Look only" and "Change things too". */
export const accessChoices = (lead: string): { read: AccessChoice; write: AccessChoice } => ({
  read: { label: "Look only", description: "Only the tools the app marks read-only: search, read, list." },
  write: {
    label: "Change things too",
    description: `Every tool, e.g. creating or updating records. ${lead} changes things only when asked; agents in Slack conversations still only look.`,
  },
});

/** What an app's tools may do: only the ones the app marks read-only, or every tool. */
export function AccessField({ value, onChange, appName, lead, isDisabled, choices = accessChoices(lead) }: AccessFieldProps) {
  return (
    <VStack gap={2}>
      <Text weight="semibold">What {lead} may do in {appName}</Text>
      <RadioList label={`What ${lead} may do in ${appName}`} isLabelHidden value={value} onChange={(v) => onChange(v === "write" ? "write" : "read")} isDisabled={isDisabled}>
        <RadioListItem value="read" label={choices.read.label} description={choices.read.description} align="first-line" />
        <RadioListItem value="write" label={choices.write.label} description={choices.write.description} align="first-line" />
      </RadioList>
    </VStack>
  );
}
