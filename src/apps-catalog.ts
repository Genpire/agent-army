/**
 * The apps the console offers to connect through their vendors' remote MCP
 * servers (see apps.ts): each address, transport and sign-in checked against
 * the vendor's own documentation (docsUrl). Plain data, served as is by
 * GET /api/apps/catalog: add an entry by appending one object, keeping the
 * list sorted by category, then name. Anything else is still reachable as a
 * custom app or through the MCP Registry search (apps-registry.ts).
 */
import { MORE_APPS } from "./apps-catalog-more.js";

export const APP_CATEGORIES = [
  "AI & search",
  "Automation",
  "Communication",
  "CRM & support",
  "Data",
  "Deploy & cloud",
  "Design",
  "Developer tools",
  "Docs & knowledge",
  "Files & productivity",
  "Finance & HR",
  "Marketing & analytics",
  "Monitoring",
  "Payments",
  "Project management",
  "Security",
] as const;
export type AppCategory = (typeof APP_CATEGORIES)[number];

/**
 * How an app signs in: "oauth" (the owner signs in in the browser; the MCP
 * authorization spec), "bearer" (an API key sent as Authorization: Bearer),
 * "header:<Name>" (an API key in that header), "none", or "custom" (unknown:
 * the owner picks, e.g. for an app found in the MCP Registry).
 */
export type AppAuthKind = "oauth" | "bearer" | "none" | "custom" | `header:${string}`;

/** A part of a per-account address, e.g. {tenant} in https://{tenant}.example.com/mcp. */
export interface CatalogUrlField {
  /** The placeholder's name in `url`, without braces. */
  key: string;
  /** What the console asks for, e.g. "Workspace name". */
  label: string;
  placeholder?: string;
  /** Where to find it. */
  help?: string;
}

export interface CatalogApp {
  /** Stable id, saved as the connection's presetId. Lowercase letters, digits and dashes. */
  id: string;
  name: string;
  category: AppCategory;
  /**
   * The MCP server's address. {placeholders} in it are asked for (see
   * urlFields; a placeholder without a field is asked for by its name) and
   * the address they make is checked like any other.
   */
  url: string;
  /** The parts of a per-account address, in the order they are asked for. */
  urlFields?: CatalogUrlField[];
  transport: "http" | "sse";
  /** The sign-in offered first. */
  auth: AppAuthKind;
  /** A second sign-in the vendor documents, offered as an alternative. */
  altAuth?: AppAuthKind;
  /**
   * For "header:<Name>": how the key is written in the header, {key} standing
   * for it, e.g. "Token token={key}" in Authorization. Default: the key itself.
   * ("bearer" is always "Bearer <key>".)
   */
  valueTemplate?: string;
  /** "manual": the vendor has no automatic client registration, so the owner registers an OAuth client and pastes its id (and secret). */
  clientRegistration?: "manual";
  /** The vendor's page for its MCP server. */
  docsUrl: string;
  /** Where to create the API key, for "bearer" and "header:" sign-ins. */
  keyHelp?: string;
  /** What Pointer and the agents can do with it, in one line. */
  description: string;
  /** Requests someone might make, for the console and Pointer's instructions. */
  examples: string[];
  /** Caveats shown before connecting (a plan it needs, a limit on who may sign in). */
  notes?: string;
  /** Other addresses the vendor offers (a region, read-only). */
  urlHint?: string;
}

