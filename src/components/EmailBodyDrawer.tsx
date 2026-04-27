import { useMemo, useState } from "react";
import { Drawer } from "./Drawer";
import { EmailHtmlFrame } from "./EmailHtmlFrame";
import { EmailTextBody } from "./EmailTextBody";
import type { EmailBody } from "../lib/imap";

export const EMAIL_BODY_DRAWER_WIDTH = Math.min(
  560,
  Math.round(window.innerWidth * 0.6),
);

interface Props {
  body: EmailBody;
  /** True while the body content is still being fetched. The header
   *  (subject, from, date) renders immediately from the envelope; the
   *  body area shows a loading indicator until the fetch returns. */
  loading?: boolean;
  onClose: () => void;
}

// Cheap test for "this HTML body references remote images" — used only
// to decide whether the Show-images button is meaningful for this
// message. Conservative: a false positive just shows the button on a
// message where it does nothing, which is harmless.
const REMOTE_IMG_REGEX = /<img[^>]+src\s*=\s*["']?https?:/i;

export function EmailBodyDrawer({ body, loading = false, onClose }: Props) {
  const fromLabel = body.from
    .map((a) => a.name ?? `${a.mailbox ?? ""}@${a.host ?? ""}`)
    .filter((s) => s && s !== "@")
    .join(", ");
  const hasContent = body.textBody !== null || body.htmlBody !== null;

  const [showRemoteImages, setShowRemoteImages] = useState(false);

  const showImagesButtonVisible = useMemo(
    () => Boolean(body.htmlBody && REMOTE_IMG_REGEX.test(body.htmlBody)),
    [body.htmlBody],
  );

  return (
    <Drawer
      width={EMAIL_BODY_DRAWER_WIDTH}
      zIndex={30}
      onClose={onClose}
      header={
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 15,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {body.subject ?? "(no subject)"}
          </div>
          <div style={{ fontSize: 12, opacity: 0.65, marginTop: 2 }}>
            {fromLabel}
            {body.date && <> · {body.date}</>}
          </div>
        </div>
      }
    >
      {loading && !hasContent ? (
        <div
          style={{
            padding: "16px 18px",
            fontSize: 13,
            opacity: 0.55,
            fontStyle: "italic",
          }}
        >
          Loading message…
        </div>
      ) : body.htmlBody ? (
        <>
          {showImagesButtonVisible && !showRemoteImages && (
            <div
              style={{
                padding: "8px 18px",
                fontSize: 12,
                background: "rgba(255, 255, 255, 0.04)",
                borderBottom: "1px solid rgba(255, 255, 255, 0.06)",
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <span style={{ opacity: 0.7 }}>
                Remote images blocked to protect privacy
              </span>
              <button
                type="button"
                onClick={() => setShowRemoteImages(true)}
                style={{
                  marginLeft: "auto",
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: 6,
                  border: "1px solid rgba(255, 255, 255, 0.18)",
                  background: "transparent",
                  color: "white",
                  cursor: "pointer",
                }}
              >
                Show images
              </button>
            </div>
          )}
          <div style={{ padding: "0 4px" }}>
            <EmailHtmlFrame
              html={body.htmlBody}
              inlineParts={body.inlineParts}
              showRemoteImages={showRemoteImages}
            />
          </div>
        </>
      ) : body.textBody ? (
        <EmailTextBody text={body.textBody} />
      ) : (
        <div
          style={{
            padding: "16px 18px",
            fontSize: 13,
            opacity: 0.55,
            fontStyle: "italic",
          }}
        >
          (no body)
        </div>
      )}
      {body.attachments.length > 0 && (
        <ul
          style={{
            listStyle: "none",
            margin: 0,
            padding: "12px 18px",
            borderTop: "1px solid rgba(255, 255, 255, 0.08)",
          }}
        >
          {body.attachments.map((a, i) => (
            <li
              key={i}
              style={{
                fontSize: 12,
                opacity: 0.75,
                padding: "4px 0",
              }}
            >
              {a.filename ?? "(unnamed)"} · {a.contentType} · {a.size} bytes
            </li>
          ))}
        </ul>
      )}
    </Drawer>
  );
}
