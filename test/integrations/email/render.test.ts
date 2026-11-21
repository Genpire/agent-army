import { describe, expect, it } from "vitest";
import { escapeHtml, markdownToHtml, markdownToText, renderEmail, safeHref } from "../../../src/integrations/email/render.js";

/** The HTML without the inline styles, to compare structure. */
const bare = (html: string) => html.replace(/ style="[^"]*"/g, "").replace(/ target="_blank" rel="noopener noreferrer"/g, "");
const html = (md: string) => bare(markdownToHtml(md));

describe("escaping", () => {
  it("escapes the five HTML characters", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;");
  });

  it("shows raw HTML as text, everywhere", () => {
    const md = [
      "<script>alert(1)</script>",
      "",
      "# <img src=x onerror=alert(1)>",
      "",
      "- <b>item</b>",
      "",
      "> <iframe src=https://evil.example>",
      "",
      "| <th> | x |",
      "| --- | --- |",
      "| <td onclick=x> | `<code>` |",
      "",
      "```",
      "</code></pre><script>x</script>",
      "```",
    ].join("\n");
    const out = markdownToHtml(md);
    expect(out).not.toMatch(/<(script|img|iframe|b)[\s>]/i);
    expect(out).not.toMatch(/<\/code><\/pre><script>/);
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(out).toContain("&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;x&lt;/script&gt;");
    expect(out).toContain("&lt;td onclick=x&gt;");
  });

  it("escapes quotes in link addresses and keeps attributes closed", () => {
    const out = markdownToHtml('[x](https://example.com/"onmouseover="alert(1))');
    expect(out).not.toContain('"onmouseover="');
    expect(out).toMatch(/href="https:\/\/example\.com\/%22onmouseover=%22alert\(1\)"/);
  });
});

describe("links", () => {
  it("keeps only absolute http(s) addresses without credentials", () => {
    expect(safeHref("https://example.com/a?b=1&c=2")).toBe("https://example.com/a?b=1&c=2");
    expect(safeHref("HTTP://Example.com")).toBe("http://example.com/");
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html,<b>x</b>", "vbscript:x", "mailto:a@example.com", "/relative", "//example.com", "https://user:pw@example.com/", "https://exa mple.com", "https://\u0000example.com", "ftp://example.com", `https://example.com/${"a".repeat(2001)}`, ""]) {
      expect(safeHref(bad), bad).toBeUndefined();
    }
  });

  it("links http(s) targets and shows the rest as text", () => {
    expect(html("[Dashboard](https://example.com/dash)")).toBe('<p><a href="https://example.com/dash">Dashboard</a></p>');
    expect(html("[click](javascript:alert(1))")).toBe("<p>click</p>");
    expect(html("[x](data:text/html;base64,PHNjcmlwdD4=)")).toBe("<p>x</p>");
    expect(html("[mail](mailto:a@example.com)")).toBe("<p>mail</p>");
    expect(html("[rel](/admin)")).toBe("<p>rel</p>");
    expect(html('[t](https://example.com "A title")')).toBe('<p><a href="https://example.com/">t</a></p>');
  });

  it("links bare and angle-bracket addresses, without the sentence's punctuation", () => {
    expect(html("See https://example.com/a_(b), or <https://example.org/x>.")).toBe(
      '<p>See <a href="https://example.com/a_(b)">https://example.com/a_(b)</a>, or <a href="https://example.org/x">https://example.org/x</a>.</p>',
    );
    expect(html("(see https://example.com/page).")).toBe('<p>(see <a href="https://example.com/page">https://example.com/page</a>).</p>');
    expect(html("<javascript:alert(1)>")).toBe("<p>&lt;javascript:alert(1)&gt;</p>");
  });

  it("never nests links, and shows images as their alt text", () => {
    expect(html("[see https://example.org](https://example.com)")).toBe('<p><a href="https://example.com/">see https://example.org</a></p>');
    expect(html("![chart](https://tracker.example/pixel.png)")).toBe("<p>chart</p>");
    expect(markdownToHtml("![x](https://tracker.example/p.png)")).not.toContain("<img");
  });
});

