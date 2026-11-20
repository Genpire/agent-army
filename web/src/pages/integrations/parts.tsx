/**
 * Building blocks shared by the integration panes: the pane header, a titled
 * section, a status line, numbered steps, an inline form error and the save
 * hook every form uses. The hub shows each pane in a drawer (PaneInDrawer),
 * whose own header carries the title, logo and status.
 */
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Divider } from "@astryxdesign/core/Divider";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { List, ListItem } from "@astryxdesign/core/List";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { StackItem } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { type ComponentType, type ReactNode, type SVGProps, createContext, useCallback, useContext, useState } from "react";
import { errorMessage } from "../../lib/api";
import { useConfig } from "../../lib/state";
import { useAction } from "../../lib/useAction";
import type { StatusTone } from "./catalog";

export type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

/** What a dot's color means, for screen readers (the words beside it say the rest). */
export const TONE_LABEL: Record<StatusTone, string> = { success: "Ready", warning: "Needs setup", neutral: "Optional" };

/** A dot and its words, e.g. "Connected as octocat". The words carry the status; the dot only repeats it. */
export function StatusLine({ tone, text }: { tone: StatusTone; text: string }) {
  return (
    <HStack gap={2} vAlign="center">
      <StatusDot variant={tone} label={TONE_LABEL[tone]} />
      <Text color="secondary">{text}</Text>
    </HStack>
  );
}

export interface PaneHeaderProps {
  icon: HeroIcon;
  title: string;
  tone: StatusTone;
  status: string;
  /** What the integration enables, in a sentence. */
  description: string;
  /** On narrow screens: back to the list. */
  onBack?: () => void;
}

/** True inside the hub's drawer: its header already names the integration and its status, so a pane opens on what it enables. */
export const PaneInDrawer = createContext(false);

export function PaneHeader({ icon, title, tone, status, description, onBack }: PaneHeaderProps) {
  const inDrawer = useContext(PaneInDrawer);
  if (inDrawer) return <Text>{description}</Text>;
  return (
    <VStack gap={3}>
      {onBack && (
        <HStack>
          <Button label="All integrations" variant="ghost" size="sm" icon={<Icon icon={ArrowLeftIcon} size="sm" />} onClick={onBack} />
        </HStack>
      )}
      <HStack gap={3} vAlign="start">
        <NavIcon icon={<Icon icon={icon} size="sm" />} />
        <StackItem size="fill">
          <VStack gap={1}>
            <Heading level={2}>{title}</Heading>
            <StatusLine tone={tone} text={status} />
          </VStack>
        </StackItem>
      </HStack>
      <Text>{description}</Text>
    </VStack>
  );
}

export interface PaneSectionProps {
  title: string;
  /** One or two sentences under the title. */
  description?: ReactNode;
  /** Beside the title, e.g. a status line. */
  endContent?: ReactNode;
  children?: ReactNode;
}

/** One titled part of a pane, fenced from the one above by a divider. */
export function PaneSection({ title, description, endContent, children }: PaneSectionProps) {
  return (
    <VStack gap={4}>
      <Divider />
      <VStack gap={1}>
        <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
          <Heading level={3}>{title}</Heading>
          {endContent}
        </HStack>
        {description && <Text color="secondary">{description}</Text>}
      </VStack>
      {children}
    </VStack>
  );
}

/** Numbered instructions. Each step is a short sentence; bold the names of buttons and pages with <Strong>. */
export function Steps({ label, steps }: { label: string; steps: ReactNode[] }) {
  return (
    <List listStyle="decimal" density="compact" header={<Text type="label">{label}</Text>}>
      {steps.map((step, i) => (
        <ListItem key={i} label={<Text>{step}</Text>} align="first-line" />
      ))}
    </List>
  );
}

/** The name of a button, page or field in another product, as it reads there. */
export function Strong({ children }: { children: ReactNode }) {
  return <Text weight="semibold">{children}</Text>;
}

/** Buttons under a form: the primary action first. Wraps on narrow screens. */
export function FormActions({ children }: { children: ReactNode }) {
  return (
    <HStack gap={2} vAlign="center" wrap="wrap">
      {children}
    </HStack>
  );
}

/** Why the last save of a form failed, kept beside the form until the input changes or the next attempt. */
export function FormError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return <Banner status="error" title={message} collapsible={false} />;
}

/**
 * Saves a form: checks the input first (shown under the form, nothing sent),
 * then calls the server with a toast for the outcome (the server's message on
 * failure) and re-reads the configuration on success.
 */
export function useSave() {
  const { run, pending } = useAction();
  const showToast = useToast();
  const { refresh } = useConfig();
  const [error, setError] = useState<string>();

  const save = useCallback(
    async <R,>(action: () => Promise<R>, opts: { success: string | ((result: R) => string); invalid?: string }): Promise<boolean> => {
      if (opts.invalid) {
        setError(opts.invalid);
        return false;
      }
      setError(undefined);
      let result: R | undefined;
      let failure: string | undefined;
      const ok = await run(async () => {
        try {
          result = await action();
        } catch (err) {
          failure = errorMessage(err);
          throw err;
        }
      });
      if (!ok) {
        setError(failure);
        return false;
      }
      // useAction shows the error toast; the success toast can name what the server verified (a login, a workspace), so it is shown here.
      const message = typeof opts.success === "function" ? opts.success(result as R) : opts.success;
      showToast({ body: message, type: "info", uniqueID: message });
      await refresh();
      return true;
    },
    [run, refresh, showToast],
  );

  /** Wraps a field's setter so editing the field clears the last error (it is about the old input). */
  const edit = useCallback(
    <T,>(set: (value: T) => void) =>
      (value: T) => {
        set(value);
        setError(undefined);
      },
    [],
  );

  return { save, pending, error, edit };
}
