/**
 * Markdown to email: a small, safe renderer for routines' reports. It reads
 * the Markdown Pointer writes (headings, paragraphs, bold, italic,
 * strikethrough, code, lists with task boxes, quotes, tables, rules and
 * links) into a tree, then writes that tree as HTML with inline styles and as
 * plain text. Everything is escaped: raw HTML shows as text, images as their
 * alt text, and links are kept only for http(s) addresses. Each pass is
 * linear in the input, which is capped by the caller (EMAIL_LIMITS).
 */

type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

type Align = "left" | "center" | "right" | null;

type Block =
  | { t: "h"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: { task?: boolean; c: Block[] }[] }
  | { t: "table"; align: Align[]; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

/** Quotes and lists inside each other, and emphasis inside emphasis, deeper than this are read as plain text. */
const MAX_DEPTH = 8;
const MAX_URL = 2000;
const MAX_COLUMNS = 30;

// ---------- Escaping and links ----------

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Text for HTML content or a quoted attribute. */
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]!);

/**
 * A link target the email may carry: an absolute http(s) address without
 * credentials, normalised by the URL parser. Anything else (javascript:,
 * data:, mailto:, relative paths) is undefined: the link shows as text.
 */
export function safeHref(raw: string): string | undefined {
  const s = raw.trim();
  if (!s || s.length > MAX_URL || /[\u0000- \u007f]/.test(s) || !/^https?:\/\//i.test(s)) return undefined;
  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return undefined;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || !url.hostname) return undefined;
  return url.href;
}

// ---------- Inline parsing ----------

const PUNCT = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;

/** The first `delim` at or after `from` that is not backslash-escaped, or -1. */
function findUnescaped(src: string, delim: string, from: number): number {
  for (let j = src.indexOf(delim, from); j !== -1; j = src.indexOf(delim, j + 1)) {
    let slashes = 0;
    for (let k = j - 1; k >= 0 && src[k] === "\\"; k--) slashes++;
    if (slashes % 2 === 0) return j;
  }
  return -1;
}

