import { memo, useCallback, useRef } from "react";
import { forceSimulation, type Simulation } from "d3-force";
import { AnimatePresence, motion } from "framer-motion";

import { resolveAvatarForSender } from "../lib/avatar";
import styles from "./SenderBubbles.module.css";
import { hashColor } from "../lib/gravatar";
import { senderEmail, senderLabel, type SenderSummary } from "../lib/imap";
import { forceBounce, forceThermal, forceWalls, isPinned } from "../lib/physics";

// Hoisted to module scope so every <motion.button> sees the same object
// identity across renders. Inline literals would be a fresh object each
// render and force Framer Motion to re-evaluate variants and transitions
// on every bubble — measurably slow at hundreds of bubbles.
const BUBBLE_INITIAL = { scale: 0, opacity: 0 };
const BUBBLE_ANIMATE = { scale: 1, opacity: 1 };
const BUBBLE_EXIT = { scale: 0, opacity: 0 };
const BUBBLE_HOVER = { scale: 1.08 };
const BUBBLE_TAP = { scale: 0.95 };
const BUBBLE_TRANSITION = {
  type: "spring" as const,
  stiffness: 220,
  damping: 18,
};

export interface BubbleNode {
  key: string;
  sender: SenderSummary;
  r: number;
  // d3 writes these on every tick.
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  // Setting fx/fy pins the node — d3 will clamp x/y to these and zero
  // vx/vy on every tick, freezing it in place. We use that for hover.
  fx?: number | null;
  fy?: number | null;
  // Velocity stashed at hover-start so we can restore drift on hover-end.
  savedVx?: number;
  savedVy?: number;
  // Resolved avatar — BIMI logo if the domain publishes one, else a
  // Gravatar URL. `null` until the resolver finishes.
  avatar: string | null;
  color: string;
}


// Base radius scales with total volume; an "unread share" multiplier on top
// makes a sender with everything unread visibly bigger than a sender with
// the same volume but all read. Pure-read senders sit at 1.0× base; pure-
// unread senders bump up to 1.4× base. We use unread *share* (not raw
// count) so a single unread message in a long-known sender doesn't dwarf
// everything; share is the better signal of "is this one demanding
// attention right now".
function radiusFor(messageCount: number, unreadCount: number): number {
  const base = 14 + Math.sqrt(Math.max(1, messageCount)) * 2;
  const share =
    messageCount > 0 ? Math.min(1, unreadCount / messageCount) : 0;
  return base * (1 + share * 0.4);
}

interface Props {
  senders: SenderSummary[];
  onPick: (s: SenderSummary) => void;
  /** Case-insensitive substring filter against displayName + email.
   *  Empty string = no filter. Non-matching bubbles fade out and stop
   *  intercepting clicks but stay in the simulation, so positions
   *  persist when the filter clears. */
  searchQuery?: string;
  /** When true, hide bubbles whose unreadCount is zero. Composes with
   *  `searchQuery` (both must pass). Same fade-out treatment as the
   *  search filter so positions persist. */
  unreadOnly?: boolean;
}

function senderMatchesQuery(s: SenderSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const label = senderLabel(s).toLowerCase();
  const email = senderEmail(s).toLowerCase();
  return label.includes(q) || email.includes(q);
}

function senderVisible(
  s: SenderSummary,
  query: string,
  unreadOnly: boolean,
): boolean {
  if (unreadOnly && s.unreadCount === 0) return false;
  return senderMatchesQuery(s, query);
}

/// Write the visibility state for one bubble straight to the DOM, only
/// touching properties that actually need to change. Re-applying the
/// same string is cheap but still triggers a style recalc — short-circuit.
function applyVisibility(
  elem: HTMLElement,
  s: SenderSummary,
  query: string,
  unreadOnly: boolean,
) {
  const hidden = !senderVisible(s, query, unreadOnly);
  const opacity = hidden ? "0" : "1";
  const pointerEvents = hidden ? "none" : "auto";
  if (elem.style.opacity !== opacity) elem.style.opacity = opacity;
  if (elem.style.pointerEvents !== pointerEvents)
    elem.style.pointerEvents = pointerEvents;
}

interface BubbleProps {
  /** The simulation node. Identity is stable per bubble; mutations on
   *  `node.sender`/`node.r`/`node.avatar` are reflected via the
   *  separate `r` / `sender` props (which carry fresh references when
   *  they change), and via the imperative avatar/transform writes from
   *  the parent. Hover handlers read pin state straight off `node`. */
  node: BubbleNode;
  r: number;
  sender: SenderSummary;
  onPick: (s: SenderSummary) => void;
  bubbleRef: (el: HTMLDivElement | null) => void;
}

