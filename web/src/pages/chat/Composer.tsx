import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  type ChatComposerInputHandle,
  ChatDictationButton,
  ChatSendButton,
  useChatDictation,
} from "@astryxdesign/core/Chat";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Timer } from "@astryxdesign/core/Timer";
import { MicrophoneIcon, PaperClipIcon, StopIcon, TrashIcon } from "@heroicons/react/24/outline";
import { useRef, useState } from "react";
import { FileChips } from "./FileChips";
import { type ChatOptions, PROVIDER_NAME, clockText, dictationLang } from "./files";
import type { ComposerFiles } from "./useComposerFiles";
import { useVoiceRecorder } from "./useVoiceRecorder";

export const MESSAGE_MAX = 8000;

/** Opens the browser's file picker (no element rendered) and hands over what was chosen. */
function pickFiles(onFiles: (files: File[]) => void) {
  const input = document.createElement("input");
  input.type = "file";
  input.multiple = true;
  input.addEventListener("change", () => {
    if (input.files?.length) onFiles(Array.from(input.files));
  });
  input.click();
}

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  /** Sends the message with the uploaded files; resolves to an error message, or null when sent. */
  onSend: (text: string, attachmentIds: string[], draftId: string | undefined) => Promise<string | null>;
  files: ComposerFiles;
  options: ChatOptions;
  /** Files are being dragged over the conversation. */
  isDragging: boolean;
  isDisabled: boolean;
  isAnswering: boolean;
}

/**
 * Enter sends, Shift+Enter adds a line. Files come from the attach button,
 * a paste, or a drop anywhere on the conversation; the microphone records a
 * voice message whose transcript lands in the text for review before
 * sending. Without a transcription service, the browser's live dictation is
 * offered where it exists. Disabled while Pointer answers; a failed send
 * puts the text back.
 */