/** Strips punctuation that ends a sentence, and a ")" the address did not open, from a bare URL. */
function trimBareUrl(url: string): string {
  const tail = /[.,;:!?'"*_~]+$/;
  let u = url.replace(tail, "");
  while (u.endsWith(")") && (u.match(/\)/g)?.length ?? 0) > (u.match(/\(/g)?.length ?? 0)) u = u.slice(0, -1).replace(tail, "");
  return u;
}

/**
 * `[text](url "title")` with its "[" at `i` and its "]" at `close`: the text,
 * the URL and where it ends. Every character looked at is taken from
 * `budget`, shared by the whole paragraph: once it is spent, brackets are
 * text, so many "[a](" in a row cannot make the pass quadratic.
 */
function readLink(src: string, i: number, close: number, budget: { left: number }): { text: string; url: string; end: number } | undefined {
  if (src[close + 1] !== "(" || budget.left <= 0) return undefined;
  let j = close + 2;
  const done = <T,>(result: T): T => {
    budget.left -= j - close;
    return result;
  };
  while (src[j] === " ") j++;
  let url = "";
  if (src[j] === "<") {
    const end = src.slice(j, j + MAX_URL + 2).indexOf(">");
    if (end === -1) {
      j += MAX_URL + 2;
      return done(undefined);
    }
    url = src.slice(j + 1, j + end);
    j += end + 1;
  } else {
    let depth = 0;
    const start = j;
    for (; j < src.length && j - start <= MAX_URL; j++) {
      const ch = src[j]!;
      if (ch === "\\" && j + 1 < src.length) {
        j++;
        continue;
      }
      if (/\s/.test(ch)) break;
      if (ch === "(") depth++;
      if (ch === ")") {
        if (depth === 0) break;
        depth--;
      }
    }
    url = src.slice(start, j).replace(/\\(.)/g, "$1");
  }
  while (src[j] === " ") j++;
  // An optional title ("…", '…' or (…)), which an email has no use for.
  const quote = src[j];
  if (quote === '"' || quote === "'" || quote === "(") {
    const end = src.slice(j + 1, j + 501).indexOf(quote === "(" ? ")" : quote);
    if (end === -1) {
      j += 501;
      return done(undefined);
    }
    j += end + 2;
    while (src[j] === " ") j++;
  }
  if (src[j] !== ")") return done(undefined);
  return done({ text: src.slice(i + 1, close), url, end: j + 1 });
}

/**
 * Inline Markdown into nodes. Every delimiter search that fails is
 * remembered, and the next "]" is shared by every "[" before it, so the pass
 * stays linear however the text is written.
 */
function parseInline(src: string, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  const failed = new Set<string>();
  const budget = { left: 2 * src.length + 4 * MAX_URL };
  let nextClose = -2;
  const closeAfter = (i: number) => {
    if (nextClose !== -1 && nextClose <= i) nextClose = findUnescaped(src, "]", i + 1);
    return nextClose;
  };
  const deeper = (s: string, link = inLink): Inline[] => (depth >= MAX_DEPTH ? [{ t: "text", v: s }] : parseInline(s, depth + 1, link));

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const prev = i > 0 ? src[i - 1]! : "";

    if (ch === "\\" && i + 1 < src.length) {
      const next = src[i + 1]!;
      if (next === "\n") {
        flush();
        out.push({ t: "br" });
        i += 2;
        continue;
      }
      if (PUNCT.test(next)) {
        buf += next;
        i += 2;
        continue;
      }
    }

    if (ch === "\n") {
      flush();
      out.push({ t: "br" });
      i++;
      continue;
    }

    if (ch === "`") {
      let n = 1;
      while (src[i + n] === "`") n++;
      const run = "`".repeat(n);
      const key = `code${n}`;
      if (!failed.has(key)) {
        let j = src.indexOf(run, i + n);
        while (j !== -1 && (src[j + n] === "`" || src[j - 1] === "`")) {
          let k = j;
          while (src[k] === "`") k++;
          j = src.indexOf(run, k);
        }
        if (j !== -1) {
          flush();
          let v = src.slice(i + n, j).replace(/\n/g, " ");
          if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim()) v = v.slice(1, -1);
          out.push({ t: "code", v });
          i = j + n;
          continue;
        }
        failed.add(key);
      }
      buf += run;
      i += n;
      continue;
    }

    // Images are shown as their alt text: no remote images (they track opens) and nothing to load.
    if (ch === "[" || (ch === "!" && src[i + 1] === "[")) {
      const open = ch === "!" ? i + 1 : i;
      const close = closeAfter(open);
      const link = close === -1 ? undefined : readLink(src, open, close, budget);
      if (link) {
        flush();
        const href = ch === "!" || inLink ? undefined : safeHref(link.url);
        if (href) out.push({ t: "link", href, c: deeper(link.text, true) });
        else out.push(...deeper(link.text));
        i = link.end;
        continue;
      }
    }

    if (ch === "<" && !inLink) {
      const m = src.slice(i, i + MAX_URL + 12).match(/^<(https?:\/\/[^\s<>]{1,2000})>/i);
      const href = m ? safeHref(m[1]!) : undefined;
      if (m && href) {
        flush();
        out.push({ t: "link", href, c: [{ t: "text", v: m[1]! }] });
        i += m[0].length;
        continue;
      }
    }

    if ((ch === "h" || ch === "H") && !inLink && !WORD.test(prev)) {
      const m = src.slice(i, i + MAX_URL + 1).match(/^https?:\/\/[^\s<>]+/i);
      if (m) {
        const url = trimBareUrl(m[0]);
        const href = url.length > "https://".length ? safeHref(url) : undefined;
        if (href) {
          flush();
          out.push({ t: "link", href, c: [{ t: "text", v: url }] });
          i += url.length;
          continue;
        }
      }
    }

    if ((ch === "*" || ch === "_") && src.startsWith(ch + ch + ch, i) && !failed.has(`em3${ch}`)) {
      const run = ch + ch + ch;
      const after = src[i + 3] ?? "";
      if (after !== "" && !/\s/.test(after) && after !== ch && !(ch === "_" && WORD.test(prev))) {
        let j = src.indexOf(run, i + 4);
        while (j !== -1 && (/\s/.test(src[j - 1]!) || src[j + 3] === ch)) j = src.indexOf(run, j + 1);
        if (j !== -1) {
          flush();
          out.push({ t: "strong", c: [{ t: "em", c: deeper(src.slice(i + 3, j)) }] });
          i = j + 3;
          continue;
        }
        failed.add(`em3${ch}`);
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const double = src[i + 1] === ch;
      if (ch === "~" && !double) {
        buf += ch;
        i++;
        continue;
      }
      const delim = double ? ch + ch : ch;
      const n = delim.length;
      const after = src[i + n] ?? "";
      // Underscores inside a word (snake_case) are not emphasis.
      const opens = after !== "" && !/\s/.test(after) && after !== ch && !(ch === "_" && WORD.test(prev));
      const key = `em${delim}`;
      if (opens && !failed.has(key)) {
        let j = src.indexOf(delim, i + n + 1);
        while (j !== -1) {
          const before = src[j - 1]!;
          const next = src[j + n] ?? "";
          const valid = !/\s/.test(before) && before !== "\\" && next !== ch && (n === 2 || before !== ch) && !(ch === "_" && WORD.test(next));
          if (valid) break;
          j = src.indexOf(delim, j + 1);
        }
        if (j !== -1) {
          flush();
          out.push({ t: ch === "~" ? "del" : n === 2 ? "strong" : "em", c: deeper(src.slice(i + n, j)) });
          i = j + n;
          continue;
        }
        failed.add(key);
      }
      buf += delim;
      i += n;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

// ---------- Block parsing ----------

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;
const DELIM_RE = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

const isBlank = (line: string) => line.trim() === "";
const indentOf = (line: string) => line.length - line.replace(/^[ \t]+/, "").length;

/** A table row's cells: split on "|" outside code spans, without the outer pipes. */
function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "\\" && s[i + 1] === "|") {
      cell += "\\|";
      i++;
    } else if (ch === "`") {
      inCode = !inCode;
      cell += ch;
    } else if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  cells.push(cell.trim());
  return cells.slice(0, MAX_COLUMNS);
}

const startsTable = (lines: string[], i: number) =>
  lines[i]!.includes("|") &&
  i + 1 < lines.length &&
  lines[i + 1]!.includes("-") &&
  DELIM_RE.test(lines[i + 1]!) &&
  splitRow(lines[i]!).length === splitRow(lines[i + 1]!).length;

/** Whether a line starts a block other than a paragraph (so it ends the paragraph above it). */
const startsBlock = (lines: string[], i: number) => {
  const line = lines[i]!;
  return FENCE_RE.test(line) || HEADING_RE.test(line) || HR_RE.test(line) || QUOTE_RE.test(line) || LIST_RE.test(line) || startsTable(lines, i);
};

function parseBlocks(lines: string[], depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (fence && !(fence[1]!.startsWith("`") && fence[2]!.includes("`"))) {
      const marker = fence[1]!;
      const closer = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`);
      const body: string[] = [];
      i++;
      while (i < lines.length && !closer.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ t: "code", v: body.join("\n") });
      continue;
    }

    const heading = line.match(HEADING_RE);
    if (heading) {
      out.push({ t: "h", level: heading[1]!.length, c: parseInline((heading[2] ?? "").replace(/[ \t]+#+$/, "").replace(/^#+$/, "")) });
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i]!)) body.push(lines[i++]!.replace(/^ {0,3}> ?/, ""));
      out.push(depth < MAX_DEPTH ? { t: "quote", c: parseBlocks(body, depth + 1) } : { t: "p", c: parseInline(body.join("\n")) });
      continue;
    }

    if (LIST_RE.test(line)) {
      const parsed = parseList(lines, i, depth);
      out.push(parsed.block);
      i = parsed.next;
      continue;
    }

    if (startsTable(lines, i)) {
      const head = splitRow(lines[i]!);
      const align: Align[] = splitRow(lines[i + 1]!).map((d) => (d.startsWith(":") && d.endsWith(":") ? "center" : d.endsWith(":") ? "right" : d.startsWith(":") ? "left" : null));
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]!) && lines[i]!.includes("|")) {
        const cells = splitRow(lines[i++]!);
        rows.push(head.map((_, k) => parseInline(cells[k] ?? "")));
      }
      out.push({ t: "table", align, head: head.map((h) => parseInline(h)), rows });
      continue;
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]!) && !startsBlock(lines, i)) para.push(lines[i++]!.trim());
    out.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return out;
}

/** A list from line `start`: its items with what is indented under them (nested lists, more paragraphs). */
function parseList(lines: string[], start: number, depth: number): { block: Block; next: number } {
  const first = lines[start]!.match(LIST_RE)!;
  const ordered = /\d/.test(first[2]!);
  const base = first[1]!.length;
  const items: { task?: boolean; c: Block[] }[] = [];
  let i = start;
  while (i < lines.length) {
    const m = lines[i]!.match(LIST_RE);
    if (!m || m[1]!.length > base + 1 || /\d/.test(m[2]!) !== ordered || HR_RE.test(lines[i]!)) break;
    const contentIndent = m[1]!.length + m[2]!.length + 1;
    const body = [m[3] ?? ""];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l)) {
        let j = i;
        while (j < lines.length && isBlank(lines[j]!)) j++;
        if (j < lines.length && indentOf(lines[j]!) > base + 1) {
          body.push("");
          i++;
          continue;
        }
        break;
      }
      const ind = indentOf(l);
      if (ind > base + 1) body.push(l.slice(Math.min(ind, contentIndent)));
      else if (!startsBlock(lines, i) && !isBlank(body[body.length - 1]!)) body.push(l.trim());
      else break;
      i++;
    }
    let task: boolean | undefined;
    const box = body[0]!.match(/^\[([ xX])\][ \t]+/);
    if (box) {
      task = box[1] !== " ";
      body[0] = body[0]!.slice(box[0].length);
    }
    const c: Block[] = depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ t: "p", c: parseInline(body.join("\n")) }];
    items.push(task === undefined ? { c } : { task, c });
    // A blank line between two items keeps the list going.
    let j = i;
    while (j < lines.length && isBlank(lines[j]!)) j++;
    if (j > i && j < lines.length && LIST_RE.test(lines[j]!)) i = j;
  }
  const startNumber = ordered ? Math.min(Number.parseInt(first[2]!, 10), 1_000_000_000) : 1;
  return { block: { t: "list", ordered, start: startNumber, items }, next: i };
}

const parseMarkdown = (markdown: string): Block[] => parseBlocks(markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n"), 0);

// ---------- HTML ----------

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

/** Inline styles: many email clients ignore style sheets. */
const STYLE = {
  h1: "margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:#18181b;",
  h2: "margin:20px 0 10px;font-size:19px;line-height:1.3;font-weight:700;color:#18181b;",
  h3: "margin:18px 0 8px;font-size:17px;line-height:1.35;font-weight:600;color:#18181b;",
  h4: "margin:16px 0 8px;font-size:15px;line-height:1.4;font-weight:600;color:#18181b;",
  p: "margin:0 0 12px;",
  list: "margin:0 0 12px;padding-left:24px;",
  li: "margin:0 0 4px;",
  quote: "margin:0 0 12px;padding:4px 0 4px 12px;border-left:3px solid #d4d4d8;color:#52525b;",
  pre: `margin:0 0 12px;padding:12px;background:#f4f4f5;border-radius:6px;font:13px/1.5 ${MONO};white-space:pre-wrap;word-break:break-word;color:#18181b;`,
  code: `padding:1px 4px;background:#f4f4f5;border-radius:4px;font-family:${MONO};font-size:13px;`,
  a: "color:#2563eb;text-decoration:underline;",
  table: "border-collapse:collapse;margin:0 0 12px;width:100%;font-size:14px;",
  th: "padding:6px 8px;border:1px solid #e4e4e7;background:#fafafa;font-weight:600;",
  td: "padding:6px 8px;border:1px solid #e4e4e7;vertical-align:top;",
  hr: "border:0;border-top:1px solid #e4e4e7;margin:16px 0;",
} as const;

function inlineHtml(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
          return escapeHtml(n.v);
        case "code":
          return `<code style="${STYLE.code}">${escapeHtml(n.v)}</code>`;
        case "strong":
          return `<strong>${inlineHtml(n.c)}</strong>`;
        case "em":
          return `<em>${inlineHtml(n.c)}</em>`;
        case "del":
          return `<del>${inlineHtml(n.c)}</del>`;
        case "link":
          return `<a href="${escapeHtml(n.href)}" style="${STYLE.a}" target="_blank" rel="noopener noreferrer">${inlineHtml(n.c)}</a>`;
        case "br":
          return "<br>";
      }
    })
    .join("");
}

