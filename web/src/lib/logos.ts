/**
 * Brand logos from Simple Icons (CC0; the names and logos are trademarks of
 * their owners), by catalog id (src/integrations/apps/apps-catalog.ts) or native integration
 * id, plus hand-drawn marks for Slack and monday.com and OpenAI's mark (for
 * Codex), which Simple Icons does not carry. Only the icons named here are
 * bundled, in a chunk of their own that BrandLogo loads when a logo is first
 * shown.
 */
import {
  siAirtable,
  siAlgolia,
  siAnthropic,
  siAsana,
  siAtlassian,
  siBasecamp,
  siBetterstack,
  siBitbucket,
  siBox,
  siBrex,
  siBuildkite,
  siCaldotcom,
  siCalendly,
  siCircleci,
  siClaude,
  siClerk,
  siClickhouse,
  siClickup,
  siCloudflare,
  siCloudinary,
  siCoda,
  siConfluence,
  siContentful,
  siDatadog,
  siDeepseek,
  siDigitalocean,
  siDropbox,
  siDynatrace,
  siEgnyte,
  siElevenlabs,
  siFigma,
  siFlydotio,
  siGithub,
  siGitlab,
  siGmail,
  siGooglebigquery,
  siGooglegemini,
  siGooglecalendar,
  siGooglecloud,
  siGoogledrive,
  siGrafana,
  siGusto,
  siHelpscout,
  siHubspot,
  siHuggingface,
  siIntercom,
  siJira,
  siKimi,
  siLinear,
  siLucid,
  siMake,
  siMercadopago,
  siMiro,
  siMixpanel,
  siMongodb,
  siNeon,
  siNetlify,
  siNewrelic,
  siNotion,
  siPaddle,
  siPagerduty,
  siPaypal,
  siPerplexity,
  siPlanetscale,
  siPosthog,
  siPostman,
  siPrisma,
  siPulumi,
  siPydantic,
  siQwen,
  siRailway,
  siRender,
  siReplicate,
  siRevenuecat,
  siSanity,
  siSemrush,
  siSentry,
  siShortcut,
  siSimilarweb,
  siSnowflake,
  siSocket,
  siStackoverflow,
  siStripe,
  siSupabase,
  siTodoist,
  siTrello,
  siVercel,
  siWebflow,
  siWeightsandbiases,
  siWix,
  siXero,
  siZapier,
} from "simple-icons";

export interface BrandIcon {
  title: string;
  /** An SVG path in a 24×24 view box. */
  path: string;
  /** The brand colour, as hex without "#". */
  hex: string;
  /** A logo in several colours: its shapes, each in its own colour (`path` is all of them, in `hex`). */
  parts?: readonly BrandIconPart[];
}

export interface BrandIconPart {
  /** An SVG path in the same 24×24 view box. */
  path: string;
  /** Its colour, as hex without "#". */
  hex: string;
}

/** A logo drawn in several colours. */
const multicolour = (title: string, parts: BrandIconPart[]): BrandIcon => ({
  title,
  path: parts.map((p) => p.path).join(""),
  hex: parts[0]!.hex,
  parts,
});

/** Slack: four rounded bars, each with its dot, in its four brand colours. */
const slack = multicolour("Slack", [
  {
    hex: "E01E5A",
    path: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z",
  },
  {
    hex: "36C5F0",
    path: "M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z",
  },
  {
    hex: "2EB67D",
    path: "M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z",
  },
  {
    hex: "ECB22E",
    path: "M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
  },
]);

/** monday.com: two slanted rounded bars and a dot, in red, yellow and green. */
const monday = multicolour("monday.com", [
  { hex: "FB275D", path: "M5.9 17.06L10.5 8.76A2.4 2.4 0 0 0 6.3 6.44L1.7 14.74A2.4 2.4 0 0 0 5.9 17.06Z" },
  { hex: "FFCC00", path: "M13.1 17.06L17.7 8.76A2.4 2.4 0 0 0 13.5 6.44L8.9 14.74A2.4 2.4 0 0 0 13.1 17.06Z" },
  { hex: "00CA72", path: "M17.6 15.9a2.4 2.4 0 1 0 4.8 0a2.4 2.4 0 1 0 -4.8 0Z" },
]);

