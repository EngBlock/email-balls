import { Drawer } from "./Drawer";
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

export function EmailBodyDrawer({ body, loading = false, onClose }: Props) {
  const fromLabel = body.from
    .map((a) => a.name ?? `${a.mailbox ?? ""}@${a.host ?? ""}`)
    .filter((s) => s && s !== "@")
    .join(", ");
  const hasContent = body.textBody !== null || body.htmlBody !== null;

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
      ) : (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            margin: 0,
            padding: "12px 18px",
            fontFamily: "inherit",
            fontSize: 13,
            lineHeight: 1.5,
            color: "rgba(255, 255, 255, 0.9)",
          }}
        >
          {body.textBody ?? body.htmlBody ?? "(no body)"}
        </pre>
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
