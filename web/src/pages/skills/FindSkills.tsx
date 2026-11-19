import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack } from "@astryxdesign/core/HStack";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { CommandLineIcon, DocumentMagnifyingGlassIcon, MagnifyingGlassIcon } from "@heroicons/react/24/outline";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../lib/api";
import { usd } from "../../lib/format";
import { navigate } from "../../lib/router";
import type { AgentSpec } from "../../lib/types";
import { SectionHeader } from "../projects/components/SectionHeader";
import type { AddSkillStart } from "./AddSkillDrawer";
import { type FindResult, type SkillCandidate, assignedLabel } from "./skills";

export interface FindSkillsProps {
  /** From the route (#/skills/find/<need>): filled in and searched, e.g. from HR's recommendations. */
  routeNeed: string | undefined;
  agents: Pick<AgentSpec, "id" | "name">[];
  /** The Scout's name on the team, when it is there. */
  scoutName: string;
  /** Opens the add drawer on a candidate's folder, previewed straight away. */
  onPreview: (start: AddSkillStart) => void;
}

const NEED_MAX = 1000;

/** The Skills Scout: describe a need, get a few skills to preview. It searches the web; installing is always the owner's click. */
export function FindSkills({ routeNeed, agents, scoutName, onPreview }: FindSkillsProps) {
  const [need, setNeed] = useState(routeNeed ?? "");
  const [searching, setSearching] = useState(false);
  const [result, setResult] = useState<FindResult & { need: string }>();
  const [error, setError] = useState<string>();
  const searched = useRef<string | undefined>(undefined);

  const search = useCallback(async (text: string) => {
    searched.current = text;
    setSearching(true);
    setError(undefined);
    setResult(undefined);
    try {
      const found = await api.post<FindResult>("/api/skills/find", { need: text });
      if (searched.current === text) setResult({ ...found, need: text });
    } catch (err) {
      if (searched.current === text) setError(errorMessage(err));
    } finally {
      if (searched.current === text) setSearching(false);
    }
  }, []);

  // A need in the route is searched once (opening #/skills/find/<need> again searches again).
  useEffect(() => {
    const text = routeNeed?.trim();
    if (!text || text === searched.current) return;
    setNeed(text);
    void search(text);
  }, [routeNeed, search]);

  const submit = () => {
    const text = need.trim();
    if (!text) return;
    // The route carries the need, so the search can be shared and reloaded.
    if (text === routeNeed?.trim()) void search(text);
    else navigate("skills", "find", text);
  };

  return (
    <VStack gap={6}>
      <SectionHeader
        title="Find skills"
        description={`${scoutName} searches public skill collections, Anthropic's first, and suggests a few that fit. It only suggests: you preview a skill and install it yourself. A search costs at most $0.50 and counts with chat against the monthly cap.`}
      />
      <Card>
        <VStack gap={3}>
          <TextArea
            label="What should the team get better at?"
            value={need}
            onChange={setNeed}
            rows={3}
            maxLength={NEED_MAX}
            placeholder="For example: fill in and merge PDF forms; write release notes from merged pull requests; test web apps in a browser."
            isDisabled={searching}
          />
          <HStack gap={2} vAlign="center" wrap="wrap">
            <Button
              label={searching ? "Searching…" : "Find skills"}
              variant="primary"
              icon={<Icon icon={MagnifyingGlassIcon} />}
              isLoading={searching}
              isDisabled={!need.trim()}
              clickAction={submit}
            />
            {result?.costUsd !== undefined && !searching && <Text type="supporting">Last search cost {usd(result.costUsd)}.</Text>}
          </HStack>
        </VStack>
      </Card>

      {searching && <Spinner size="lg" label={`${scoutName} is searching the web. This usually takes one to three minutes.`} />}
      {error && !searching && (
        <Banner
          status="error"
          title="The search didn't finish"
          description={error}
          collapsible={false}
          endContent={searched.current ? <Button label="Try again" size="sm" clickAction={() => search(searched.current!)} /> : undefined}
        />
      )}
      {result && !searching && (
        <VStack gap={2}>
          <Text type="label">{`Suggestions for “${result.need}”`}</Text>
          <Card padding={0}>
            {result.candidates.length === 0 ? (
              <EmptyState
                title="No skill fits yet"
                description="Nothing the Scout found fits this need. Describe it differently, or write the skill yourself and paste it under Add a skill."
                icon={<Icon icon={DocumentMagnifyingGlassIcon} size="lg" />}
              />
            ) : (
              <List hasDividers>
                {result.candidates.map((c) => (
                  <CandidateItem key={c.url} candidate={c} agents={agents} onPreview={onPreview} />
                ))}
              </List>
            )}
          </Card>
        </VStack>
      )}
    </VStack>
  );
}

function CandidateItem({ candidate: c, agents, onPreview }: { candidate: SkillCandidate; agents: Pick<AgentSpec, "id" | "name">[]; onPreview: (start: AddSkillStart) => void }) {
  return (
    <ListItem
      align="start"
      label={<Text weight="semibold">{c.name}</Text>}
      description={
        <VStack gap={2}>
          {c.description && <Text>{c.description}</Text>}
          <Text color="secondary">{c.why}</Text>
          <HStack gap={2} vAlign="center" wrap="wrap">
            {c.runsScripts !== undefined &&
              (c.runsScripts ? (
                <Token label="Runs scripts" color="orange" size="sm" icon={<Icon icon={CommandLineIcon} size="xsm" />} />
              ) : (
                <Token label="Instructions" color="gray" size="sm" />
              ))}
            <Token label={c.license ? `Licence: ${c.license}` : "Licence not stated"} color={c.license ? "default" : "yellow"} size="sm" />
            {c.forAgents?.length ? <Text type="supporting">For {assignedLabel(c.forAgents, agents)}</Text> : null}
          </HStack>
          <Link href={c.url} isExternalLink>
            {c.url.replace(/^https:\/\/github\.com\//, "")}
          </Link>
        </VStack>
      }
      endContent={<Button label="Preview" size="sm" onClick={() => onPreview({ url: c.url, ...(c.forAgents?.length ? { forAgents: c.forAgents } : {}) })} />}
    />
  );
}
