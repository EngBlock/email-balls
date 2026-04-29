import { useEffect } from "react";
import { startImapIdle, stopImapIdle } from "../lib/imap";
import { useAppStore } from "../store";

/**
 * Drive IMAP IDLE: spin it up whenever we have a connected account,
 * tear it down on sign-out / account swap.
 */
export function useImapIdleLifecycle() {
  const account = useAppStore((s) => s.account);

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
}
