import { motion } from "framer-motion";
import type { ReactNode } from "react";

const SPRING = { type: "spring", damping: 28, stiffness: 230 } as const;

interface Props {
  /** Drawer width in pixels. Used for both layout and the off-screen
   *  start/exit positions, so the slide animation matches the drawer
   *  exactly. */
  width: number;
  /** The drawer's animated x position when mounted. 0 = flush against
   *  the right edge; negative values push it leftward (used by the
   *  list drawer when the body drawer stacks on top). */
  x?: number;
  /** Stacking order; higher values render above lower ones. Body
   *  drawer should stack above the list drawer. */
  zIndex?: number;
  onClose: () => void;
  header: ReactNode;
  children: ReactNode;
}

export function Drawer({
  width,
  x = 0,
  zIndex = 20,
  onClose,
  header,
  children,
}: Props) {
  return (
    <motion.aside
      initial={{ x: width }}
      animate={{ x }}
      exit={{ x: width }}
      transition={SPRING}
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        bottom: 0,
        width,
        zIndex,
        background: "rgba(20, 20, 20, 0.88)",
        backdropFilter: "blur(10px)",
        borderLeft: "1px solid rgba(255, 255, 255, 0.08)",
        boxShadow: "-12px 0 40px rgba(0, 0, 0, 0.45)",
        display: "flex",
        flexDirection: "column",
        color: "white",
        textAlign: "left",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: 12,
          padding: "16px 18px",
          borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>{header}</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            flex: "none",
            width: 32,
            height: 32,
            borderRadius: "50%",
            border: "none",
            background: "rgba(255, 255, 255, 0.06)",
            color: "white",
            cursor: "pointer",
            fontSize: 18,
            lineHeight: 1,
            padding: 0,
            boxShadow: "none",
          }}
        >
          ×
        </button>
      </header>
      <div style={{ flex: 1, overflowY: "auto", padding: "8px 0" }}>
        {children}
      </div>
    </motion.aside>
  );
}