const BASE_APPS: CatalogApp[] = [
  {
    id: "make",
    name: "Make",
    category: "Automation",
    url: "https://mcp.make.com/v2",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://developers.make.com/mcp-server",
    description: "Run your Make scenarios as tools and manage scenarios.",
    examples: ["Run my 'New lead to CRM' scenario for the sign-up from this morning", "Which Make scenarios are active?"],
    notes: "To use an API token instead, use your zone's address (https://<zone>.make.com/mcp/v2, e.g. eu2.make.com) as a custom app with a token that has the mcp:use scope.",
  },
  {
    id: "zapier",
    name: "Zapier",
    category: "Automation",
    url: "https://mcp.zapier.com/api/v1/connect",
    transport: "http",
    auth: "bearer",
    docsUrl: "https://docs.zapier.com/mcp/overview/how-connections-work",
    keyHelp: "At mcp.zapier.com, create a server, add the actions it may run, and generate its connection token (shown once).",
    description: "Run actions in thousands of apps through the actions you enable on your Zapier MCP server.",
    examples: ["Send a message to #sales through Zapier", "Add a row to the leads Google Sheet"],
  },
  {
    id: "hubspot",
    name: "HubSpot",
    category: "CRM & support",
    url: "https://mcp.hubspot.com/",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
    description: "Read and update CRM contacts, companies, deals and tickets.",
    examples: ["Which deals close this month?", "Find the contact record for jane@example.com"],
    notes: "Create an MCP connector in HubSpot (Development, MCP Connectors) with the redirect address shown here, then paste its client ID and secret.",
    clientRegistration: "manual",
  },
  {
    id: "intercom",
    name: "Intercom",
    category: "CRM & support",
    url: "https://mcp.intercom.com/mcp",
    transport: "http",
    auth: "bearer",
    docsUrl: "https://developers.intercom.com/docs/guides/mcp",
    keyHelp: "Use the access token of an app in Intercom's Developer Hub.",
    description: "Search and read conversations, contacts and tickets.",
    examples: ["Find open conversations about billing", "Look up the contact jane@example.com"],
    urlHint: "EU workspaces: https://mcp.eu.intercom.com/mcp.",
  },
  {
    id: "airtable",
    name: "Airtable",
    category: "Data",
    url: "https://mcp.airtable.com/mcp",
    transport: "http",
    auth: "oauth",
    altAuth: "bearer",
    docsUrl: "https://airtable.com/developers/agents/mcp/getting-started",
    keyHelp: "Create a personal access token with the scopes it needs at airtable.com/create/tokens.",
    description: "Read and write records, and look up bases and tables.",
    examples: ["Add a lead for Example Corp to the CRM base", "List the tasks whose status is Blocked"],
  },
  {
    id: "exa",
    name: "Exa",
    category: "Data",
    url: "https://mcp.exa.ai/mcp",
    transport: "http",
    auth: "header:x-api-key",
    altAuth: "none",
    docsUrl: "https://docs.exa.ai/reference/exa-mcp",
    keyHelp: "Create a key at dashboard.exa.ai/api-keys. Without one, search works at a free rate limit.",
    description: "Search the web and fetch page contents.",
    examples: ["Search for recent news on the EU AI Act", "Fetch and summarize this article"],
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    category: "Data",
    url: "https://mcp.firecrawl.dev/v2/mcp",
    transport: "http",
    auth: "bearer",
    docsUrl: "https://docs.firecrawl.dev/mcp-server/keyless",
    keyHelp: "Create a key at firecrawl.dev/app/api-keys.",
    description: "Scrape, crawl, search and extract structured data from websites.",
    examples: ["Scrape the pricing page of example.com", "Crawl our docs site and list the page titles"],
  },
  {
    id: "neon",
    name: "Neon",
    category: "Data",
    url: "https://mcp.neon.tech/mcp",
    transport: "http",
    auth: "bearer",
    altAuth: "oauth",
    docsUrl: "https://neon.com/docs/ai/neon-mcp-server",
    keyHelp: "Create an API key in the Neon Console's API keys settings.",
    description: "Manage Neon projects and branches, and run SQL against Postgres.",
    examples: ["Create a dev branch of the main database", "How many rows does the users table have?"],
  },
  {
    id: "prisma",
    name: "Prisma",
    category: "Data",
    url: "https://mcp.prisma.io/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://www.prisma.io/docs/postgres/integrations/mcp-server",
    description: "Manage Prisma Postgres databases, run SQL, restore backups and search Prisma's docs.",
    examples: ["Create a new Prisma Postgres database", "Restore yesterday's backup of the dev database"],
  },
  {
    id: "supabase",
    name: "Supabase",
    category: "Data",
    url: "https://mcp.supabase.com/mcp",
    transport: "http",
    auth: "oauth",
    altAuth: "bearer",
    docsUrl: "https://supabase.com/docs/guides/getting-started/mcp",
    keyHelp: "Generate a personal access token at supabase.com/dashboard/account/tokens.",
    description: "Manage projects, run SQL, inspect tables and logs, and manage migrations and edge functions.",
    examples: ["List the tables in the project", "Show the last 20 rows of the orders table"],
    urlHint: "Add ?project_ref=<id> to limit it to one project, and &read_only=true to keep it read-only.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    category: "Deploy & cloud",
    url: "https://mcp.cloudflare.com/mcp",
    transport: "http",
    auth: "bearer",
    altAuth: "oauth",
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/",
    keyHelp: "Create an API token with the permissions it needs at dash.cloudflare.com/profile/api-tokens.",
    description: "Search and call the Cloudflare API (DNS, Workers, R2 and more), and search Cloudflare's docs.",
    examples: ["List the DNS records for example.com", "Which Workers were deployed this week?"],
  },
  {
    id: "netlify",
    name: "Netlify",
    category: "Deploy & cloud",
    url: "https://mcp.netlify.com/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://docs.netlify.com/build/build-with-ai/netlify-mcp-server/",
    description: "Create, deploy and manage Netlify sites and their settings.",
    examples: ["What is the status of the latest deploy?", "List our Netlify sites"],
  },
  {
    id: "vercel",
    name: "Vercel",
    category: "Deploy & cloud",
    url: "https://mcp.vercel.com",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://vercel.com/docs/agent-resources/vercel-mcp",
    description: "Manage projects and deployments, read deployment logs, query Web Analytics and search Vercel's docs.",
    examples: ["Why did the last deployment fail?", "List our Vercel projects"],
    notes: "Vercel lets in clients it has reviewed, or clients that publish their own client metadata. This deployment publishes it when its public address is https.",
  },
  {
    id: "figma",
    name: "Figma",
    category: "Design",
    url: "https://mcp.figma.com/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    description: "Read design context, screenshots, variables and components from Figma files.",
    examples: ["What does the checkout frame in this Figma file contain?", "List the color variables of the design system"],
    notes: "Figma lets only the clients in its MCP catalog sign in, so it may refuse a self-hosted deployment.",
  },
  {
    id: "webflow",
    name: "Webflow",
    category: "Design",
    url: "https://mcp.webflow.com/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://developers.webflow.com/mcp/reference/how-it-works",
    description: "Manage Webflow sites, pages, and CMS collections and items.",
    examples: ["Add a blog post to the Webflow CMS", "List the pages of the marketing site"],
  },
  {
    id: "wix",
    name: "Wix",
    category: "Design",
    url: "https://mcp.wix.com/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://dev.wix.com/docs/sdk/articles/use-the-wix-mcp/about-the-wix-mcp",
    description: "Manage Wix sites, call Wix business APIs (stores, bookings, CMS) and search Wix's docs.",
    examples: ["List our Wix sites", "Add a product to the Wix store"],
  },
  {
    id: "buildkite",
    name: "Buildkite",
    category: "Developer tools",
    url: "https://mcp.buildkite.com/direct",
    transport: "http",
    auth: "bearer",
    docsUrl: "https://buildkite.com/docs/apis/mcp-server/remote/configuring-ai-tools",
    keyHelp: "Create an API access token with only the scopes it needs in your Buildkite personal settings.",
    description: "Inspect pipelines, builds, jobs and logs, and trigger builds.",
    examples: ["Why did the last main build fail?", "Trigger a build of the deploy pipeline"],
    urlHint: "Read-only: https://mcp.buildkite.com/direct/readonly.",
  },
  {
    id: "context7",
    name: "Context7",
    category: "Developer tools",
    url: "https://mcp.context7.com/mcp",
    transport: "http",
    auth: "bearer",
    altAuth: "none",
    docsUrl: "https://github.com/upstash/context7",
    keyHelp: "Get a free API key at context7.com/dashboard. Without one the rate limit is lower.",
    description: "Fetch up-to-date documentation and code examples for libraries.",
    examples: ["Show the current docs for Next.js route handlers", "How are relations configured in Prisma?"],
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    category: "Developer tools",
    url: "https://huggingface.co/mcp",
    transport: "http",
    auth: "bearer",
    altAuth: "none",
    docsUrl: "https://github.com/huggingface/hf-mcp-server",
    keyHelp: "Create an access token at huggingface.co/settings/tokens. Without one, fewer tools are offered.",
    description: "Search models, datasets, Spaces, papers and docs, and run community Space tools.",
    examples: ["Find a small model quantized for CPU", "Find a Space that transcribes audio"],
  },
  {
    id: "semgrep",
    name: "Semgrep",
    category: "Developer tools",
    url: "https://semgrep.dev/api/mcp",
    transport: "http",
    auth: "bearer",
    altAuth: "oauth",
    docsUrl: "https://docs.semgrep.dev/mcp/authentication",
    keyHelp: "In Semgrep, open Settings, Tokens and create an API token (a read-only token is enough for looking).",
    description: "Review, triage and fix security findings from the Semgrep AppSec Platform.",
    examples: ["List the critical findings in the api repository", "Explain finding 4521 and suggest a fix"],
    notes: "Needs a Semgrep Teams or Enterprise plan.",
    urlHint: "Read-only: https://semgrep.dev/api/mcp/read-only.",
  },
  {
    id: "twilio-docs",
    name: "Twilio API docs",
    category: "Developer tools",
    url: "https://mcp.twilio.com/docs",
    transport: "http",
    auth: "none",
    docsUrl: "https://www.twilio.com/docs/ai/mcp",
    description: "Search Twilio's API operations and docs. It cannot act on a Twilio account.",
    examples: ["How do I send an SMS with the Twilio API?", "Which parameters does creating a Verify service take?"],
  },
  {
    id: "box",
    name: "Box",
    category: "Docs & knowledge",
    url: "https://mcp.box.com",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://developer.box.com/guides/box-mcp/remote/",
    description: "Search, read and manage Box files and folders, and ask Box AI about documents.",
    examples: ["Find the signed agreement with Example Corp", "Summarize the latest board deck"],
    notes: "A Box admin creates a Box MCP server in the Admin Console with the redirect address shown here, then you paste its client ID and secret.",
    clientRegistration: "manual",
  },
  {
    id: "notion",
    name: "Notion",
    category: "Docs & knowledge",
    url: "https://mcp.notion.com/mcp",
    transport: "http",
    auth: "oauth",
    altAuth: "bearer",
    docsUrl: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    keyHelp: "On Business and Enterprise plans, a workspace owner can create an MCP token in Notion's developer portal.",
    description: "Search, read, create and update pages and databases.",
    examples: ["Find the Q3 roadmap page", "Add meeting notes under Team Docs"],
  },
  {
    id: "datadog",
    name: "Datadog",
    category: "Monitoring",
    url: "https://mcp.datadoghq.com/v1/mcp",
    transport: "http",
    auth: "bearer",
    docsUrl: "https://docs.datadoghq.com/mcp_server/setup/",
    keyHelp: "Create a personal access token, or a service access token for a service account, in Datadog.",
    description: "Query logs, metrics, traces, monitors, incidents and dashboards.",
    examples: ["Show error logs for the payments service in the last hour", "Which monitors are alerting?"],
    urlHint: "Other Datadog sites have their own address, e.g. https://mcp.datadoghq.eu/v1/mcp.",
  },
  {
    id: "dynatrace",
    name: "Dynatrace",
    category: "Monitoring",
    url: "https://{environment}.apps.dynatrace.com/platform-reserved/mcp-gateway/v0.1/servers/dynatrace-mcp/mcp",
    urlFields: [{ key: "environment", label: "Environment", placeholder: "abc12345", help: "The first part of your Dynatrace address: https://<environment>.apps.dynatrace.com." }],
    transport: "http",
    auth: "bearer",
    docsUrl: "https://docs.dynatrace.com/docs/dynatrace-intelligence/dynatrace-mcp",
    keyHelp: "Generate a platform token with mcp-gateway:servers:invoke and mcp-gateway:servers:read, plus the scopes of the tools it uses.",
    description: "Run DQL over logs, metrics and traces, and investigate problems and vulnerabilities.",
    examples: ["Show error logs for the checkout service in the last 30 minutes", "Which open problems affect production?"],
  },
  {
    id: "grafana",
    name: "Grafana Cloud",
    category: "Monitoring",
    url: "https://mcp.grafana.com/mcp/{stack}.grafana.net",
    urlFields: [{ key: "stack", label: "Stack name", placeholder: "mycompany", help: "The first part of your stack's address: https://<stack>.grafana.net." }],
    transport: "http",
    auth: "oauth",
    docsUrl: "https://grafana.com/docs/grafana-cloud/platform/grafana-assistant/configure/cloud-mcp",
    description: "Query dashboards, metrics, logs and alerts in a Grafana Cloud stack.",
    examples: ["Show the error-rate panels for the checkout service", "Are any alerts firing?"],
  },
  {
    id: "posthog",
    name: "PostHog",
    category: "Monitoring",
    url: "https://mcp.posthog.com/mcp",
    transport: "http",
    auth: "bearer",
    altAuth: "oauth",
    docsUrl: "https://posthog.com/docs/model-context-protocol/faq",
    keyHelp: "Create a personal API key with the MCP Server preset in PostHog's settings (Personal API keys).",
    description: "Query analytics and insights, and manage feature flags, experiments and error tracking.",
    examples: ["How many sign-ups did we get last week?", "Turn off the new-checkout feature flag"],
  },
  {
    id: "sentry",
    name: "Sentry",
    category: "Monitoring",
    url: "https://mcp.sentry.dev/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://mcp.sentry.dev/",
    description: "Look up issues, errors, stack traces, releases and performance data.",
    examples: ["What are the top unresolved errors in the web project?", "Show the stack trace of issue WEB-123"],
    urlHint: "Add /<organization>/<project> to limit it to one project.",
  },
  {
    id: "mercadopago",
    name: "Mercado Pago",
    category: "Payments",
    url: "https://mcp.mercadopago.com/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://www.mercadopago.com.ar/developers/en/docs/mcp-server/connection",
    description: "Search Mercado Pago's developer docs, and manage applications, credentials and integration settings.",
    examples: ["How do I set up Mercado Pago webhooks?", "List our Mercado Pago applications"],
  },
  {
    id: "paypal",
    name: "PayPal",
    category: "Payments",
    url: "https://mcp.paypal.com/http",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://developer.paypal.com/tools/mcp-server/",
    description: "Create and manage invoices and other PayPal commerce data.",
    examples: ["Create a $200 invoice for jane@example.com", "List last month's invoices"],
    urlHint: "Sandbox: https://mcp.sandbox.paypal.com/http.",
  },
  {
    id: "stripe",
    name: "Stripe",
    category: "Payments",
    url: "https://mcp.stripe.com",
    transport: "http",
    auth: "bearer",
    altAuth: "oauth",
    docsUrl: "https://docs.stripe.com/mcp",
    keyHelp: "In the Stripe Dashboard (Developers, API keys), create an agent API key with only the permissions it needs. Other secret keys are refused.",
    description: "Query and manage customers, payments, invoices, subscriptions and refunds, and search Stripe's docs.",
    examples: ["How much revenue did we make last week?", "Create a payment link for the Pro plan at $49"],
  },
  {
    id: "asana",
    name: "Asana",
    category: "Project management",
    url: "https://mcp.asana.com/v2/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://developers.asana.com/docs/integrating-with-asanas-mcp-server",
    description: "Read and create tasks, projects and comments.",
    examples: ["Create a task to review the Q4 budget", "Which Marketing tasks are due this week?"],
    notes: "Create an MCP app in Asana's developer console with the redirect address shown here, then paste its client ID and secret.",
    clientRegistration: "manual",
  },
  {
    id: "atlassian",
    name: "Atlassian Rovo",
    category: "Project management",
    url: "https://mcp.atlassian.com/v2/mcp",
    transport: "http",
    auth: "oauth",
    altAuth: "bearer",
    docsUrl: "https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token/",
    keyHelp: "An organization admin turns on API token sign-in for the Rovo MCP server, then creates a service account API key in Atlassian Administration.",
    description: "Search, create and update Jira issues and Confluence pages.",
    examples: ["Open a Jira ticket in PROJ for the checkout error", "Summarize the Confluence onboarding page"],
    notes: "Pointer also has a built-in Jira & Confluence integration under Work tracking.",
  },
  {
    id: "clickup",
    name: "ClickUp",
    category: "Project management",
    url: "https://mcp.clickup.com/mcp",
    transport: "http",
    auth: "oauth",
    docsUrl: "https://developer.clickup.com/docs/connect-an-ai-assistant-to-clickups-mcp-server",
    description: "Manage tasks, lists, docs and comments in ClickUp workspaces.",
    examples: ["Create a task for the onboarding email", "What is overdue in my space?"],
  },
  {
    id: "linear",
    name: "Linear",
    category: "Project management",
    url: "https://mcp.linear.app/mcp",
    transport: "http",
    auth: "oauth",
    altAuth: "bearer",
    docsUrl: "https://linear.app/docs/mcp",
    keyHelp: "Create a personal API key in Linear's settings.",
    description: "Search, create and update issues, projects, cycles and comments.",
    examples: ["Open a Linear issue for the login bug", "What is assigned to me this cycle?"],
    urlHint: "Read-only: https://mcp.linear.app/mcp/readonly.",
  },
];

/** A catalog entry by id. */
/** Every catalog app (these and apps-catalog-more.ts), sorted by category, then name. */
export const APP_CATALOG: CatalogApp[] = [...BASE_APPS, ...MORE_APPS].sort(
  (x, y) => x.category.localeCompare(y.category) || x.name.localeCompare(y.name),
);

export const catalogApp = (id: string | undefined): CatalogApp | undefined => (id ? APP_CATALOG.find((a) => a.id === id) : undefined);
