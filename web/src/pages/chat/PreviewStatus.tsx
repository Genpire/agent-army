import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { CheckCircleIcon, ExclamationTriangleIcon, MinusCircleIcon, QuestionMarkCircleIcon } from "@heroicons/react/24/outline";
import type { Task } from "../../lib/types";
import { previewStatus } from "./labels";

export interface PreviewStatusProps {
  task: Pick<Task, "preview">;
  /** Also show a check that was not needed (the task's details do; the card does not). */
  showSkipped?: boolean;
  /** Lines of the note shown before it is cut (0 = all of it). */
  noteLines?: number;
}

const STATE_ICON = {
  checked: { icon: CheckCircleIcon, color: "success" },
  problems: { icon: ExclamationTriangleIcon, color: "warning" },
  unavailable: { icon: QuestionMarkCircleIcon, color: "secondary" },
  skipped: { icon: MinusCircleIcon, color: "tertiary" },
} as const;

/** What opening the pull request's preview deployment showed: the verdict, a link to the preview and the note. */
export function PreviewStatus({ task, showSkipped = false, noteLines = 2 }: PreviewStatusProps) {
  const status = previewStatus(task);
  if (!status || !task.preview || (task.preview.state === "skipped" && !showSkipped)) return null;
  const mark = STATE_ICON[task.preview.state];
  return (
    <VStack gap={1}>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Icon icon={mark.icon} size="sm" color={mark.color} />
        <Text type="supporting" weight="semibold" color="primary">
          {status.label}
        </Text>
        {status.url && (
          <Link href={status.url} isExternalLink>
            Open the preview
          </Link>
        )}
      </HStack>
      {status.note && (
        <Text type="supporting" maxLines={noteLines}>
          {status.note}
        </Text>
      )}
    </VStack>
  );
}
