import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import "./App.css";
import {
  fetchEmailBody,
  fetchEmailsFromSender,
  fetchEnvelopesByUids,
  mergeSenders,
  onImapUpdate,
  senderEmail,
  startImapIdle,
  stopImapIdle,
  streamSenders,
  type AccountConn,
  type EmailBody,
  type EmailEnvelope,
  type ImapErrorKind,
  type ImapInvocationError,
  type SenderSummary,
} from "./lib/imap";
import { SenderBubbles } from "./components/SenderBubbles";
import { EmailListDrawer } from "./components/EmailListDrawer";
import {
  EmailBodyDrawer,
  EMAIL_BODY_DRAWER_WIDTH,
} from "./components/EmailBodyDrawer";
import {
  clearAccount,
  loadAccount,
  saveAccount,
} from "./lib/accountStore";

type Stage = "accounts" | "senders";

interface FormState {
  host: string;
  port: string;
  username: string;
  password: string;
}

const initialForm: FormState = {
  host: "127.0.0.1",
  port: "1143",
  username: "",
  password: "",
};

function buildAccount(form: FormState): AccountConn {
  return {
    host: form.host.trim(),
    port: parseInt(form.port, 10),
    auth: {
      kind: "password",
      username: form.username.trim(),
      password: form.password,
    },
    mailbox: "INBOX",
  };
}

const IMAP_ERROR_KINDS: ReadonlySet<ImapErrorKind> = new Set([
  "connect",
  "auth",
  "mailbox",
  "search",
  "fetch",
  "parse",
  "notFound",
  "internal",
]);

function isImapError(e: unknown): e is ImapInvocationError {
  if (typeof e !== "object" || e === null) return false;
  const kind = (e as { kind?: unknown }).kind;
  const message = (e as { message?: unknown }).message;
  return (
    typeof kind === "string" &&
    typeof message === "string" &&
    IMAP_ERROR_KINDS.has(kind as ImapErrorKind)
  );
}

function errorLabel(e: unknown): string {
  if (isImapError(e)) return `[${e.kind}] ${e.message}`;
  if (e instanceof Error) return e.message;
  return String(e);
}

