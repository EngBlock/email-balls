import { useEffect, useState } from "react";

import { Drawer } from "./Drawer";
import { resolveAvatarForSender } from "../lib/avatar";
import { hashColor } from "../lib/gravatar";
import {
  senderEmail,
  senderLabel,
  type EmailEnvelope,
  type SenderSummary,
} from "../lib/imap";

export const EMAIL_LIST_DRAWER_WIDTH = Math.min(
  380,
  Math.round(window.innerWidth * 0.36),
);

interface Props {
  sender: SenderSummary;
  emails: EmailEnvelope[];
  loading: boolean;
  bodyOpen: boolean;
  bodyDrawerWidth: number;
  onPickEmail: (e: EmailEnvelope) => void;
  onClose: () => void;
}

export function EmailListDrawer({
  sender,
  emails,
  loading,
  bodyOpen,
  bodyDrawerWidth,
  onPickEmail,
  onClose,
}: Props) {
  const [avatar, setAvatar] = useState<string | null>(null);
  const email = senderEmail(sender);
  const label = senderLabel(sender);
  const color = hashColor(email.toLowerCase());

  // One-shot avatar fetch on mount / sender change. The resolver itself
  // dedupes via its in-memory domain cache + Rust disk cache, so a
  // re-open of the same sender doesn't re-hit the network.
  useEffect(() => {
    let cancelled = false;
    resolveAvatarForSender(sender).then((r) => {
      if (!cancelled) setAvatar(r.url);
    });
    return () => {
      cancelled = true;
    };
  }, [sender]);

  return (
    <Drawer
      width={EMAIL_LIST_DRAWER_WIDTH}
      x={bodyOpen ? -bodyDrawerWidth : 0}
      zIndex={20}
      onClose={onClose}
      header={
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div
            style={{
              flex: "none",
              width: 44,
              height: 44,
              borderRadius: "50%",
              backgroundColor: color,
              backgroundImage: avatar ? `url(${avatar})` : "none",
              backgroundSize: "cover",
              backgroundPosition: "center",
              border: "1px solid rgba(255, 255, 255, 0.18)",
            }}
          />
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
              {label}
            </div>
            <div
              style={{
                fontSize: 12,
                opacity: 0.65,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {email}
            </div>
          </div>
        </div>
      }
    >
      {loading && emails.length === 0 ? (
        <div style={{ padding: "16px 18px", opacity: 0.6, fontSize: 13 }}>
          Loading messages…
        </div>
      ) : emails.length === 0 ? (
        <div style={{ padding: "16px 18px", opacity: 0.6, fontSize: 13 }}>
          No messages.
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {emails.map((env) => {
            const unread = !env.flags.includes("\\Seen");
            return (
            <li key={env.uid}>
              <button
                type="button"
                onClick={() => onPickEmail(env)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                  padding: "10px 18px",
                  background: "transparent",
                  border: "none",
                  borderBottom: "1px solid rgba(255, 255, 255, 0.04)",
                  color: "white",
                  cursor: "pointer",
                  borderRadius: 0,
                  boxShadow: "none",
                }}
              >
                <div
                  aria-hidden
                  style={{
                    flex: "none",
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: unread ? "#4d9dff" : "transparent",
                  }}
                />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: unread ? 700 : 500,
                      opacity: unread ? 1 : 0.78,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {env.subject ?? "(no subject)"}
                  </div>
                  {env.date && (
                    <div
                      style={{
                        fontSize: 11,
                        opacity: 0.55,
                        marginTop: 2,
                      }}
                    >
                      {env.date}
                    </div>
                  )}
                </div>
              </button>
            </li>
            );
          })}
        </ul>
      )}
    </Drawer>
  );
}
