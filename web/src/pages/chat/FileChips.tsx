import { FieldStatus } from "@astryxdesign/core/FieldStatus";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowUpTrayIcon, DocumentIcon, MicrophoneIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { clockText, sizeText } from "./files";
import type { PendingFile } from "./useComposerFiles";
import { VoicePlayer } from "./VoicePlayer";

const percent = (f: PendingFile) => `${Math.round(f.progress * 100)}%`;

/** Upload progress, the transcription, or the size: what a chip says after its name. */
function ChipStatus({ file }: { file: PendingFile }) {
  if (file.status === "uploading") {
    return (
      <HStack gap={1} vAlign="center">
        <Spinner size="sm" aria-label={`Uploading ${file.name}`} />
        <Text type="supporting" hasTabularNumbers>
          {percent(file)}
        </Text>
      </HStack>
    );
  }
  if (file.status === "transcribing") {
    return (
      <HStack gap={1} vAlign="center">
        <Spinner size="sm" aria-label={`Transcribing ${file.name}`} />
        <Text type="supporting">Transcribing…</Text>
      </HStack>
    );
  }
  if (file.status === "error") return <Text type="supporting">Not attached</Text>;
  return (
    <Text type="supporting" hasTabularNumbers>
      {sizeText(file.size)}
    </Text>
  );
}

export interface FileChipsProps {
  files: PendingFile[];
  onRemove: (key: string) => void;
  /** Files are being dragged over the conversation. */
  isDragging: boolean;
}

/**
 * The composer drawer: images as thumbnails, other files as chips (name,
 * progress or size, remove), voice messages with a player, and what was
 * refused with the reason.
 */
export function FileChips({ files, onRemove, isDragging }: FileChipsProps) {
  const images = files.filter((f) => f.status !== "error" && !f.voice && f.previewUrl && f.mime.startsWith("image/"));
  const voices = files.filter((f) => f.status !== "error" && f.voice);
  const others = files.filter((f) => !images.includes(f) && !voices.includes(f));
  const refused = files.filter((f) => f.status === "error" && f.error);
  return (
    <VStack gap={2} padding={2}>
      {isDragging && (
        <HStack gap={2} vAlign="center">
          <Icon icon={ArrowUpTrayIcon} size="sm" color="accent" />
          <Text type="label" color="accent">
            Drop files to attach them
          </Text>
        </HStack>
      )}
      {(images.length > 0 || others.length > 0) && (
        <HStack gap={2} wrap="wrap" vAlign="center">
          {images.map((f) => (
            <Thumbnail
              key={f.key}
              src={f.previewUrl}
              alt={f.name}
              label={f.status === "uploading" ? `${f.name} (uploading ${percent(f)})` : `${f.name} · ${sizeText(f.size)}`}
              isLoading={f.status === "uploading"}
              onRemove={() => onRemove(f.key)}
            />
          ))}
          {others.map((f) => (
            <Token
              key={f.key}
              label={f.name}
              color={f.status === "error" ? "red" : "default"}
              icon={<Icon icon={f.voice ? MicrophoneIcon : DocumentIcon} size="sm" />}
              endContent={<ChipStatus file={f} />}
              description={f.error}
              onRemove={() => onRemove(f.key)}
            />
          ))}
        </HStack>
      )}
      {voices.map((f) => (
        <HStack key={f.key} gap={2} vAlign="center">
          <StackItem size="fill">
            {f.previewUrl ? (
              <VoicePlayer src={f.previewUrl} durationMs={f.voice?.durationMs} label={f.name} />
            ) : (
              <Text type="supporting">Voice message · {clockText(f.voice?.durationMs ?? 0)}</Text>
            )}
          </StackItem>
          {f.status !== "ready" && <ChipStatus file={f} />}
          <IconButton label={`Remove ${f.name}`} tooltip="Remove the voice message" icon={<Icon icon={XMarkIcon} size="sm" />} size="sm" variant="ghost" onClick={() => onRemove(f.key)} />
        </HStack>
      ))}
      {refused.map((f) => (
        <FieldStatus key={`why-${f.key}`} type="error" variant="detached" message={f.error!} />
      ))}
    </VStack>
  );
}
