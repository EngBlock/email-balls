// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitize, collapseQuotes } from "./EmailHtmlFrame";

describe("sanitize", () => {
  it("rewrites cid: src to data: URL when a matching inline part exists", () => {
    const cidMap = new Map<string, string>([
      ["logo@host", "data:image/png;base64,AAA="],
    ]);
    const out = sanitize('<p><img src="cid:logo@host"></p>', cidMap);
    expect(out).toContain('data:image/png;base64,AAA=');
    expect(out.toLowerCase()).not.toContain("cid:");
  });

  it("drops cid: src when no matching inline part", () => {
    const out = sanitize(
      '<p><img src="cid:missing@host"></p>',
      new Map(),
    );
    // Attribute is removed; the <img> tag (or its replacement) must
    // not carry a cid: reference into the sandboxed document.
    expect(out.toLowerCase()).not.toContain("cid:");
  });

  it("strips <script> tags entirely", () => {
    const out = sanitize(
      '<p>hi</p><script>alert(1)</script>',
      new Map(),
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toContain("alert(1)");
  });

  it("strips inline event handlers", () => {
    const out = sanitize('<a href="https://example.com" onclick="alert(1)">x</a>', new Map());
    expect(out).not.toMatch(/onclick/i);
  });

  it("preserves inline styles (email HTML relies on them)", () => {
    const out = sanitize(
      '<p style="color: red; font-size: 18px">hi</p>',
      new Map(),
    );
    expect(out).toMatch(/style="[^"]*color:\s*red/i);
  });

  it("parks <a href> on data-href and replaces href with '#'", () => {
    const out = sanitize(
      '<a href="https://example.com/x">click</a>',
      new Map(),
    );
    expect(out).toContain('data-href="https://example.com/x"');
    expect(out).toMatch(/href="#"/);
    // The original https URL must not survive as a navigable href —
    // otherwise the iframe could navigate before our click handler
    // routes the click through the system browser. (The data-href
    // assertion above carries the URL; this rules out a *navigable*
    // href, which would not be preceded by "data-".)
    expect(out).not.toMatch(/(?<!data-)href="https:\/\/example\.com\/x"/);
  });

  it("rewrites mailto: hrefs the same way", () => {
    const out = sanitize('<a href="mailto:a@b.com">x</a>', new Map());
    expect(out).toContain('data-href="mailto:a@b.com"');
    expect(out).toMatch(/href="#"/);
  });

  it("strips target attribute so target=_blank can't trigger a Tauri popup", () => {
    const out = sanitize(
      '<a href="https://example.com" target="_blank">x</a>',
      new Map(),
    );
    expect(out).not.toMatch(/target=/i);
  });
});

describe("collapseQuotes", () => {
  it("wraps Apple Mail blockquote[type=cite] in <details>", () => {
    const html =
      '<p>my reply</p><blockquote type="cite">old message</blockquote>';
    const out = collapseQuotes(html);
    expect(out).toMatch(/<details class="email-quote">/);
    expect(out).toMatch(/<summary>Show quoted text<\/summary>/);
    expect(out).toContain("<blockquote");
    expect(out).toContain("old message");
    // The reply itself stays outside the <details>.
    const replyIdx = out.indexOf("my reply");
    const detailsIdx = out.indexOf("<details");
    expect(replyIdx).toBeGreaterThanOrEqual(0);
    expect(replyIdx).toBeLessThan(detailsIdx);
  });

  it("wraps Gmail .gmail_quote in <details>", () => {
    const html = '<p>reply</p><div class="gmail_quote">prior thread</div>';
    const out = collapseQuotes(html);
    expect(out).toMatch(/<details class="email-quote">/);
    expect(out).toContain("prior thread");
  });

  it("wraps Outlook reply divider and following siblings", () => {
    const html =
      '<p>my reply</p>' +
      '<div id="divRplyFwdMsg">From: …</div>' +
      '<p>quoted line 1</p>' +
      '<p>quoted line 2</p>';
    const out = collapseQuotes(html);
    expect(out).toMatch(/<details class="email-quote">/);
    // The divider and both trailing siblings must be inside the
    // collapsed block, otherwise the visible message will still
    // include "quoted line 2".
    const detailsBlock = out.slice(out.indexOf("<details"));
    expect(detailsBlock).toContain("divRplyFwdMsg");
    expect(detailsBlock).toContain("quoted line 1");
    expect(detailsBlock).toContain("quoted line 2");
  });

  it("leaves plain HTML unchanged when no quote markers are present", () => {
    const html = "<p>hello</p><p>world</p>";
    expect(collapseQuotes(html)).toBe(html);
  });
});
