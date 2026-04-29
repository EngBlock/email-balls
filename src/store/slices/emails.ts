import type { AppStateCreator } from "../types";

import type {
  AccountConn,
  EmailBody,
  EmailEnvelope,
  SenderSummary,
} from "../../lib/imap";
import {
  fetchEmailBody,
  fetchEmailsFromSender,
  fetchEnvelopesByUids,
  senderEmail,
} from "../../lib/imap";

// ---------------------------------------------------------------------------
// Error formatting — local mirror of the App.tsx helper until a shared
// util is extracted. Covers ImapInvocationError and generic Error objects.
// ---------------------------------------------------------------------------

function formatError(e: unknown): string {
  if (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    "message" in e &&
    typeof (e as { kind: unknown }).kind === "string" &&
    typeof (e as { message: unknown }).message === "string"
  ) {
    return `[${(e as { kind: string }).kind}] ${(e as { message: string }).message}`;
  }
  if (e instanceof Error) return e.message;
  return String(e);
}



/**
 * Emails state.
 *
 * Owns the envelope list for the active sender, the currently-open email
 * body, and email-scoped loading/error flags. Migrated from the `emails`,
 * `body`, `bodyLoading` fields and the `onPickEmail` / `closeBodyDrawer`
 * flow in `src/App.tsx`.
 *
 * The sender-unread decrement that accompanies `onPickEmail` is a
 * senders-slice concern; the App migration layer calls both slices.
 */
export interface EmailsSlice {
  /** Envelope list for the currently selected sender. */
  emails: EmailEnvelope[];
  /** Full body of the currently open email, or a placeholder with
   *  `textBody`/`htmlBody` = null while the IMAP fetch is in flight. */
  body: EmailBody | null;
  /** True while a body fetch is in flight. The body drawer shows a
   *  loading indicator when this is true and `body` is non-null. */
  bodyLoading: boolean;
  /** True while the envelope list fetch is in flight. */
  emailsLoading: boolean;
  /** Last email-related error string, or null. */
  emailsError: string | null;

  /** Fetch envelopes for a sender. Clears body, emails, and error
   *  upfront, then loads the new list. Uses an internal generation
   *  counter to discard stale responses if the user clicks to a
   *  different sender before the fetch completes. */
  loadEmailsForSender: (
    account: AccountConn,
    sender: SenderSummary,
  ) => Promise<void>;

  /** Open the body drawer for an email. Sets a placeholder body
   *  immediately (so the drawer animates in with envelope metadata),
   *  marks the email as seen in the envelope list, then fetches the
   *  full body. Uses an internal generation counter to discard stale
   *  body responses if the user clicks a different email mid-flight. */
  loadBody: (account: AccountConn, env: EmailEnvelope) => void;

  /** Close the body drawer. Clears body + bodyLoading. */
  closeBody: () => void;

  /** Clear all email state (used when closing the email list drawer
   *  or signing out). */
  clearEmails: () => void;
}

export const createEmailsSlice: AppStateCreator<EmailsSlice> = (set) => {
  /* ── Generation-counter pattern ──────────────────────────────────
   *
   * When the user clicks through senders / emails quickly, multiple
   * fetch requests can be in flight simultaneously. Without protection,
   * a slow response for sender A could overwrite the already-displayed
   * results for sender B, or a stale body fetch could pop back open
   * after the user switched to a different sender.
   *
   * Pattern: each fetch request increments a monotonic counter and
   * captures the new value. When the async response arrives, it only
   * writes to state if the counter still matches — a mismatch means a
   * newer request was issued in the meantime and the stale response is
   * silently discarded.
   *
   * The counters live in the closure (not in Zustand state) because
   * they never influence rendering — they are purely internal
   * bookkeeping for the async actions. Storing them outside state also
   * means they never cause spurious re-renders and reset naturally
   * when the store is recreated (e.g. in tests). */
  let _senderFetchSeq = 0;
  let _bodyFetchSeq = 0;

  return {
    emails: [],
  body: null,
  bodyLoading: false,
  emailsLoading: false,
  emailsError: null,

  loadEmailsForSender: async (account, sender) => {
    // Swap to the new sender — clear stale emails / open body so the
    // list drawer header + body resets cleanly while the new fetch runs.
    ++_bodyFetchSeq; // invalidate any in-flight body fetch from previous sender
    set({ body: null, emails: [], emailsError: null, emailsLoading: true });
    const seq = ++_senderFetchSeq;
    try {
      // Prefer the cached UIDs from the streaming scan — no SEARCH, no
      // full-mailbox round trip. Fall back to FROM-search only if a
      // sender ever lands here without UIDs (shouldn't happen today).
      const result =
        sender.uids.length > 0
          ? await fetchEnvelopesByUids(account, sender.uids)
          : await fetchEmailsFromSender(account, senderEmail(sender), 200);
      if (_senderFetchSeq === seq) set({ emails: result });
    } catch (err) {
      if (_senderFetchSeq === seq) set({ emailsError: formatError(err) });
    } finally {
      if (_senderFetchSeq === seq) set({ emailsLoading: false });
    }
  },

  loadBody: (account, env) => {
    set({ emailsError: null });

    // Open the drawer immediately with what we already know from the
    // envelope (subject, from, date, etc.). The body content fills in
    // when the IMAP fetch returns — the drawer shows a loading
    // indicator in the meantime.
    set({
      body: {
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
      },
      bodyLoading: true,
    });

    // Read-state mirror: mark the email as seen in the envelope list
    // instantly so the row un-bolds / badge decrements without waiting
    // for the network.
    if (!env.flags.includes("\\Seen")) {
      set((state) => ({
        emails: state.emails.map((e) =>
          e.uid === env.uid
            ? { ...e, flags: [...e.flags, "\\Seen"] }
            : e,
        ),
      }));
    }

    const seq = ++_bodyFetchSeq;
    void fetchEmailBody(account, env.uid)
      .then((result) => {
        if (_bodyFetchSeq !== seq) return;
        set({ body: result, bodyLoading: false });
      })
      .catch((err) => {
        if (_bodyFetchSeq !== seq) return;
        set({ emailsError: formatError(err), bodyLoading: false });
      });
  },

  closeBody: () => set({ body: null, bodyLoading: false }),

  clearEmails: () => {
    ++_bodyFetchSeq; // invalidate any in-flight body fetch
    set({ emails: [], body: null, bodyLoading: false, emailsLoading: false, emailsError: null });
  },
};
};