const Bubble = memo(function Bubble({
  node,
  r,
  sender,
  onPick,
  bubbleRef,
}: BubbleProps) {
  return (
    <div
      ref={bubbleRef}
      data-key={node.key}
      className={styles.bubble}
      style={{
        width: r * 2,
        height: r * 2,
        backgroundColor: node.color,
        // Initial avatar value at mount; subsequent avatar resolution
        // writes elem.style.backgroundImage imperatively.
        backgroundImage: node.avatar ? `url(${node.avatar})` : "none",
      }}
    >
      <motion.button
        type="button"
        onClick={() => onPick(sender)}
        onHoverStart={() => {
          if (isPinned(node)) return;
          node.savedVx = node.vx ?? 0;
          node.savedVy = node.vy ?? 0;
          node.fx = node.x ?? 0;
          node.fy = node.y ?? 0;
        }}
        onHoverEnd={() => {
          node.fx = null;
          node.fy = null;
          node.vx = node.savedVx ?? 0;
          node.vy = node.savedVy ?? 0;
        }}
        className={styles.bubbleButton}
        initial={BUBBLE_INITIAL}
        animate={BUBBLE_ANIMATE}
        exit={BUBBLE_EXIT}
        transition={BUBBLE_TRANSITION}
        whileHover={BUBBLE_HOVER}
        whileTap={BUBBLE_TAP}
        aria-label={senderLabel(sender)}
        title={`${senderLabel(sender)} · ${sender.messageCount} messages${
          sender.unreadCount > 0 ? ` (${sender.unreadCount} unread)` : ""
        }`}
      />
      {sender.unreadCount > 0 && <UnreadBadge count={sender.unreadCount} />}
    </div>
  );
});

const UnreadBadge = memo(function UnreadBadge({ count }: { count: number }) {
  const label = count > 99 ? "99+" : String(count);
  // Width = height keeps the badge a perfect circle. Step the size up
  // with digit count so multi-digit numbers still fit.
  const size = label.length >= 3 ? 24 : label.length === 2 ? 20 : 18;
  return (
    <div
      aria-hidden
      className={styles.unreadBadge}
      style={{
        width: size,
        height: size,
        fontSize: label.length >= 3 ? 9 : undefined,
        lineHeight: `${size}px`,
      }}
    >
      {label}
    </div>
  );
});

