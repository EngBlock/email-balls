import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { InlinePart } from "../lib/imap";
import { buildDocument } from "../lib/emailSanitizer";
import styles from "./EmailHtmlFrame.module.css";

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
      if (!doc) {
        console.warn(
          "[EmailHtmlFrame] iframe load fired but contentDocument is null — sandbox is missing allow-same-origin?",
        );
        return;
      }
      console.debug("[EmailHtmlFrame] binding click handler", {
        readyState: doc.readyState,
      });

      const measure = () => {
        if (cancelled) return;
        // Cap at 50000px so a runaway document can't blow up layout,
        // but generous enough that real-world long marketing emails
        // and threaded replies aren't clipped.
        const next = Math.min(50000, doc.documentElement.scrollHeight);
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

      // Capture-phase handlers route every link click through Tauri's
      // opener so the system browser owns the navigation. Without this,
      // an `<a href>` click in the sandboxed iframe would either try to
      // navigate the (networkless) iframe or — with target="_blank" or
      // similar — request a popup that the Tauri WebView silently
      // swallows. We bind on both `mousedown` and `click` because some
      // WebKit builds initiate the popup attempt on mousedown, which
      // races a click-only handler.
      const onLinkActivation = (event: Event) => {
        const target = (event.target as Element | null)?.closest("a");
        if (!target) return;
        // Real href is parked on data-href during sanitize so the
        // <a> can't navigate the iframe even if the click handler
        // races a Tauri-WebView popup fallback. See sanitize().
        const href = target.getAttribute("data-href");
        console.debug("[EmailHtmlFrame] link activation", {
          type: event.type,
          href,
        });
        event.preventDefault();
        if (!href) return;
        if (/^(?:https?|mailto|tel):/i.test(href)) {
          openUrl(href).catch((err) => {
            console.error("[EmailHtmlFrame] openUrl failed:", href, err);
          });
        }
      };
      doc.addEventListener("click", onLinkActivation, true);
      doc.addEventListener("auxclick", onLinkActivation, true);
    };

    iframe.addEventListener("load", onLoad);
    // srcdoc documents load synchronously: by the time this effect
    // runs the iframe's load event may already have fired, leaving
    // our click handler unbound (so links would silently do nothing).
    // If contentDocument is already complete, call onLoad now; the
    // listener stays in place for any subsequent reload.
    if (iframe.contentDocument?.readyState === "complete") {
      onLoad();
    }
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
      className={styles.frame}
      style={{ height }}
    />
  );
}