function blocksHtml(blocks: Block[], tight = false): string {
  return blocks
    .map((b, k) => {
      switch (b.t) {
        case "h": {
          const style = STYLE[`h${Math.min(b.level, 4) as 1 | 2 | 3 | 4}`];
          return `<h${b.level} style="${style}">${inlineHtml(b.c)}</h${b.level}>`;
        }
        case "p":
          // In a list item, paragraphs need no margins of their own.
          return tight ? `${k > 0 ? "<br>" : ""}${inlineHtml(b.c)}` : `<p style="${STYLE.p}">${inlineHtml(b.c)}</p>`;
        case "code":
          return `<pre style="${STYLE.pre}"><code>${escapeHtml(b.v)}</code></pre>`;
        case "quote":
          return `<blockquote style="${STYLE.quote}">${blocksHtml(b.c)}</blockquote>`;
        case "list": {
          const tag = b.ordered ? "ol" : "ul";
          const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : "";
          const items = b.items.map((it) => `<li style="${STYLE.li}">${it.task === undefined ? "" : it.task ? "&#9745; " : "&#9744; "}${blocksHtml(it.c, true)}</li>`).join("");
          return `<${tag}${start} style="${tight ? "margin:4px 0;padding-left:24px;" : STYLE.list}">${items}</${tag}>`;
        }
        case "table": {
          const cell = (tag: "th" | "td", c: Inline[], col: number) => `<${tag} style="${STYLE[tag]}text-align:${b.align[col] ?? "left"};">${inlineHtml(c)}</${tag}>`;
          const head = `<tr>${b.head.map((c, col) => cell("th", c, col)).join("")}</tr>`;
          const rows = b.rows.map((r) => `<tr>${r.map((c, col) => cell("td", c, col)).join("")}</tr>`).join("");
          return `<table role="presentation" cellpadding="0" cellspacing="0" style="${STYLE.table}"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
        }
        case "hr":
          return `<hr style="${STYLE.hr}">`;
      }
    })
    .join("\n");
}

/** Markdown as the HTML of an email's content (no page around it). */
export const markdownToHtml = (markdown: string): string => blocksHtml(parseMarkdown(markdown));

// ---------- Plain text ----------

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case "text":
        case "code":
          return n.v;
        case "strong":
        case "em":
        case "del":
          return inlineText(n.c);
        case "link": {
          const label = inlineText(n.c);
          return label === n.href || `${label}/` === n.href ? n.href : `${label} (${n.href})`;
        }
        case "br":
          return "\n";
      }
    })
    .join("");
}

const prefixLines = (text: string, prefix: string, first = prefix) =>
  text
    .split("\n")
    .map((l, k) => (k === 0 ? first : prefix) + l)
    .join("\n");

function blocksText(blocks: Block[], tight = false): string {
  return blocks
    .map((b) => {
      switch (b.t) {
        case "h": {
          const text = inlineText(b.c);
          return b.level <= 2 ? `${text}\n${(b.level === 1 ? "=" : "-").repeat(Math.min(Math.max(text.length, 3), 72))}` : text;
        }
        case "p":
          return inlineText(b.c);
        case "code":
          return prefixLines(b.v, "    ");
        case "quote":
          return prefixLines(blocksText(b.c), "> ");
        case "list":
          return b.items
            .map((it, k) => {
              const marker = b.ordered ? `${b.start + k}. ` : "- ";
              const box = it.task === undefined ? "" : it.task ? "[x] " : "[ ] ";
              return prefixLines(box + blocksText(it.c, true), " ".repeat(marker.length), marker);
            })
            .join("\n");
        case "table":
          return [b.head, ...b.rows].map((r) => r.map((c) => inlineText(c).replace(/\n/g, " ")).join(" | ")).join("\n");
        case "hr":
          return "----";
      }
    })
    .join(tight ? "\n" : "\n\n");
}

/** Markdown as readable plain text: emphasis markers dropped, links as "text (address)". */
export const markdownToText = (markdown: string): string => blocksText(parseMarkdown(markdown));

// ---------- The email ----------

export interface RenderedEmail {
  html: string;
  text: string;
}

/**
 * A report as a whole email: the organisation's name at the top, the
 * Markdown as content and "Sent by Pointer" underneath; and the same as
 * plain text.
 */
export function renderEmail(input: { subject: string; markdown: string; orgName: string; senderName: string }): RenderedEmail {
  const org = input.orgName.trim();
  const sender = input.senderName.trim() || "Pointer";
  const footer = `Sent by ${sender}${org ? ` for ${org}` : ""}.`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(input.subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;background:#ffffff;border:1px solid #e4e4e7;border-radius:8px;">
<tr><td style="padding:16px 28px;border-bottom:1px solid #e4e4e7;font:600 14px/1.4 ${FONT};color:#52525b;">${escapeHtml(org || sender)}</td></tr>
<tr><td style="padding:24px 28px;font:400 15px/1.6 ${FONT};color:#18181b;">
${markdownToHtml(input.markdown)}
</td></tr>
<tr><td style="padding:14px 28px;border-top:1px solid #e4e4e7;font:400 12px/1.5 ${FONT};color:#71717a;">${escapeHtml(footer)}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
  const text = `${markdownToText(input.markdown).trim()}\n\n--\n${footer}\n`;
  return { html, text };
}