/** OpenAI's mark (six interlaced links), in black, for Codex: Simple Icons no longer carries it. Shown in the text colour where black does not stand out. */
const codex: BrandIcon = {
  title: "OpenAI Codex",
  hex: "000000",
  path: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z",
};

export const LOGOS: Readonly<Record<string, BrandIcon>> = {
  // Genpire's mark, from its own logo (www.genpire.com/logos-v2), fitted to the 24×24 box.
  genpire: {
    title: "Genpire",
    path: "M6.888,8.618v6.762c0,1.131,0.918,2.047,2.047,2.047h6.185c1.031,0,1.882,-0.776,1.998,-1.775,0.008,-0.076,0.014,-0.157,0.014,-0.236s-0.006,-0.156,-0.014,-0.232v-3.504c0,-0.445,0.361,-0.806,0.806,-0.806h4.941c0.445,0,0.806,0.361,0.806,0.806v4.942c0,0.444,-0.361,0.805,-0.805,0.805h-3.695c-0.018,0,-0.034,0,-0.052,0s-0.034,0,-0.052,0c-1.018,0.025,-1.848,0.806,-1.95,1.803,-0.006,0.068,-0.01,0.137,-0.01,0.206s0.004,0.137,0.01,0.206v2.763c0,0.88,-0.714,1.594,-1.594,1.594h-8.678c-1.803,0,-3.437,-0.731,-4.618,-1.913,-1.182,-1.182,-1.915,-2.815,-1.915,-4.62v-10.935c0,-3.607,2.924,-6.533,6.533,-6.533h16.036c0.445,0,0.806,0.361,0.806,0.806v4.959c0,0.445,-0.362,0.806,-0.806,0.806h-13.949c-1.13,0,-2.047,0.916,-2.047,2.047Z",
    hex: "3D3D3D",
  },
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
  // More catalog apps (apps-catalog-more.ts)
  algolia: siAlgolia,
  basecamp: siBasecamp,
  "better-stack": siBetterstack,
  bigquery: siGooglebigquery,
  brex: siBrex,
  "cal-com": siCaldotcom,
  calendly: siCalendly,
  circleci: siCircleci,
  clerk: siClerk,
  "clickhouse-cloud": siClickhouse,
  cloudinary: siCloudinary,
  coda: siCoda,
  contentful: siContentful,
  digitalocean: siDigitalocean,
  dropbox: siDropbox,
  egnyte: siEgnyte,
  elevenlabs: siElevenlabs,
  fly: siFlydotio,
  gmail: siGmail,
  "google-calendar": siGooglecalendar,
  "google-drive": siGoogledrive,
  "grafana-cloud": siGrafana,
  gusto: siGusto,
  "help-scout": siHelpscout,
  logfire: siPydantic,
  lucid: siLucid,
  mixpanel: siMixpanel,
  "mongodb-atlas": siMongodb,
  "new-relic": siNewrelic,
  paddle: siPaddle,
  pagerduty: siPagerduty,
  perplexity: siPerplexity,
  planetscale: siPlanetscale,
  postman: siPostman,
  pulumi: siPulumi,
  railway: siRailway,
  render: siRender,
  replicate: siReplicate,
  revenuecat: siRevenuecat,
  sanity: siSanity,
  semrush: siSemrush,
  shortcut: siShortcut,
  similarweb: siSimilarweb,
  snowflake: siSnowflake,
  socket: siSocket,
  "stack-overflow": siStackoverflow,
  todoist: siTodoist,
  trello: siTrello,
  "weights-and-biases": siWeightsandbiases,
  xero: siXero,
  gemini: siGooglegemini,
  // AI providers (src/ai/ai-presets.ts logo keys; Bedrock, Foundry, Z.ai and custom endpoints have no Simple Icons mark)
  deepseek: siDeepseek,
  qwen: siQwen,
  kimi: siKimi,
  googlecloud: siGooglecloud,
  // Native integrations (Slack, monday.com and OpenAI's mark for Codex are drawn above: Simple Icons has none of them)
  claude: siClaude,
  codex,
  anthropic: siAnthropic,
  slack,
  monday,
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
