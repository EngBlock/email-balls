import { useCallback } from "react";

import styles from "./BubbleLayer.module.css";
import { SenderBubbles } from "./SenderBubbles";
import type { SenderSummary } from "../lib/imap";
import { useAppStore } from "../store";

/**
 * Hosts the d3-force bubble simulation. Subscribes to `searchQuery` /
 * `unreadOnly` here (rather than passing them down through SendersStage)
 * so keystrokes in <SearchControls> do not re-render the stage shell or
 * the drawers — only this layer and its memoised <SenderBubbles> child.
 */
export function BubbleLayer() {
  const senders = useAppStore((s) => s.senders);
  const account = useAppStore((s) => s.account);
  const searchQuery = useAppStore((s) => s.searchQuery);
  const unreadOnly = useAppStore((s) => s.unreadOnly);
  const pickSender = useAppStore((s) => s.pickSender);
  const clearError = useAppStore((s) => s.clearError);
  const loadEmailsForSender = useAppStore((s) => s.loadEmailsForSender);

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

  return (
    <section className={styles.bubbleLayer}>
      <SenderBubbles
        senders={senders}
        onPick={onPickSender}
        searchQuery={searchQuery}
        unreadOnly={unreadOnly}
      />
    </section>
  );
}
