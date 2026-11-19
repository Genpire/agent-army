/**
 * Brand logos from Simple Icons (CC0; the names and logos are trademarks of
 * their owners), by catalog id (src/apps-catalog.ts) or native integration
 * id. Only the icons named here are bundled, in a chunk of their own that
 * BrandLogo loads when a logo is first shown.
 */
import {
  siAirtable,
  siAnthropic,
  siAsana,
  siAtlassian,
  siBitbucket,
  siBox,
  siBuildkite,
  siClaude,
  siClickup,
  siCloudflare,
  siConfluence,
  siDatadog,
  siDynatrace,
  siFigma,
  siGithub,
  siGitlab,
  siGrafana,
  siHubspot,
  siHuggingface,
  siIntercom,
  siJira,
  siLinear,
  siMake,
  siMercadopago,
  siMiro,
  siNeon,
  siNetlify,
  siNotion,
  siPaypal,
  siPosthog,
  siPrisma,
  siSentry,
  siStripe,
  siSupabase,
  siVercel,
  siWebflow,
  siWix,
  siZapier,
} from "simple-icons";

export interface BrandIcon {
  title: string;
  /** An SVG path in a 24×24 view box. */
  path: string;
  /** The brand colour, as hex without "#". */
  hex: string;
}

export const LOGOS: Readonly<Record<string, BrandIcon>> = {
  // Apps catalog
  airtable: siAirtable,
  asana: siAsana,
  atlassian: siAtlassian,
  box: siBox,
  buildkite: siBuildkite,
  clickup: siClickup,
  cloudflare: siCloudflare,
  datadog: siDatadog,
  dynatrace: siDynatrace,
  figma: siFigma,
  grafana: siGrafana,
  hubspot: siHubspot,
  huggingface: siHuggingface,
  intercom: siIntercom,
  linear: siLinear,
  make: siMake,
  mercadopago: siMercadopago,
  neon: siNeon,
  netlify: siNetlify,
  notion: siNotion,
  paypal: siPaypal,
  posthog: siPosthog,
  prisma: siPrisma,
  sentry: siSentry,
  stripe: siStripe,
  supabase: siSupabase,
  vercel: siVercel,
  webflow: siWebflow,
  wix: siWix,
  zapier: siZapier,
  // Native integrations (Simple Icons has no Slack or monday.com logo)
  claude: siClaude,
  anthropic: siAnthropic,
  github: siGithub,
  gitlab: siGitlab,
  bitbucket: siBitbucket,
  jira: siJira,
  confluence: siConfluence,
  miro: siMiro,
};

export const logoFor = (id: string): BrandIcon | undefined => (Object.hasOwn(LOGOS, id) ? LOGOS[id] : undefined);

/** WCAG relative luminance of a "RRGGBB" colour. */
function luminance(hex: string): number {
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

/** The logo tile's surface in the light and dark themes (the muted background over a card). */
const SURFACE = { light: "F2F4F6", dark: "1A1A1C" };
/**
 * Below this the logo fades into its tile (Hugging Face's yellow on light,
 * Vercel's black on dark). Logos are exempt from WCAG's contrast minimums,
 * and 3:1 would grey out most bright brands, so the bar is visibility.
 */
const MIN_CONTRAST = 1.6;

/** Whether the brand colour stands out enough on the tile in each theme; where it does not, the theme's text colour is used. */
export function brandColorFits(hex: string): { light: boolean; dark: boolean } {
  const ok = /^[0-9a-fA-F]{6}$/.test(hex);
  return { light: ok && contrast(hex, SURFACE.light) >= MIN_CONTRAST, dark: ok && contrast(hex, SURFACE.dark) >= MIN_CONTRAST };
}
