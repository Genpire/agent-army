import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Text } from "@astryxdesign/core/Text";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { DocumentIcon } from "@heroicons/react/24/outline";
import { useState } from "react";
import { type MessageFile, fileUrl, isAudio, isImage, sizeText } from "./files";
import { VoicePlayer } from "./VoicePlayer";

export interface MessageFilesProps {
  conversationId: string;
  files: MessageFile[];
  /** The sender's side: "end" for the owner's messages. */
  align?: "start" | "end";
}

/**
 * The files a message carried: images as thumbnails that open full size,
 * voice messages as players, other files as chips that download them (the
 * server serves only this conversation's files, as attachments).
 */
export function MessageFiles({ conversationId, files, align = "start" }: MessageFilesProps) {
  const [open, setOpen] = useState<number | null>(null);
  const images = files.filter(isImage);
  const voices = files.filter((f) => !isImage(f) && isAudio(f));
  const others = files.filter((f) => !isImage(f) && !isAudio(f));
  return (
    <VStack gap={2} width="100%" hAlign={align}>
      {images.length > 0 && (
        <HStack gap={2} wrap="wrap" hAlign={align}>
          {images.map((f, i) => (
            <Thumbnail key={f.id} src={fileUrl(conversationId, f.id)} alt={f.name} label={f.name} onClick={() => setOpen(i)} />
          ))}
        </HStack>
      )}
      {voices.map((f) => (
        <VoicePlayer key={f.id} src={fileUrl(conversationId, f.id)} durationMs={f.durationMs} label={f.name} />
      ))}
      {others.length > 0 && (
        <HStack gap={2} wrap="wrap" hAlign={align}>
          {others.map((f) => (
            <Token
              key={f.id}
              label={f.name}
              icon={<Icon icon={DocumentIcon} size="sm" />}
              href={fileUrl(conversationId, f.id)}
              description={`Download ${f.name}`}
              endContent={
                <Text type="supporting" hasTabularNumbers>
                  {sizeText(f.size)}
                </Text>
              }
            />
          ))}
        </HStack>
      )}
      {images.length > 0 && (
        <Lightbox
          isOpen={open !== null}
          onOpenChange={(isOpen) => {
            if (!isOpen) setOpen(null);
          }}
          media={images.map((f) => ({ src: fileUrl(conversationId, f.id), alt: f.name, caption: f.name }))}
          index={open ?? 0}
          onIndexChange={setOpen}
          hasZoom
        />
      )}
    </VStack>
  );
}
