import { Icon } from "@astryxdesign/core/Icon";
import { NavIcon } from "@astryxdesign/core/NavIcon";
import { CloudIcon, CpuChipIcon, ServerStackIcon, SparklesIcon } from "@heroicons/react/24/outline";
import type { ComponentType, SVGProps } from "react";
import { BrandLogo } from "./BrandLogo";

/** Logo keys Simple Icons has a mark for (lib/logos.ts); the others get an icon. */
const BRAND_LOGOS = new Set(["anthropic", "googlecloud", "gemini", "deepseek", "qwen", "kimi"]);
const FALLBACK_ICONS: Record<string, ComponentType<SVGProps<SVGSVGElement>>> = { bedrock: CloudIcon, foundry: CloudIcon, zai: SparklesIcon, custom: ServerStackIcon };

/** An AI provider's logo (its preset's logo key), or an icon for the ones Simple Icons does not carry and for keys it does not know. */
export function ProviderLogo({ provider }: { provider: { logo: string; name: string } }) {
  if (BRAND_LOGOS.has(provider.logo)) return <BrandLogo id={provider.logo} name={provider.name} size="sm" />;
  return <NavIcon icon={<Icon icon={FALLBACK_ICONS[provider.logo] ?? CpuChipIcon} size="sm" label={provider.name} />} />;
}