describe("markdown", () => {
  it("renders headings, emphasis, code and rules", () => {
    expect(html("# Title\n## Sub\n#### Small")).toBe("<h1>Title</h1>\n<h2>Sub</h2>\n<h4>Small</h4>");
    expect(html("**bold** *it* _it_ __bold__ ~~gone~~ ***both*** `a < b`")).toBe(
      "<p><strong>bold</strong> <em>it</em> <em>it</em> <strong>bold</strong> <del>gone</del> <strong><em>both</em></strong> <code>a &lt; b</code></p>",
    );
    expect(html("snake_case_name and 2 * 3 * 4 and a*b")).toBe("<p>snake_case_name and 2 * 3 * 4 and a*b</p>");
    expect(html("\\*not em\\* and \\# not heading")).toBe("<p>*not em* and # not heading</p>");
    expect(html("---")).toBe("<hr>");
    expect(html("```ts\nconst a = 1 < 2;\n```")).toBe("<pre><code>const a = 1 &lt; 2;</code></pre>");
  });

  it("keeps line breaks inside a paragraph", () => {
    expect(html("Users: 1 200\nRevenue: $5")).toBe("<p>Users: 1 200<br>Revenue: $5</p>");
  });

  it("renders lists, nested lists and task boxes", () => {
    expect(html("- one\n- two\n  - nested\n- [x] done\n- [ ] open")).toBe(
      "<ul><li>one</li><li>two\n<ul><li>nested</li></ul></li><li>&#9745; done</li><li>&#9744; open</li></ul>",
    );
    expect(html("3. three\n4. four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(html("1. a\n\n2. b")).toBe("<ol><li>a</li><li>b</li></ol>");
  });

  it("renders tables with alignment and escaped pipes", () => {
    expect(html("| Metric | Value |\n| :--- | ---: |\n| Users | 1 200 |\n| A \\| B | `x|y` |")).toBe(
      '<table role="presentation" cellpadding="0" cellspacing="0"><thead><tr><th>Metric</th><th>Value</th></tr></thead><tbody><tr><td>Users</td><td>1 200</td></tr><tr><td>A | B</td><td><code>x|y</code></td></tr></tbody></table>',
    );
  });

  it("renders quotes", () => {
    expect(html("> quoted *text*\n> more")).toBe("<blockquote><p>quoted <em>text</em><br>more</p></blockquote>");
  });

  it("stays fast on hostile input", () => {
    const inputs = ["[a](".repeat(25_000), "**[`_".repeat(20_000), "*a ".repeat(33_000), "> ".repeat(50_000), "[".repeat(100_000), "`".repeat(100_000), "[a](<".repeat(20_000)];
    const start = Date.now();
    for (const input of inputs) markdownToHtml(input);
    expect(Date.now() - start).toBeLessThan(2000);
    const deep = Array.from({ length: 200 }, (_, k) => `${"  ".repeat(k)}- x`).join("\n");
    expect(() => markdownToHtml(deep)).not.toThrow();
  });
});

describe("plain text part", () => {
  it("drops the markup and writes links as text and address", () => {
    const text = markdownToText("# Weekly\n\nSignups are **up**, see [the dashboard](https://example.com/d).\n\n- one\n  - two\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```\ncode\n```");
    expect(text).toBe("Weekly\n======\n\nSignups are up, see the dashboard (https://example.com/d).\n\n- one\n  - two\n\nA | B\n1 | 2\n\n    code");
  });

  it("leaves out unsafe link targets", () => {
    expect(markdownToText("[click](javascript:alert(1))")).toBe("click");
  });
});

describe("renderEmail", () => {
  it("wraps the report with the organisation's name and the footer, in both parts", () => {
    const { html: page, text } = renderEmail({ subject: "Weekly <report>", markdown: "Hello **team**", orgName: "Acme & Co", senderName: "Pointer" });
    expect(page).toMatch(/^<!doctype html>/);
    expect(page).toContain("<title>Weekly &lt;report&gt;</title>");
    expect(page).toContain(">Acme &amp; Co</td>");
    expect(page).toContain("<strong>team</strong>");
    expect(page).toContain("Sent by Pointer for Acme &amp; Co.");
    expect(text).toBe("Hello team\n\n--\nSent by Pointer for Acme & Co.\n");
  });

  it("names Pointer at the top when there is no organisation name", () => {
    const { html: page, text } = renderEmail({ subject: "s", markdown: "x", orgName: "", senderName: "Scout" });
    expect(page).toContain(">Scout</td>");
    expect(text.endsWith("--\nSent by Scout.\n")).toBe(true);
  });
});
