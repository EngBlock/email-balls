import { useCallback, useEffect, useRef } from "react";
import { AnimatePresence } from "framer-motion";
import "./App.css";
import styles from "./App.module.css";
import { senderEmail, type EmailEnvelope, type SenderSummary } from "./lib/imap";
import { SenderBubbles } from "./components/SenderBubbles";
import { EmailListDrawer } from "./components/EmailListDrawer";
import {
  EmailBodyDrawer,
  EMAIL_BODY_DRAWER_WIDTH,
} from "./components/EmailBodyDrawer";
import { useAppStore } from "./store";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { useImapEventBridge } from "./hooks/useImapEventBridge";
import { useImapIdleLifecycle } from "./hooks/useImapIdleLifecycle";

function App() {
  // ── Store selectors (granular to minimise re-render scope) ────────
  const form = useAppStore((s) => s.form);
  const account = useAppStore((s) => s.account);
  const stage = useAppStore((s) => s.stage);
  const hasSavedAccount = useAppStore((s) => s.hasSavedAccount);
  const senders = useAppStore((s) => s.senders);
  const activeSender = useAppStore((s) => s.activeSender);
  const emails = useAppStore((s) => s.emails);
  const body = useAppStore((s) => s.body);
  const bodyLoading = useAppStore((s) => s.bodyLoading);
  const sendersLoading = useAppStore((s) => s.sendersLoading);
  const emailsLoading = useAppStore((s) => s.emailsLoading);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const unreadOnly = useAppStore((s) => s.unreadOnly);
  // Top-level error banner: show whichever slice reported a problem.
  const error = useAppStore(
    (s) => s.error ?? s.sendersError ?? s.emailsError,
  );

  // ── Store actions ─────────────────────────────────────────────────
  const setForm = useAppStore((s) => s.setForm);
  const setAccount = useAppStore((s) => s.setAccount);
  const setStage = useAppStore((s) => s.setStage);
  const buildAccountFromForm = useAppStore((s) => s.buildAccountFromForm);
  const persistCredentials = useAppStore((s) => s.persistCredentials);
  const signOut = useAppStore((s) => s.signOut);
  const loadSenders = useAppStore((s) => s.loadSenders);
  const pickSender = useAppStore((s) => s.pickSender);
  const clearActiveSender = useAppStore((s) => s.clearActiveSender);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const setUnreadOnly = useAppStore((s) => s.setUnreadOnly);
  const decrementUnread = useAppStore((s) => s.decrementUnread);
  const loadEmailsForSender = useAppStore((s) => s.loadEmailsForSender);
  const loadBody = useAppStore((s) => s.loadBody);
  const closeBody = useAppStore((s) => s.closeBody);
  const clearEmails = useAppStore((s) => s.clearEmails);
  const clearError = useAppStore((s) => s.clearError);

  // ── Local refs (non-render coordination / DOM access) ────────────
  const autoTriedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // ── Extracted hooks ────────────────────────────────────────────────
  useImapIdleLifecycle();
  useImapEventBridge();
  useGlobalShortcuts({ searchInputRef });

  // ── Handlers ──────────────────────────────────────────────────────

  /** Sign in: build AccountConn from the form, stream senders, persist
   *  credentials on success. Replaces the old onLoadSenders + inline
   *  buildAccount + local useState orchestration. */
  async function onLoadSenders() {
    const acc = buildAccountFromForm();
    setAccount(acc);
    clearError();
    setStage("senders");
    await loadSenders(acc, 5000);
    // Only persist if the sender scan succeeded (no sendersError).
    const { sendersError } = useAppStore.getState();
    if (!sendersError) {
      persistCredentials(form);
    }
  }

  // Auto-login on mount if credentials are saved.
  useEffect(() => {
    if (autoTriedRef.current) return;
    autoTriedRef.current = true;
    if (hasSavedAccount && form.username && form.password) {
      void onLoadSenders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Sign-out handled entirely by AccountSlice (cascades to sibling slices). */
  function onSignOut() {
    signOut();
  }

  // useCallback so SenderBubbles' memoised <Bubble> children see a
  // stable onPick identity across re-renders.
  const onPickSender = useCallback(
    async (s: SenderSummary) => {
      if (!account) return;
      pickSender(s);
      clearError();
      await loadEmailsForSender(account, s);
    },
    [account, pickSender, clearError, loadEmailsForSender],
  );

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
    <main className={`container ${styles.container}`}>
      {stage === "accounts" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onLoadSenders();
          }}
          className={`row ${styles.form}`}
        >
          <input value={form.host} onChange={(e) => setForm({ host: e.target.value })} placeholder="IMAP host" />
          <input value={form.port} onChange={(e) => setForm({ port: e.target.value })} placeholder="port" />
          <input value={form.username} onChange={(e) => setForm({ username: e.target.value })} placeholder="username / email" />
          <input type="password" value={form.password} onChange={(e) => setForm({ password: e.target.value })} placeholder="password / app password" />
          <button type="submit" disabled={sendersLoading}>
            {sendersLoading ? "Loading…" : "Load senders"}
          </button>
          {hasSavedAccount && (
            <button type="button" onClick={onSignOut} disabled={sendersLoading} className={styles.signOutButton}>
              Sign out (forget saved credentials)
            </button>
          )}
        </form>
      )}

      {error && (
        <p className={styles.errorBanner}>error: {error}</p>
      )}

      {/* Bubble layer stays mounted across stages so the simulation,
          node positions, and velocities all persist when the user dives
          into a sender and comes back. Always absolutely positioned so
          its dimensions never change with the active stage — a
          visibility toggle is enough to hide it without reflowing the
          simulation. */}
      {stage !== "accounts" && (
        <section
          aria-hidden={stage !== "senders"}
          className={styles.bubbleLayer}
          style={{
            visibility: stage === "senders" ? "visible" : "hidden",
            pointerEvents: stage === "senders" ? "auto" : "none",
          }}
        >
          <SenderBubbles
            senders={senders}
            onPick={onPickSender}
            searchQuery={searchQuery}
            unreadOnly={unreadOnly}
          />
        </section>
      )}

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

      {stage === "senders" && !activeSender && (
        <div className={styles.controlsBar}>
          <button
            type="button"
            aria-pressed={unreadOnly}
            aria-label={
              unreadOnly
                ? "Showing only senders with unread mail"
                : "Show only senders with unread mail"
            }
            title="Toggle unread-only filter"
            onClick={() => setUnreadOnly(!unreadOnly)}
            className={`${styles.unreadToggle} ${unreadOnly ? styles.unreadToggleActive : ""}`}
            style={{
              border: `1px solid ${unreadOnly ? "rgba(255, 77, 79, 0.85)" : "rgba(255, 255, 255, 0.18)"}`,
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <rect x="3" y="5" width="18" height="14" rx="2" />
              <path d="M3 7l9 6 9-6" />
              <circle
                cx="19"
                cy="5"
                r="3"
                fill="#ff4d4f"
                stroke="rgba(20, 20, 20, 0.9)"
                strokeWidth={1.5}
              />
            </svg>
          </button>
          <input
            ref={searchInputRef}
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="search senders… (press /)"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className={styles.searchInput}
          />
        </div>
      )}
    </main>
  );
}

export default App;