function SenderBubblesInner({
  senders,
  onPick,
  searchQuery = "",
  unreadOnly = false,
}: Props) {
  // Mutable state lives in refs so renders are cheap and the d3 tick can
  // write straight to the DOM without going through React.
  const nodesRef = useRef<BubbleNode[]>([]);
  const nodesByKeyRef = useRef<Map<string, BubbleNode>>(new Map());
  const sizeRef = useRef({ w: 800, h: 600 });
  const simRef = useRef<Simulation<BubbleNode, undefined> | null>(null);
  const elemsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const lastSendersRef = useRef<SenderSummary[] | null>(null);
  // The most recently *applied* filter. Drives the bubbleRef-mount
  // visibility apply (so a bubble that mounts while the filter is on
  // paints hidden immediately) and lets us short-circuit the
  // render-time imperative pass when nothing changed.
  const filterRef = useRef({ searchQuery: "", unreadOnly: false });

  // --- Render-phase reconciliation (no effect) -----------------------------
  // Diff senders → nodes whenever the senders prop identity changes. Mutating
  // refs during render is allowed; the side-effecting work (sim.nodes /
  // sim.alpha) is acting on an external system, not React state.
  const sendersChanged = lastSendersRef.current !== senders;
  if (sendersChanged) {
    const existing = new Map(nodesRef.current.map((n) => [n.key, n]));
    const next: BubbleNode[] = [];
    let added = false;

    for (const s of senders) {
      const key = senderEmail(s).toLowerCase();
      const r = radiusFor(s.messageCount, s.unreadCount);
      const prior = existing.get(key);
      if (prior) {
        prior.sender = s;
        prior.r = r;
        next.push(prior);
        existing.delete(key);
      } else {
        // Spawn near center with a small random kick so they spread out.
        const cx = sizeRef.current.w / 2;
        const cy = sizeRef.current.h / 2;
        const angle = Math.random() * Math.PI * 2;
        const dist = Math.random() * 60;
        const node: BubbleNode = {
          key,
          sender: s,
          r,
          x: cx + Math.cos(angle) * dist,
          y: cy + Math.sin(angle) * dist,
          vx: (Math.random() - 0.5) * 4,
          vy: (Math.random() - 0.5) * 4,
          avatar: null,
          color: hashColor(key),
        };
        next.push(node);
        // Resolve the avatar out of band — BIMI lookup hits the Rust
        // disk cache first, falls back to Gravatar. Write the
        // backgroundImage straight to the wrapper element rather than
        // re-rendering the bubble tree, since the d3 tick is already
        // mutating these elements directly. Avoids an O(N²) cascade of
        // re-renders when N senders resolve in quick succession on
        // initial load.
        resolveAvatarForSender(s).then(({ url }) => {
          node.avatar = url;
          const elem = elemsRef.current.get(key);
          if (elem) elem.style.backgroundImage = `url(${url})`;
        });
        added = true;
      }
    }
    const removed = existing.size > 0;
    nodesRef.current = next;
    nodesByKeyRef.current = new Map(next.map((n) => [n.key, n]));
    lastSendersRef.current = senders;

    const sim = simRef.current;
    if (sim) {
      sim.nodes(next);
      if (added || removed) sim.alpha(0.4).restart();
    }
  }

  // --- Imperative visibility apply -----------------------------------------
  // Filter changes (search/unreadOnly) and sender data updates (which can
  // flip a bubble's `unreadCount` to/from zero) both want the same thing:
  // re-evaluate every bubble's visibility and write it straight to the DOM.
  // Doing this here — at render time, side-effecting an external system —
  // means the memoised <Bubble> children skip React reconciliation entirely
  // when only the filter toggles. Newly-mounted bubbles get their initial
  // visibility from the bubbleRef callback below using `filterRef`.
  const filterChanged =
    filterRef.current.searchQuery !== searchQuery ||
    filterRef.current.unreadOnly !== unreadOnly;
  if (sendersChanged || filterChanged) {
    for (const n of nodesRef.current) {
      const elem = elemsRef.current.get(n.key);
      if (!elem) continue;
      applyVisibility(elem, n.sender, searchQuery, unreadOnly);
    }
    filterRef.current = { searchQuery, unreadOnly };
  }

  // --- Container lifecycle (ref callback, no effect) -----------------------
  // React 19 lets ref callbacks return a cleanup function — we use that to
  // avoid a useEffect for the simulation + ResizeObserver setup. The sim is
  // created on container mount, torn down on unmount.
  const containerRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;

    const measure = () => {
      const r = el.getBoundingClientRect();
      sizeRef.current = { w: r.width, h: r.height };
      simRef.current?.alpha(0.2).restart();
    };
    measure();

    const sim = forceSimulation<BubbleNode>(nodesRef.current)
      // Tiny friction so thermal injection settles into a steady-state
      // speed instead of growing without bound.
      .velocityDecay(0.02)
      // alphaTarget > alphaMin keeps the simulation ticking forever, so
      // the thermal + collision + wall forces always run.
      .alphaTarget(0.02)
      .force("thermal", forceThermal<BubbleNode>(0.4))
      .force("bounce", forceBounce<BubbleNode>())
      .force(
        "walls",
        forceWalls<BubbleNode>(
          () => sizeRef.current.w,
          () => sizeRef.current.h,
        ),
      )
      .on("tick", () => {
        for (const n of nodesRef.current) {
          if (n.x === undefined || n.y === undefined) continue;
          const elem = elemsRef.current.get(n.key);
          if (elem) {
            elem.style.transform = `translate(${n.x - n.r}px, ${n.y - n.r}px)`;
          }
        }
      });
    simRef.current = sim;

    const ro = new ResizeObserver(measure);
    ro.observe(el);

    return () => {
      ro.disconnect();
      sim.stop();
      simRef.current = null;
    };
  }, []);

  // Single stable ref callback shared across all bubbles — reads the
  // node key off `data-key` to register/unregister into `elemsRef`.
  // Reusing one closure (rather than minting a per-key one each render)
  // means React doesn't re-run N callbacks every time the parent
  // re-renders. On mount we also paint the current filter directly
  // onto the new element so a bubble that appears while a filter is
  // active never flashes visible-then-hidden.
  const bubbleRef = useCallback((el: HTMLDivElement | null) => {
    if (el) {
      const key = el.dataset.key;
      if (!key) return;
      elemsRef.current.set(key, el);
      const node = nodesByKeyRef.current.get(key);
      if (node) {
        applyVisibility(
          el,
          node.sender,
          filterRef.current.searchQuery,
          filterRef.current.unreadOnly,
        );
      }
    } else {
      // React calls the cleanup callback with null and the element it
      // was previously attached to is no longer reachable from here.
      // We instead sweep elemsRef by checking which entries still
      // point to a connected element. Cheap because there are at most
      // N entries and this only fires on unmount.
      for (const [k, v] of elemsRef.current) {
        if (!v.isConnected) elemsRef.current.delete(k);
      }
    }
  }, []);

  return (
    <div ref={containerRef} className={styles.container}>
      <AnimatePresence>
        {nodesRef.current.map((n) => (
          <Bubble
            key={n.key}
            node={n}
            r={n.r}
            sender={n.sender}
            onPick={onPick}
            bubbleRef={bubbleRef}
          />
        ))}
      </AnimatePresence>
    </div>
  );
}

/**
 * Memoised so that re-renders of <BubbleLayer> for unrelated reasons
 * skip SenderBubbles entirely. Props are referentially stable in normal
 * use: `onPick` is wrapped in useCallback by BubbleLayer, `senders` only
 * gets a new identity when a chunk merges in, and `searchQuery` /
 * `unreadOnly` are primitives. React Compiler memoises *inside* the
 * component; this memo is the boundary memo on top of that.
 */
export const SenderBubbles = memo(SenderBubblesInner);
