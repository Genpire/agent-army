import { HStack } from "@astryxdesign/core/HStack";
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { useState } from "react";
import { useScreenshots } from "./hooks";

export interface ScreenshotStripProps {
  taskId: string;
  /** How many screenshots the task record says it has; the list is re-read when this changes. */
  count: number | undefined;
}

/** A task's browser-check screenshots as thumbnails; one opens the gallery at full size. */
export function ScreenshotStrip({ taskId, count }: ScreenshotStripProps) {
  const shots = useScreenshots(taskId, count);
  const [open, setOpen] = useState<number | null>(null);
  if (!shots.length) return null;
  return (
    <>
      <HStack gap={2} wrap="wrap">
        {shots.map((s, i) => (
          <Thumbnail key={s.name} src={s.src} alt={`Screenshot ${s.name}`} label={s.name} onClick={() => setOpen(i)} />
        ))}
      </HStack>
      <Lightbox
        isOpen={open !== null}
        onOpenChange={(isOpen) => {
          if (!isOpen) setOpen(null);
        }}
        media={shots.map((s) => ({ src: s.src, alt: `Screenshot ${s.name}`, caption: s.name }))}
        index={open ?? 0}
        onIndexChange={setOpen}
        hasZoom
      />
    </>
  );
}
