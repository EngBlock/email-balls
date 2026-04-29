import { AnimatePresence } from "framer-motion";

import { EmailListDrawer } from "./EmailListDrawer";
import { EmailBodyDrawer, EMAIL_BODY_DRAWER_WIDTH } from "./EmailBodyDrawer";
import { senderEmail, type EmailEnvelope } from "../lib/imap";
import { useAppStore } from "../store";

/**
 * Both stacked drawers wrapped in a single <AnimatePresence>, plus the
 * handlers that mediate between them and the store. Lives at this level
 * so it re-renders only when drawer state changes — the bubble layer
 * sibling is untouched.
 */
export function DrawersLayer() {
  const account = useAppStore((s) => s.account);
  const activeSender = useAppStore((s) => s.activeSender);
  const emails = useAppStore((s) => s.emails);
  const emailsLoading = useAppStore((s) => s.emailsLoading);
  const body = useAppStore((s) => s.body);
  const bodyLoading = useAppStore((s) => s.bodyLoading);

  const loadBody = useAppStore((s) => s.loadBody);
  const decrementUnread = useAppStore((s) => s.decrementUnread);
  const clearActiveSender = useAppStore((s) => s.clearActiveSender);
  const clearEmails = useAppStore((s) => s.clearEmails);
  const closeBody = useAppStore((s) => s.closeBody);

  function onPickEmail(env: EmailEnvelope) {
    if (!account) return;
    loadBody(account, env);
    if (!env.flags.includes("\\Seen") && activeSender) {
      decrementUnread(senderEmail(activeSender).toLowerCase());
    }
  }

  function closeListDrawer() {
    clearActiveSender();
    clearEmails();
    closeBody();
  }

  return (
    <AnimatePresence>
      {activeSender && (
        <EmailListDrawer
          key="email-list"
          sender={activeSender}
          emails={emails}
          loading={emailsLoading}
          bodyOpen={body !== null}
          bodyDrawerWidth={EMAIL_BODY_DRAWER_WIDTH}
          onPickEmail={onPickEmail}
          onClose={closeListDrawer}
        />
      )}
      {body && (
        <EmailBodyDrawer
          key="email-body"
          body={body}
          loading={bodyLoading}
          onClose={closeBody}
        />
      )}
    </AnimatePresence>
  );
}
