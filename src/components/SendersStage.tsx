import { useRef } from "react";

import { BubbleLayer } from "./BubbleLayer";
import { DrawersLayer } from "./DrawersLayer";
import { SearchControls } from "./SearchControls";
import { useAppStore } from "../store";
import { useGlobalShortcuts } from "../hooks/useGlobalShortcuts";

/**
 * Senders stage shell. Mounts the bubble simulation layer, the
 * (animated) drawer stack, and the search/filter controls. Owns the
 * keyboard-shortcut wiring and the searchInputRef passed into
 * <SearchControls>.
 *
 * Subscribes only to `activeSender` (to gate the controls bar) so the
 * shell itself does not re-render on bubble/drawer/search state churn.
 */
export function SendersStage() {
  const activeSender = useAppStore((s) => s.activeSender);

  const searchInputRef = useRef<HTMLInputElement | null>(null);

  useGlobalShortcuts({ searchInputRef });

  return (
    <>
      <BubbleLayer />
      <DrawersLayer />
      {!activeSender && <SearchControls inputRef={searchInputRef} />}
    </>
  );
}
