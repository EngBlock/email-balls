import { useCallback, useEffect, useRef } from "react";
import { onImapUpdate } from "../lib/imap";
import { useAppStore } from "../store";

/**
 * Subscribe to IDLE notifications and pump them into the zustand
 * store via a debounced delta refresh.
 *
 * - 500 ms debounce collapses EXISTS/FETCH bursts into one refresh.
 * - An in-flight ref drops overlapping refreshes (a still-running
 *   streamSenders absorbs whatever the next notification would have
 *   caught).
 * - Uses `skipReplay` because the UI already holds the cached state;
 *   we only want the new/changed/expunged deltas, not a redundant
 *   re-emit of every cached sender.
 */
export function useImapEventBridge() {
  const account = useAppStore((s) => s.account);
  const loadSenders = useAppStore((s) => s.loadSenders);

  const refreshInFlightRef = useRef(false);
  const debounceTimerRef = useRef<number | null>(null);

  const triggerRefresh = useCallback(() => {
    if (!account) return;
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    void loadSenders(account, 5000, { skipReplay: true })
      .catch((err) => {
        console.error("imap idle refresh failed:", err);
      })
      .finally(() => {
        refreshInFlightRef.current = false;
      });
  }, [account, loadSenders]);

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
}