export function Composer({ value, onChange, onSend, files, options, isDragging, isDisabled, isAnswering }: ComposerProps) {
  const [error, setError] = useState<string>();
  const inputRef = useRef<ChatComposerInputHandle>(null);
  const maxMs = options.limits.maxRecordingMs;
  const recorder = useVoiceRecorder({ maxMs, onRecorded: files.addVoice, onError: setError });
  const dictation = useChatDictation({
    inputRef,
    lang: dictationLang(),
    onError: (e) => {
      // Silence and a manual stop end dictation normally.
      if (e.error === "no-speech" || e.error === "aborted") return;
      setError(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access was denied, so dictation cannot start."
          : e.error === "network"
            ? "Dictation needs the browser's speech service, which could not be reached."
            : `Dictation stopped (${e.error}).`,
      );
    },
  });
  const recording = recorder.status === "recording";

  const tooLong = value.length > MESSAGE_MAX;
  const status = tooLong
    ? { type: "error" as const, message: `Messages are limited to ${MESSAGE_MAX} characters (${value.length} now).` }
    : error
      ? { type: "error" as const, message: error }
      : files.notice
        ? { type: "warning" as const, message: files.notice }
        : undefined;

  const canSend = !isDisabled && !tooLong && !files.busy && !recording && (value.trim().length > 0 || files.readyIds.length > 0);

  // The composer clears its text right after a submit: text kept back is put back after that.
  const keep = (raw: string) => queueMicrotask(() => onChange(raw));

  const submit = (raw: string) => {
    const text = raw.trim();
    if (isDisabled) return;
    if (text.length > MESSAGE_MAX) return keep(raw);
    if (files.busy || recording) {
      setError(recording ? "Stop the recording first." : "Wait until the files finish uploading.");
      keep(raw);
      return;
    }
    if (!text && files.readyIds.length === 0) return;
    setError(undefined);
    void onSend(text, files.readyIds, files.draftId).then((failure) => {
      if (failure) {
        setError(failure);
        onChange(raw);
      } else {
        files.clear();
        onChange("");
      }
    });
  };

  const addFiles = (picked: File[]) => {
    setError(undefined);
    files.add(picked);
  };

  const headerActions = recording ? (
    <HStack gap={2} vAlign="center">
      <StatusDot variant="error" label="Recording" isPulsing />
      <Text type="supporting" hasTabularNumbers>
        Recording <Timer startTime={recorder.startedAt ?? undefined} format="clock" type="inherit" color="inherit" /> / {clockText(maxMs)}
      </Text>
      <IconButton label="Stop and attach the voice message" tooltip="Stop and attach" icon={<Icon icon={StopIcon} size="sm" />} size="sm" variant="primary" onClick={recorder.stop} />
      <IconButton label="Discard the recording" tooltip="Discard" icon={<Icon icon={TrashIcon} size="sm" />} size="sm" variant="ghost" onClick={recorder.discard} />
    </HStack>
  ) : (
    <HStack gap={1} vAlign="center">
      <IconButton
        label="Attach files"
        tooltip={`Attach files or images (up to ${options.limits.maxFilesPerMessage}, ${Math.round(options.limits.maxFileBytes / 1024 / 1024)} MB each). You can also paste or drop them.`}
        icon={<Icon icon={PaperClipIcon} size="sm" />}
        size="sm"
        variant="ghost"
        isDisabled={isDisabled}
        onClick={() => pickFiles(addFiles)}
      />
      <IconButton
        label="Record a voice message"
        tooltip={
          recorder.unsupported ??
          `Record a voice message (up to ${clockText(maxMs)}). ${options.transcription ? `${PROVIDER_NAME[options.transcription]} transcribes it into the message for you to check.` : "No transcription service is connected, so it is sent as audio only."}`
        }
        icon={<Icon icon={MicrophoneIcon} size="sm" />}
        size="sm"
        variant="ghost"
        isLoading={recorder.status === "starting"}
        isDisabled={isDisabled || Boolean(recorder.unsupported) || dictation.isListening}
        onClick={() => {
          setError(undefined);
          void recorder.start();
        }}
      />
    </HStack>
  );

  const busyLabel = files.files.some((f) => f.status === "transcribing") ? "Transcribing the voice message" : "Uploading files";
  return (
    <ChatComposer
      value={value}
      onChange={(v) => {
        onChange(v);
        setError(undefined);
      }}
      onSubmit={submit}
      isDisabled={isDisabled}
      placeholder={isAnswering ? "Pointer is answering…" : "Message Pointer. Enter sends, Shift+Enter adds a line."}
      input={
        <ChatComposerInput
          handleRef={inputRef}
          label="Message to Pointer"
          maxRows={10}
          pasteAsToken={false}
          hasHistory={false}
          onFiles={isDisabled ? undefined : addFiles}
          onKeyDown={(e) => {
            // Enter with files and no text sends them (the input only submits text on its own).
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !value.trim() && files.readyIds.length > 0) {
              e.preventDefault();
              submit("");
            }
          }}
        />
      }
      drawer={
        files.files.length > 0 || isDragging ? (
          <ChatComposerDrawer label="Attachments">
            <FileChips files={files.files} onRemove={files.remove} isDragging={isDragging} />
          </ChatComposerDrawer>
        ) : undefined
      }
      headerActions={headerActions}
      headerContext={
        isAnswering ? <Spinner size="sm" label="Pointer is answering" /> : files.busy ? <Spinner size="sm" label={`${busyLabel}…`} /> : undefined
      }
      sendActions={
        // The browser's own dictation, where it exists, when no service transcribes recordings.
        !options.transcription && dictation.isSupported && !recording ? (
          <ChatDictationButton dictation={dictation} label={dictation.isListening ? "Stop dictation" : "Dictate (the browser's speech recognition; no audio is kept)"} />
        ) : undefined
      }
      sendButton={<ChatSendButton isDisabled={!canSend} onSend={() => submit(value)} />}
      status={status}
    />
  );
}
