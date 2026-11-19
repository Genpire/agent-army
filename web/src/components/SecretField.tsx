import { TextInput } from "@astryxdesign/core/TextInput";

export interface SecretFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** The stored secret's mask from the server ("••••1234"), or null when none is saved. */
  saved?: string | null;
  /** What it is and where to find it. */
  description?: string;
  placeholder?: string;
  isRequired?: boolean;
}

/**
 * A credential input. The server never sends secrets back, so a saved one is
 * shown only by its last characters; typing a new value replaces it on save.
 */
export function SecretField({ label, value, onChange, saved, description, placeholder, isRequired }: SecretFieldProps) {
  const savedNote = saved ? `Saved (${saved}). Paste a new one to replace it.` : undefined;
  return (
    <TextInput
      type="password"
      label={label}
      value={value}
      onChange={(v) => onChange(v)}
      description={[description, savedNote].filter(Boolean).join(" ") || undefined}
      placeholder={placeholder ?? (saved ? "Leave empty to keep the saved one" : undefined)}
      isRequired={isRequired && !saved}
    />
  );
}