function App() {
  const stored = loadAccount();
  const [form, setForm] = useState<FormState>(stored ?? initialForm);
  const [account, setAccount] = useState<AccountConn | null>(null);
  const [stage, setStage] = useState<Stage>("accounts");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasSaved, setHasSaved] = useState<boolean>(stored !== null);

  const [senders, setSenders] = useState<SenderSummary[]>([]);
  const [activeSender, setActiveSender] = useState<SenderSummary | null>(null);
  const [emails, setEmails] = useState<EmailEnvelope[]>([]);
  const [body, setBody] = useState<EmailBody | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [unreadOnly, setUnreadOnly] = useState(false);

  const autoTriedRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  // Monotonically increasing sequence numbers so a slow in-flight fetch
  // doesn't overwrite the result of a newer one when the user clicks
  // through senders / emails quickly.
  const senderFetchSeqRef = useRef(0);
  const bodyFetchSeqRef = useRef(0);
  // IDLE-triggered refresh state. `inFlightRef` drops overlapping
  // refreshes (a still-running streamSenders absorbs whatever the next
  // notification would have caught). `debounceTimerRef` collapses
  // bursts — servers commonly fire EXISTS+FETCH back-to-back when a new
  // message lands.
  const refreshInFlightRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);

  function update<K extends keyof FormState>(k: K, v: FormState[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  async function onLoadSenders(acc: AccountConn, formSnapshot: FormState) {
    setAccount(acc);
    setError(null);
    setLoading(true);
    setSenders([]);
    setStage("senders");
    try {
      await streamSenders(acc, 5000, (event) => {
        if (event.kind === "chunk") {
          setSenders((prev) => mergeSenders(prev, event.senders));
        }
      });
      saveAccount(formSnapshot);
      setHasSaved(true);
    } catch (err) {
      setError(errorLabel(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (autoTriedRef.current) return;
    autoTriedRef.current = true;
    if (stored && stored.username && stored.password) {
      void onLoadSenders(buildAccount(stored), stored);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background delta refresh, triggered by IDLE notifications. Uses
  // `skipReplay` because the UI already holds the cached state; we only
  // want the new/changed/expunged deltas, not a redundant re-emit of
  // every cached sender.
  const triggerRefresh = useCallback(() => {
    if (!account) return;
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    void streamSenders(
      account,
      5000,
      (event) => {
        if (event.kind === "chunk") {
          setSenders((prev) => mergeSenders(prev, event.senders));
        }
      },
      { skipReplay: true },
    )
      .catch((err) => {
        console.error("imap idle refresh failed:", err);
      })
      .finally(() => {
        refreshInFlightRef.current = false;
      });
  }, [account]);

  // Drive IDLE: spin it up whenever we have a connected account, tear
  // it down on sign-out / account swap. The backend dedupes by
  // host/port/username/mailbox so re-issuing on the same account is a
  // no-op.
  useEffect(() => {
    if (!account) return;
    void startImapIdle(account).catch((err) => {
      console.error("startImapIdle failed:", err);
    });
    return () => {
      void stopImapIdle().catch((err) => {
        console.error("stopImapIdle failed:", err);
      });
    };
  }, [account]);

  // Subscribe to IDLE notifications. 500ms debounce collapses
  // EXISTS/FETCH bursts into one refresh.
  useEffect(() => {
    if (!account) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void onImapUpdate(() => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = window.setTimeout(() => {
        debounceTimerRef.current = null;
        triggerRefresh();
      }, 500);
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [account, triggerRefresh]);

  useEffect(() => {
    if (stage !== "senders") return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "/") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (
          tag === "INPUT" ||
          tag === "TEXTAREA" ||
          tag === "SELECT" ||
          target.isContentEditable
        ) {
          return;
        }
      }
      const input = searchInputRef.current;
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [stage]);

  function onSignOut() {
    clearAccount();
    setHasSaved(false);
    setForm(initialForm);
    setAccount(null);
    setSenders([]);
    setEmails([]);
    setBody(null);
    setActiveSender(null);
    setStage("accounts");
    setError(null);
  }

  // useCallback so the SenderBubbles' memoised <Bubble> children see a
  // stable `onPick` identity across re-renders. Without this, every
  // App render mints a fresh function and React.memo's prop check
  // would always fail, defeating the per-bubble memoisation.
  const onPickSender = useCallback(
    async (s: SenderSummary) => {
      if (!account) return;
      // Swap to the new sender. Clear stale emails / open body so the
      // list drawer header + body resets cleanly while the new fetch
      // runs.
      setActiveSender(s);
      setBody(null);
      setEmails([]);
      setError(null);
      setLoading(true);
      const seq = ++senderFetchSeqRef.current;
      try {
        // Prefer the cached UIDs from the streaming scan — no SEARCH, no
        // full-mailbox round trip. Fall back to FROM-search only if a
        // sender ever lands here without UIDs (shouldn't happen today).
        const result =
          s.uids.length > 0
            ? await fetchEnvelopesByUids(account, s.uids)
            : await fetchEmailsFromSender(account, senderEmail(s), 200);
        if (senderFetchSeqRef.current === seq) setEmails(result);
      } catch (err) {
        if (senderFetchSeqRef.current === seq) setError(errorLabel(err));
      } finally {
        if (senderFetchSeqRef.current === seq) setLoading(false);
      }
    },
    [account],
  );

  function onPickEmail(env: EmailEnvelope) {
    if (!account) return;
    setError(null);

    // Open the drawer immediately with what we already know from the
    // envelope (subject, from, date, attachments later). The body content
    // fills in when the IMAP fetch returns — the drawer shows a loading
    // indicator in the meantime. Read-state mirror also runs instantly
    // so the row un-bolds / badge decrements without waiting for the
    // network to come back.
    setBody({
      uid: env.uid,
      subject: env.subject,
      from: env.from,
      to: env.to,
      cc: env.cc,
      date: env.date,
      textBody: null,
      htmlBody: null,
      attachments: [],
      inlineParts: [],
    });
    setBodyLoading(true);

    if (!env.flags.includes("\\Seen")) {
      setEmails((prev) =>
        prev.map((e) =>
          e.uid === env.uid
            ? { ...e, flags: [...e.flags, "\\Seen"] }
            : e,
        ),
      );
      if (activeSender) {
        const targetKey = senderEmail(activeSender).toLowerCase();
        setSenders((prev) =>
          prev.map((s) =>
            senderEmail(s).toLowerCase() === targetKey
              ? { ...s, unreadCount: Math.max(0, s.unreadCount - 1) }
              : s,
          ),
        );
      }
    }

    const seq = ++bodyFetchSeqRef.current;
    void fetchEmailBody(account, env.uid)
      .then((result) => {
        if (bodyFetchSeqRef.current !== seq) return;
        setBody(result);
        setBodyLoading(false);
      })
      .catch((err) => {
        if (bodyFetchSeqRef.current !== seq) return;
        setError(errorLabel(err));
        setBodyLoading(false);
      });
  }

  function closeListDrawer() {
    setActiveSender(null);
    setEmails([]);
    setBody(null);
    setBodyLoading(false);
  }

  function closeBodyDrawer() {
    setBody(null);
    setBodyLoading(false);
  }

  // Escape key closes the topmost open drawer (body first, then list).
  // Window-level subscription — useEffect is the right tool here.
  useEffect(() => {
    if (!activeSender && !body) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (body) {
        setBody(null);
      } else {
        closeListDrawer();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSender, body]);

  return (
    <main className="container" style={{ position: "relative" }}>
      {stage === "accounts" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void onLoadSenders(buildAccount(form), form);
          }}
          className="row"
          style={{ flexDirection: "column", gap: 8 }}
        >
          <input value={form.host} onChange={(e) => update("host", e.target.value)} placeholder="IMAP host" />
          <input value={form.port} onChange={(e) => update("port", e.target.value)} placeholder="port" />
          <input value={form.username} onChange={(e) => update("username", e.target.value)} placeholder="username / email" />
          <input type="password" value={form.password} onChange={(e) => update("password", e.target.value)} placeholder="password / app password" />
          <button type="submit" disabled={loading}>
            {loading ? "Loading…" : "Load senders"}
          </button>
          {hasSaved && (
            <button type="button" onClick={onSignOut} disabled={loading} style={{ opacity: 0.7 }}>
              Sign out (forget saved credentials)
            </button>
          )}
        </form>
      )}

      {error && (
        <p style={{ color: "crimson", whiteSpace: "pre-wrap" }}>error: {error}</p>
      )}

      {/* Bubble layer stays mounted across stages so the simulation, node
          positions, and velocities all persist when the user dives into a
          sender and comes back. Always absolutely positioned so its
          dimensions never change with the active stage — a visibility
          toggle is enough to hide it without reflowing the simulation. */}
      {stage !== "accounts" && (
        <section
          aria-hidden={stage !== "senders"}
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
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
            loading={loading}
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
            onClose={closeBodyDrawer}
          />
        )}
      </AnimatePresence>

      {stage === "senders" && !activeSender && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            right: 24,
            zIndex: 10,
            display: "flex",
            gap: 8,
            alignItems: "stretch",
          }}
        >
          <button
            type="button"
            aria-pressed={unreadOnly}
            aria-label={
              unreadOnly
                ? "Showing only senders with unread mail"
                : "Show only senders with unread mail"
            }
            title="Toggle unread-only filter"
            onClick={() => setUnreadOnly((v) => !v)}
            style={{
              width: 44,
              padding: 0,
              borderRadius: 10,
              border: `1px solid ${unreadOnly ? "rgba(255, 77, 79, 0.85)" : "rgba(255, 255, 255, 0.18)"}`,
              background: unreadOnly
                ? "rgba(255, 77, 79, 0.18)"
                : "rgba(20, 20, 20, 0.7)",
              color: unreadOnly ? "#ff8a8c" : "rgba(255, 255, 255, 0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              cursor: "pointer",
              backdropFilter: "blur(10px)",
              boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
              transition:
                "color 180ms, background 180ms, border-color 180ms",
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
            style={{
              minWidth: 280,
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid rgba(255, 255, 255, 0.18)",
              background: "rgba(20, 20, 20, 0.7)",
              color: "white",
              fontSize: "0.95em",
              backdropFilter: "blur(10px)",
              boxShadow: "0 6px 20px rgba(0, 0, 0, 0.35)",
              outline: "none",
            }}
          />
        </div>
      )}
    </main>
  );
}

export default App;
