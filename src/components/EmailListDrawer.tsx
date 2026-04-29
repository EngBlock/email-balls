import { useEffect, useState } from "react";

import styles from "./EmailListDrawer.module.css";
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
        <div className={styles.headerRow}>
          <div
            className={styles.avatar}
            style={{
              backgroundColor: color,
              backgroundImage: avatar ? `url(${avatar})` : "none",
            }}
          />
          <div className={styles.headerMeta}>
            <div className={styles.label}>
              {label}
            </div>
            <div className={styles.email}>
              {email}
            </div>
          </div>
        </div>
      }
    >
      {loading && emails.length === 0 ? (
        <div className={styles.emptyState}>
          Loading messages…
        </div>
      ) : emails.length === 0 ? (
        <div className={styles.emptyState}>
          No messages.
        </div>
      ) : (
        <ul className={styles.emailList}>
          {emails.map((env) => {
            const unread = !env.flags.includes("\\Seen");
            return (
            <li key={env.uid}>
              <button
                type="button"
                onClick={() => onPickEmail(env)}
                className={styles.emailRow}
              >
                <div
                  aria-hidden
                  className={styles.unreadDot}
                  style={{
                    background: unread ? "#4d9dff" : "transparent",
                  }}
                />
                <div className={styles.emailRowContent}>
                  <div
                    className={styles.subject}
                    style={{
                      fontWeight: unread ? 700 : 500,
                      opacity: unread ? 1 : 0.78,
                    }}
                  >
                    {env.subject ?? "(no subject)"}
                  </div>
                  {env.date && (
                    <div className={styles.date}>
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
