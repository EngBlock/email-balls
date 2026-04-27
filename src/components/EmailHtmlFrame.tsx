import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { InlinePart } from "../lib/imap";

interface Props {
  html: string;
  inlineParts: InlinePart[];
  /** When false, the CSP blocks any `https:` image load so tracking pixels
   *  and remote artwork stay dormant until the user opts in. cid: and
   *  data: images always render — they're inline content the sender
   *  packaged with the message and aren't a tracking signal. */
  showRemoteImages: boolean;
}

/** Wraps email HTML for safe rendering inside a sandboxed iframe.
 *  Pipeline:
 *    1. DOMPurify sanitises the email's body HTML (strip scripts, forms,
 *       etc.) and a hook rewrites `cid:` image URLs to `data:` URLs
 *       using {@link InlinePart} bytes shipped from the backend.
 *    2. A post-sanitize DOM walk wraps known reply-quote markers
 *       (<blockquote type=cite>, .gmail_quote, Outlook signatures) in
 *       <details> so the visible message starts at the latest reply.
 *    3. We assemble a full document with a strict CSP <meta> (default-src
 *       none, img-src cid+data only by default) and base styling.
 *    4. The document is fed to an `srcdoc` iframe with `sandbox` that
 *       omits `allow-scripts` and `allow-forms`. We do enable
 *       `allow-same-origin` so the parent can measure scrollHeight and
 *       intercept link clicks — safe because no JS runs in the iframe.
 *
 *  The iframe height tracks `documentElement.scrollHeight` via a
 *  ResizeObserver so multi-screen marketing emails render in a single
 *  scrollable surface (the surrounding drawer scrolls, not the iframe). */
export function EmailHtmlFrame({ html, inlineParts, showRemoteImages }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(80);

  const cidMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of inlineParts) {
      m.set(p.contentId, `data:${p.contentType};base64,${p.dataBase64}`);
    }
    return m;
  }, [inlineParts]);

  const srcdoc = useMemo(
    () => buildDocument(html, cidMap, showRemoteImages),
    [html, cidMap, showRemoteImages],
  );

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let observer: ResizeObserver | null = null;
    let cancelled = false;

    const onLoad = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;

      const measure = () => {
        if (cancelled) return;
        // Cap at 8000px so a runaway document doesn't push the layout
        // into territory where the parent scroll container chokes.
        const next = Math.min(8000, doc.documentElement.scrollHeight);
        setHeight((prev) => (Math.abs(prev - next) > 1 ? next : prev));
      };

      measure();
      // Re-measure on image loads — many emails ship without explicit
      // image dimensions, so the body height jumps after each <img> load.
      doc.querySelectorAll("img").forEach((img) => {
        img.addEventListener("load", measure, { once: true });
        img.addEventListener("error", measure, { once: true });
      });

      observer = new ResizeObserver(measure);
      observer.observe(doc.documentElement);

      // Capture-phase click handler so links open in the system browser
      // via Tauri's opener plugin instead of trying to navigate the
      // (sandboxed, networkless) iframe. mailto:/tel: are handed off
      // identically — the OS picks the right handler.
      doc.addEventListener(
        "click",
        (event) => {
          const target = (event.target as Element | null)?.closest("a");
          if (!target) return;
          const href = target.getAttribute("href");
          if (!href) return;
          event.preventDefault();
          if (/^(?:https?|mailto|tel):/i.test(href)) {
            void openUrl(href);
          }
        },
        true,
      );
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      cancelled = true;
      iframe.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [srcdoc]);

  return (
    <iframe
      ref={iframeRef}
      title="Email body"
      srcDoc={srcdoc}
      // No allow-scripts (no JS), no allow-forms (no POSTs), no
      // allow-top-navigation (the iframe can't redirect the app shell).
      // allow-same-origin is intentional: it lets the parent measure
      // scrollHeight and bind a click listener; safe because scripts
      // can't run in the iframe to abuse the same-origin window.
      sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
      style={{
        width: "100%",
        height,
        border: 0,
        background: "#ffffff",
        colorScheme: "light",
        display: "block",
      }}
    />
  );
}

function buildDocument(
  rawHtml: string,
  cidMap: Map<string, string>,
  showRemoteImages: boolean,
): string {
  const sanitized = sanitize(rawHtml, cidMap);
  const collapsed = collapseQuotes(sanitized);
  const csp = buildCsp(showRemoteImages);
  const baseStyles = `
    html, body { margin: 0; padding: 12px 16px; background: #ffffff;
      color: #1a1a1a; font: 14px/1.5 -apple-system, BlinkMacSystemFont,
      "Segoe UI", Roboto, sans-serif; word-wrap: break-word;
      overflow-wrap: anywhere; }
    img { max-width: 100%; height: auto; }
    table { max-width: 100%; }
    a { color: #0a66c2; }
    blockquote { margin: 0 0 0 12px; padding-left: 12px;
      border-left: 3px solid rgba(0, 0, 0, 0.12); color: #4a4a4a; }
    details.email-quote { margin-top: 12px; }
    details.email-quote > summary { cursor: pointer; font-size: 12px;
      color: #5a5a5a; padding: 4px 0; list-style: none; user-select: none; }
    details.email-quote > summary::before { content: "··· "; opacity: 0.6; }
  `;
  // <base target="_blank"> is a defensive default in case our click
  // listener fails to bind; the iframe sandbox still blocks navigation
  // within the iframe regardless. The CSP <meta> is the load-bearing
  // remote-content gate.
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<base target="_blank">
<style>${baseStyles}</style>
</head><body>${collapsed}</body></html>`;
}

function buildCsp(showRemoteImages: boolean): string {
  // default-src 'none' as the floor; we then opt specific resource
  // classes back in. style-src needs 'unsafe-inline' because email
  // HTML is almost entirely inline styles. Fonts are restricted to
  // data: URIs — webfonts from third parties leak the open event.
  const imgSrc = showRemoteImages
    ? "data: https:"
    : "data:";
  return [
    "default-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'unsafe-inline'",
    "font-src data:",
    "frame-ancestors 'none'",
  ].join("; ");
}

const SAFE_URI_REGEXP = /^(?:https?|mailto|tel|cid|data):/i;

export function sanitize(rawHtml: string, cidMap: Map<string, string>): string {
  // DOMPurify in JSDOM/browser environments. Hook rewrites cid: URLs
  // (in src and background) to data: URLs from cidMap. Removed when
  // sanitize completes so other DOMPurify calls in the app aren't
  // affected.
  const hook = (node: Element, data: { attrName: string; attrValue: string }) => {
    if (data.attrName !== "src" && data.attrName !== "background") return;
    const value = data.attrValue.trim();
    if (!value.toLowerCase().startsWith("cid:")) return;
    const cid = value.slice(4).replace(/^<|>$/g, "");
    const dataUrl = cidMap.get(cid);
    if (dataUrl) {
      data.attrValue = dataUrl;
    } else {
      // No matching inline part — drop the attribute so the iframe
      // doesn't try to fetch `cid:foo` (which the CSP would block but
      // generates a console warning per image).
      node.removeAttribute(data.attrName);
      data.attrValue = "";
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
