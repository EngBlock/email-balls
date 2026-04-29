import type { Ref } from "react";

import styles from "./SearchControls.module.css";
import { useAppStore } from "../store";

interface Props {
  /** Ref forwarded from SendersStage so useGlobalShortcuts can focus
   *  the input on "/". React 19 lets function components accept `ref`
   *  as a regular prop — no forwardRef needed. */
  inputRef?: Ref<HTMLInputElement | null>;
}

/**
 * Search input + unread-only toggle. Isolated into its own component so
 * keystrokes only re-render this subtree — App, SendersStage, and the
 * bubble/drawer siblings do not subscribe to `searchQuery`.
 */
export function SearchControls({ inputRef }: Props) {
  const searchQuery = useAppStore((s) => s.searchQuery);
  const unreadOnly = useAppStore((s) => s.unreadOnly);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const setUnreadOnly = useAppStore((s) => s.setUnreadOnly);

  return (
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
        ref={inputRef}
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
  );
}
