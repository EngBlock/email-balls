import DOMPurify from "dompurify";

// Accepts the schemes we render (https/mailto/tel/cid/data) plus a bare
// `#` so our inert href="#" rewriting (see hook in sanitize()) is
// retained — that keeps `<a>` styled as a link in WebKit.
const SAFE_URI_REGEXP = /^(?:(?:https?|mailto|tel|cid|data):|#)/i;

export function sanitize(rawHtml: string, cidMap: Map<string, string>): string {
  // DOMPurify in JSDOM/browser environments. Hook rewrites cid: URLs
  // (in src and background) to data: URLs from cidMap. Removed when
  // sanitize completes so other DOMPurify calls in the app aren't
  // affected.
  const hook = (node: Element, data: { attrName: string; attrValue: string }) => {
    // 1. Rewrite cid: src/background to data: URLs from cidMap.
    if (data.attrName === "src" || data.attrName === "background") {
      const value = data.attrValue.trim();
      if (value.toLowerCase().startsWith("cid:")) {
        const cid = value.slice(4).replace(/^<|>$/g, "");
        const dataUrl = cidMap.get(cid);
        if (dataUrl) {
          data.attrValue = dataUrl;
        } else {
          // No matching inline part — drop the attribute so the iframe
          // doesn't try to fetch `cid:foo` (which the CSP would block
          // but generates a console warning per image).
          node.removeAttribute(data.attrName);
          data.attrValue = "";
        }
      }
      return;
    }

    // 2. Neutralise <a href>: park the real URL on data-href and
    //    replace href with "#". Without this, Tauri's WebView can
    //    react to a target=_blank popup attempt by navigating the
    //    iframe itself before our parent click handler manages to
    //    preventDefault. With href="#", the link physically cannot
    //    navigate; the handler reads data-href and routes the URL
    //    through plugin-opener.
    if (
      data.attrName === "href" &&
      node.tagName === "A" &&
      /^(?:https?|mailto|tel):/i.test(data.attrValue)
    ) {
      node.setAttribute("data-href", data.attrValue);
      data.attrValue = "#";
      return;
    }

    // 3. Strip `target` so the WebView never tries to open a popup
    //    Tauri can't honour. Belt-and-suspenders given href="#" is
    //    already inert.
    if (data.attrName === "target") {
      node.removeAttribute("target");
      data.attrValue = "";
      return;
    }
  };

  DOMPurify.addHook("uponSanitizeAttribute", hook);
  try {
    return DOMPurify.sanitize(rawHtml, {
      WHOLE_DOCUMENT: false,
      ADD_TAGS: ["style"],
      FORBID_TAGS: [
        "script",
        "iframe",
        "object",
        "embed",
        "form",
        "meta",
        "link",
        "base",
      ],
      FORBID_ATTR: ["srcset"],
      ALLOWED_URI_REGEXP: SAFE_URI_REGEXP,
    }) as string;
  } finally {
    DOMPurify.removeHook("uponSanitizeAttribute");
  }
}

/** Wrap reply-quote markers in `<details class="email-quote">` so the
 *  visible message starts at the latest reply. We match the patterns
 *  produced by the major MUAs:
 *    - `blockquote[type="cite"]` (Apple Mail, most clients)
 *    - `.gmail_quote` (Gmail web)
 *    - `#divRplyFwdMsg` plus the following Outlook-on-Windows divider
 *    - "On … wrote:" attribution paragraphs (catch-all heuristic) */
export function collapseQuotes(sanitizedHtml: string): string {
  if (typeof document === "undefined") return sanitizedHtml;
  const container = document.createElement("div");
  container.innerHTML = sanitizedHtml;

  const collapse = (el: Element) => {
    if (el.closest("details.email-quote")) return; // already wrapped
    const details = document.createElement("details");
    details.className = "email-quote";
    const summary = document.createElement("summary");
    summary.textContent = "Show quoted text";
    details.appendChild(summary);
    el.replaceWith(details);
    details.appendChild(el);
  };

  // Apple Mail / generic "cited" blockquotes.
  container
    .querySelectorAll<HTMLElement>('blockquote[type="cite"]')
    .forEach(collapse);

  // Gmail.
  container.querySelectorAll<HTMLElement>(".gmail_quote").forEach(collapse);

  // Outlook on Windows: the reply divider is a div with id divRplyFwdMsg
  // OR a div whose inline style contains border-top:solid (the standard
  // Outlook reply separator). We collapse from that node onward by
  // wrapping it plus its following siblings in a single <details>.
  const outlookMarker = container.querySelector<HTMLElement>(
    '#divRplyFwdMsg, div[style*="border-top:solid"]',
  );
  if (outlookMarker && !outlookMarker.closest("details.email-quote")) {
    const details = document.createElement("details");
    details.className = "email-quote";
    const summary = document.createElement("summary");
    summary.textContent = "Show quoted text";
    details.appendChild(summary);
    const parent = outlookMarker.parentNode;
    if (parent) {
      const tail: ChildNode[] = [];
      let cursor: ChildNode | null = outlookMarker;
      while (cursor) {
        const next: ChildNode | null = cursor.nextSibling;
        tail.push(cursor);
        cursor = next;
      }
      parent.insertBefore(details, tail[0]);
      for (const node of tail) details.appendChild(node);
    }
  }

  return container.innerHTML;
}

export function buildCsp(showRemoteImages: boolean): string {
  // default-src 'none' as the floor; we then opt specific resource
  // classes back in. style-src needs 'unsafe-inline' because email
  // HTML is almost entirely inline styles. Fonts are restricted to
  // data: URIs — webfonts from third parties leak the open event.
  const imgSrc = showRemoteImages
    ? "data: https:"
    : "data:";
  // frame-ancestors is intentionally omitted here: WebKit logs a noisy
  // warning that the directive is ignored when delivered via <meta>.
  // The iframe sandbox already prevents the document from being framed
  // by anything other than its own iframe, so this directive would only
  // be cosmetic anyway.
  return [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
  ].join("; ");
}

export function buildDocument(
  rawHtml: string,
  cidMap: Map<string, string>,
  showRemoteImages: boolean,
): string {
  const sanitized = sanitize(rawHtml, cidMap);
  const collapsed = collapseQuotes(sanitized);
  const csp = buildCsp(showRemoteImages);
  // overflow-y: hidden on html+body suppresses the iframe's own
  // vertical scrollbar — the surrounding drawer is the only vertical
  // scroll surface, and we size the iframe to documentElement
  // scrollHeight so nothing should ever be clipped vertically.
  // overflow-x stays default so wide marketing tables and big inline
  // images keep their horizontal scrollbar inside the iframe instead
  // of squashing or breaking layout. The body's padding-bottom leaves
  // room so the horizontal scrollbar doesn't sit on top of content.
  const baseStyles = `
    html, body { margin: 0; padding: 12px 16px; background: #ffffff;
      color: #1a1a1a; font: 14px/1.5 -apple-system, BlinkMacSystemFont,
      "Segoe UI", Roboto, sans-serif; word-wrap: break-word;
      overflow-wrap: anywhere; overflow-y: hidden; }
    body { padding-bottom: 28px; }
    img { max-width: 100%; height: auto; }
    a { color: #0a66c2; }
    blockquote { margin: 0 0 0 12px; padding-left: 12px;
      border-left: 3px solid rgba(0, 0, 0, 0.12); color: #4a4a4a; }
    details.email-quote { margin-top: 12px; }
    details.email-quote > summary { cursor: pointer; font-size: 12px;
      color: #5a5a5a; padding: 4px 0; list-style: none; user-select: none; }
    details.email-quote > summary::before { content: "··· "; opacity: 0.6; }
  `;
  // No <base target="_blank">: with target=_blank the WebView tries to
  // spawn a popup which Tauri silently swallows, racing our parent-side
  // click handler. We rely solely on the capture-phase listener in the
  // parent (see useEffect) to route links through plugin-opener.
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>${baseStyles}</style>
</head><body>${collapsed}</body></html>`;
}
