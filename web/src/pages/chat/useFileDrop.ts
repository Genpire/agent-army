import { type DragEvent, useRef, useState } from "react";

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");

/**
 * Drag and drop of files anywhere on a region (the conversation): spread
 * `handlers` on its stack. `isDragging` is true while files are held over it.
 * A drop the composer's input already took (it prevents the default) is not
 * added twice.
 */
export function useFileDrop(onFiles: (files: File[]) => void, isDisabled = false) {
  const [isDragging, setDragging] = useState(false);
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (e: DragEvent<HTMLElement>) => {
      if (isDisabled || !hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (isDisabled || !hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      depth.current = 0;
      setDragging(false);
      if (isDisabled || e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files);
      if (files.length) onFiles(files);
    },
  };
  return { isDragging, handlers };
}
