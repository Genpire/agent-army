import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Slider } from "@astryxdesign/core/Slider";
import { StackItem } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { MicrophoneIcon, PauseIcon, PlayIcon } from "@heroicons/react/24/outline";
import { useEffect, useRef, useState } from "react";
import { clockText } from "./files";

export interface VoicePlayerProps {
  /** The recording: a local preview or GET /api/conversations/:id/attachments/:fileId. */
  src: string;
  /** Its length as recorded: browser recordings often carry none of their own. */
  durationMs?: number;
  /** What it is, for screen readers ("Voice message 2026-11-20 10-30.webm"). */
  label: string;
}

/**
 * A voice message: play/pause, a position slider and the time. The audio
 * element is created in script (not rendered), loads only its metadata until
 * played, and stops when the player leaves the page.
 */
export function VoicePlayer({ src, durationMs, label }: VoicePlayerProps) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [length, setLength] = useState(durationMs ? durationMs / 1000 : 0);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const a = new Audio();
    a.preload = "metadata";
    const onTime = () => setPosition(a.currentTime);
    const onLength = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) setLength(a.duration);
    };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      setPosition(0);
    };
    const onError = () => setFailed(true);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onLength);
    a.addEventListener("durationchange", onLength);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    a.addEventListener("ended", onEnded);
    a.addEventListener("error", onError);
    a.src = src;
    audio.current = a;
    setFailed(false);
    return () => {
      a.pause();
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onLength);
      a.removeEventListener("durationchange", onLength);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("error", onError);
      a.removeAttribute("src");
      a.load();
      audio.current = null;
    };
  }, [src]);

  const toggle = () => {
    const a = audio.current;
    if (!a) return;
    if (a.paused) void a.play().catch(() => setFailed(true));
    else a.pause();
  };

  const total = Math.max(length, position);
  return (
    <HStack gap={2} vAlign="center" width="100%">
      <IconButton
        label={playing ? `Pause ${label}` : `Play ${label}`}
        tooltip={failed ? "This browser cannot play this recording" : playing ? "Pause" : "Play"}
        icon={<Icon icon={playing ? PauseIcon : PlayIcon} size="sm" />}
        size="sm"
        variant="secondary"
        isDisabled={failed}
        onClick={toggle}
      />
      <StackItem size="fill">
        <Slider
          label={`Position in ${label}`}
          isLabelHidden
          min={0}
          max={total > 0 ? total : 1}
          step={0.1}
          value={Math.min(position, total || 1)}
          valueDisplay="none"
          isDisabled={failed || total === 0}
          onChange={(v: number) => {
            const a = audio.current;
            if (a && Number.isFinite(v)) a.currentTime = v;
            setPosition(v);
          }}
        />
      </StackItem>
      <HStack gap={1} vAlign="center">
        <Icon icon={MicrophoneIcon} size="sm" color="secondary" />
        <Text type="supporting" hasTabularNumbers>
          {failed ? "Cannot play here" : `${clockText(position * 1000)} / ${total ? clockText(total * 1000) : "–:––"}`}
        </Text>
      </HStack>
    </HStack>
  );
}
