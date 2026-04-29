import type { AppStateCreator } from "../types";
import {
  mergeSenders,
  senderEmail,
  streamSenders,
  type AccountConn,
  type ImapErrorKind,
  type ImapInvocationError,
  type SenderSummary,
} from "../../lib/imap";

// ── Error formatting (duplicated from App.tsx until a shared util lands) ──

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

// ── Slice ─────────────────────────────────────────────────────────────────

/**
 * Senders state.
 *
 * Owns the senders list, the active sender selection, and the bubble-view
 * filters (search query, unread-only toggle). Encapsulates the
 * stale-request race protection previously implemented via
 * `senderFetchSeqRef` in `App.tsx` using an internal generation counter.
 */
export interface SendersSlice {
  /** All senders discovered for the connected account. */
  senders: SenderSummary[];
  /** Currently selected sender (opens the email list drawer). */
  activeSender: SenderSummary | null;
  /** Bubble-view search filter. */
  searchQuery: string;
  /** Toggle to show only senders with unread mail. */
  unreadOnly: boolean;
  /** True while the sender list is streaming from IMAP. */
  sendersLoading: boolean;
  /** Error string from the last sender-list fetch, null when clean. */
  sendersError: string | null;

  // ── Actions ──────────────────────────────────────────────────────

  /** Stream senders from IMAP. Merges chunks incrementally into
   *  `senders`. Sets `sendersLoading` / `sendersError`. */
  loadSenders: (
    account: AccountConn,
    scanLimit: number | undefined,
    options?: { skipReplay?: boolean },
  ) => Promise<void>;

  /** Select a sender. Increments the internal generation counter and
   *  returns the new generation number. The caller uses
   *  {@link isFetchCurrent} to discard stale async results (e.g. email
   *  fetches for a previously-clicked sender). */
  pickSender: (sender: SenderSummary) => number;

  /** Deselect the active sender (closes the email list drawer). */
  clearActiveSender: () => void;

  setSearchQuery: (query: string) => void;
  setUnreadOnly: (value: boolean) => void;

  /** Merge a delta chunk into the sender list (used by both initial
   *  streaming and IDLE-triggered delta refreshes). */
  mergeSenderChunk: (chunk: SenderSummary[]) => void;

  /** Decrement the unread count on the sender whose normalised email
   *  matches `senderEmailKey` (called when an email is opened). */
  decrementUnread: (senderEmailKey: string) => void;

  /** Check whether a previously-returned generation number is still
   *  current. Use to guard stale async responses:
   *  ```ts
   *  const gen = pickSender(sender);
   *  const emails = await fetchEmails(account, sender);
   *  if (!isFetchCurrent(gen)) return; // a newer pick superseded us
   *  ```
   */
  isFetchCurrent: (gen: number) => boolean;

  /** Reset all sender state to initial values (used on sign-out). */
  resetSenders: () => void;
}

export const createSendersSlice: AppStateCreator<SendersSlice> = (
  set,
  get,
) => {
  /* ── Generation-counter pattern ──────────────────────────────────
   *
   * When the user clicks through senders quickly, multiple email-fetch
   * requests can be in flight simultaneously. Without protection, a
   * slow response for sender A could overwrite the already-displayed
   * results for sender B. The generation counter solves this: each
   * `pickSender` call increments the counter and returns the new value.
   * The caller captures that value and, before applying the async
   * result, checks `isFetchCurrent(gen)`. If the counter has advanced
   * past the captured value, the response is stale and silently
   * discarded.
   *
   * This is the same logic that `senderFetchSeqRef` implemented in
   * `App.tsx`, but encapsulated inside the slice so any consumer gets
   * race protection for free.
   *
   * The counter lives in the closure (not in zustand state) because it
   * never drives rendering — it is purely a coordination mechanism.
   * Storing it outside state also means it never causes spurious
   * re-renders and resets naturally when the store is recreated. */
  let _fetchGen = 0;

  return {
    senders: [],
    activeSender: null,
    searchQuery: "",
    unreadOnly: false,
    sendersLoading: false,
    sendersError: null,

    loadSenders: async (account, scanLimit, options) => {
      const skipReplay = options?.skipReplay ?? false;
      // When skipReplay is true we are performing a delta refresh (e.g.
      // IDLE-triggered); existing senders must be preserved so the
      // incremental merge accumulates on top of the current list.
      // An initial load (no skipReplay) starts from a clean slate.
      set({
        sendersLoading: true,
        sendersError: null,
        ...(!skipReplay && { senders: [] }),
      });
      try {
        await streamSenders(
          account,
          scanLimit,
          (event) => {
            if (event.kind === "chunk") {
              set({ senders: mergeSenders(get().senders, event.senders) });
            }
          },
          options,
        );
      } catch (err) {
        set({ sendersError: errorLabel(err) });
      } finally {
        set({ sendersLoading: false });
      }
    },

    pickSender: (sender) => {
      _fetchGen++;
      set({ activeSender: sender, sendersError: null });
      return _fetchGen;
    },

    clearActiveSender: () => {
      set({ activeSender: null });
    },

    setSearchQuery: (query) => set({ searchQuery: query }),
    setUnreadOnly: (value) => set({ unreadOnly: value }),

    mergeSenderChunk: (chunk) => {
      set({ senders: mergeSenders(get().senders, chunk) });
    },

    decrementUnread: (senderEmailKey) => {
      set({
        senders: get().senders.map((s) =>
          senderEmail(s).toLowerCase() === senderEmailKey
            ? { ...s, unreadCount: Math.max(0, s.unreadCount - 1) }
            : s,
        ),
      });
    },

    isFetchCurrent: (gen) => _fetchGen === gen,

    resetSenders: () => {
      _fetchGen = 0;
      set({
        senders: [],
        activeSender: null,
        searchQuery: "",
        unreadOnly: false,
        sendersLoading: false,
        sendersError: null,
      });
    },
  };
};
