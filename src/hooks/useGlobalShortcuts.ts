import { useEffect, type RefObject } from "react";
import { useAppStore } from "../store";

interface UseGlobalShortcutsOptions {
  searchInputRef: RefObject<HTMLInputElement | null>;
}

/**
 * Register global keyboard shortcuts:
 * - "/" focuses the search input (only on the senders stage)
 * - Escape closes the topmost open drawer (body first, then list)
 */
export function useGlobalShortcuts({
  searchInputRef,
}: UseGlobalShortcutsOptions) {
  const stage = useAppStore((s) => s.stage);
  const activeSender = useAppStore((s) => s.activeSender);
  const body = useAppStore((s) => s.body);
  const closeBody = useAppStore((s) => s.closeBody);
  const clearActiveSender = useAppStore((s) => s.clearActiveSender);
  const clearEmails = useAppStore((s) => s.clearEmails);

  // "/" keyboard shortcut to focus the search input.
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
  }, [stage, searchInputRef]);

  // Escape key closes the topmost open drawer (body first, then list).
  useEffect(() => {
    if (!activeSender && !body) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (body) {
        closeBody();
      } else {
        // closeListDrawer: clear active sender, emails, and body
        clearActiveSender();
        clearEmails();
        closeBody();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeSender, body, closeBody, clearActiveSender, clearEmails]);
}
