import { useCallback, useReducer, useRef } from "react";
import { forceSimulation, type Simulation } from "d3-force";
import { quadtree, type QuadtreeLeaf } from "d3-quadtree";
import { AnimatePresence, motion } from "framer-motion";

import { resolveAvatarForSender } from "../lib/avatar";
import { hashColor } from "../lib/gravatar";
import { senderEmail, senderLabel, type SenderSummary } from "../lib/imap";

interface BubbleNode {
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

function isPinned(n: BubbleNode): boolean {
  return n.fx != null;
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

/// Custom force: detects pairs whose circles overlap, separates them
/// positionally, and exchanges the *normal* component of velocity (equal-
/// mass elastic collision). Tangential velocity is left alone, so bubbles
/// glance off each other naturally. Uses d3-quadtree so we only check
/// candidate pairs in O(n log n) average time.
function forceBounce<T extends BubbleNode>() {
  let nodes: T[] = [];
  let maxRadius = 0;

  function force() {
    if (nodes.length < 2) return;
    const tree = quadtree<T>()
      .x((d) => d.x ?? 0)
      .y((d) => d.y ?? 0)
      .addAll(nodes);

    for (const a of nodes) {
      const ax = a.x ?? 0;
      const ay = a.y ?? 0;
      const reach = a.r + maxRadius;
      const x0 = ax - reach;
      const y0 = ay - reach;
      const x1 = ax + reach;
      const y1 = ay + reach;

      tree.visit((node, nx0, ny0, nx1, ny1) => {
        if (!("length" in node)) {
          let leaf: QuadtreeLeaf<T> | undefined = node;
          while (leaf) {
            const b = leaf.data;
            // Each pair handled exactly once (and never against self).
            if (b.key > a.key) {
              const dx = (b.x ?? 0) - ax;
              const dy = (b.y ?? 0) - ay;
              const dist = Math.hypot(dx, dy);
              const min = a.r + b.r;
              if (dist > 0 && dist < min) {
                const nx = dx / dist;
                const ny = dy / dist;
                const overlap = min - dist;
                const aPinned = isPinned(a);
                const bPinned = isPinned(b);
                if (aPinned && bPinned) {
                  // Both pinned — nothing to do.
                } else if (aPinned) {
                  // Treat `a` as an immovable wall: push only `b` and
                  // reflect its normal velocity component.
                  b.x = (b.x ?? 0) + nx * overlap;
                  b.y = (b.y ?? 0) + ny * overlap;
                  const vbn = (b.vx ?? 0) * nx + (b.vy ?? 0) * ny;
                  if (vbn < 0) {
                    b.vx = (b.vx ?? 0) - 2 * vbn * nx;
                    b.vy = (b.vy ?? 0) - 2 * vbn * ny;
                  }
                } else if (bPinned) {
                  a.x = ax - nx * overlap;
                  a.y = ay - ny * overlap;
                  const van = (a.vx ?? 0) * nx + (a.vy ?? 0) * ny;
                  if (van > 0) {
                    a.vx = (a.vx ?? 0) - 2 * van * nx;
                    a.vy = (a.vy ?? 0) - 2 * van * ny;
                  }
                } else {
                  // Both free — equal-mass elastic. Half the overlap to
                  // each, exchange normal velocity components when they
                  // are actually approaching.
                  const half = overlap / 2;
                  a.x = ax - nx * half;
                  a.y = ay - ny * half;
                  b.x = (b.x ?? 0) + nx * half;
                  b.y = (b.y ?? 0) + ny * half;
                  const va = (a.vx ?? 0) * nx + (a.vy ?? 0) * ny;
                  const vb = (b.vx ?? 0) * nx + (b.vy ?? 0) * ny;
                  if (va - vb > 0) {
                    const delta = va - vb;
                    a.vx = (a.vx ?? 0) - delta * nx;
                    a.vy = (a.vy ?? 0) - delta * ny;
                    b.vx = (b.vx ?? 0) + delta * nx;
                    b.vy = (b.vy ?? 0) + delta * ny;
                  }
                }
              }
            }
            leaf = leaf.next;
          }
        }
        return nx0 > x1 || nx1 < x0 || ny0 > y1 || ny1 < y0;
      });
    }
  }

  force.initialize = (n: T[]) => {
    nodes = n;
    maxRadius = nodes.reduce((m, d) => Math.max(m, d.r), 0);
  };
  return force;
}

/// Thermal kick: every tick, give each node a tiny random velocity
/// nudge. Combined with low (but nonzero) `velocityDecay`, this gives a
/// steady-state energy: friction sucks excess speed, thermal injection
/// keeps anything that's slowed down moving. Without it, balls that
/// happen to bleed all their kinetic energy through wall losses would
/// just sit there.
function forceThermal<T extends BubbleNode>(magnitude = 0.4) {
  let nodes: T[] = [];
  function force() {
    for (const n of nodes) {
      if (isPinned(n)) continue;
      n.vx = (n.vx ?? 0) + (Math.random() - 0.5) * magnitude;
      n.vy = (n.vy ?? 0) + (Math.random() - 0.5) * magnitude;
    }
  }
  force.initialize = (n: T[]) => {
    nodes = n;
  };
  return force;
}

/// Wall-bounce: clamp position into [r, size-r] and flip the velocity
/// component for the wall it hit. `restitution` < 1 lets bubbles lose a
/// little energy on each bounce so they don't pinball forever.
function forceWalls<T extends BubbleNode>(
  width: () => number,
  height: () => number,
  restitution = 0.95,
) {
  let nodes: T[] = [];

  function force() {
    const w = width();
    const h = height();
    for (const n of nodes) {
      if (isPinned(n)) continue;
      const x = n.x ?? 0;
      const y = n.y ?? 0;
      if (x < n.r) {
        n.x = n.r;
        if ((n.vx ?? 0) < 0) n.vx = -(n.vx ?? 0) * restitution;
      } else if (x > w - n.r) {
        n.x = w - n.r;
        if ((n.vx ?? 0) > 0) n.vx = -(n.vx ?? 0) * restitution;
      }
      if (y < n.r) {
        n.y = n.r;
        if ((n.vy ?? 0) < 0) n.vy = -(n.vy ?? 0) * restitution;
      } else if (y > h - n.r) {
        n.y = h - n.r;
        if ((n.vy ?? 0) > 0) n.vy = -(n.vy ?? 0) * restitution;
      }
    }
  }

  force.initialize = (n: T[]) => {
    nodes = n;
  };
  return force;
}

interface Props {
  senders: SenderSummary[];
  onPick: (s: SenderSummary) => void;
  /** Case-insensitive substring filter against displayName + email.
   *  Empty string = no filter. Non-matching bubbles fade out and stop
   *  intercepting clicks but stay in the simulation, so positions
   *  persist when the filter clears. */
  searchQuery?: string;
}

function senderMatchesQuery(s: SenderSummary, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const label = senderLabel(s).toLowerCase();
  const email = senderEmail(s).toLowerCase();
  return label.includes(q) || email.includes(q);
}

export function SenderBubbles({ senders, onPick, searchQuery = "" }: Props) {
  // Mutable state lives in refs so renders are cheap and the d3 tick can
  // write straight to the DOM without going through React.
  const nodesRef = useRef<BubbleNode[]>([]);
  const sizeRef = useRef({ w: 800, h: 600 });
  const simRef = useRef<Simulation<BubbleNode, undefined> | null>(null);
  const elemsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const lastSendersRef = useRef<SenderSummary[] | null>(null);
  const [, bumpRender] = useReducer((n: number) => n + 1, 0);

  // --- Render-phase reconciliation (no effect) -----------------------------
  // Diff senders → nodes whenever the senders prop identity changes. Mutating
  // refs during render is allowed; the side-effecting work (sim.nodes /
  // sim.alpha) is acting on an external system, not React state.
  if (lastSendersRef.current !== senders) {
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
        // disk cache first, falls back to Gravatar. Bump a render
        // counter once we have the URL so the backgroundImage paints.
        resolveAvatarForSender(s).then(({ url }) => {
          node.avatar = url;
          bumpRender();
        });
        added = true;
      }
    }
    const removed = existing.size > 0;
    nodesRef.current = next;
    lastSendersRef.current = senders;

    const sim = simRef.current;
    if (sim) {
      sim.nodes(next);
      if (added || removed) sim.alpha(0.4).restart();
    }
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

  // Per-bubble ref callback — register/unregister DOM elements so the d3
  // tick can write transforms straight to them.
  const bubbleRefFor = useCallback(
    (key: string) => (el: HTMLDivElement | null) => {
      if (el) elemsRef.current.set(key, el);
      else elemsRef.current.delete(key);
    },
    [],
  );

  return (
    <div
      ref={containerRef}
      style={{
        position: "relative",
        flex: 1,
        minHeight: "60vh",
        overflow: "hidden",
        borderRadius: 12,
        background:
          "radial-gradient(circle at 50% 40%, rgba(255,255,255,0.04), rgba(0,0,0,0.18))",
      }}
    >
      <AnimatePresence>
        {nodesRef.current.map((n) => {
          const hidden = !senderMatchesQuery(n.sender, searchQuery);
          return (
          <div
            key={n.key}
            ref={bubbleRefFor(n.key)}
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: n.r * 2,
              height: n.r * 2,
              opacity: hidden ? 0 : 1,
              pointerEvents: hidden ? "none" : "auto",
              transition: "opacity 180ms ease",
              willChange: "transform, opacity",
            }}
          >
            <motion.button
              type="button"
              onClick={() => onPick(n.sender)}
              onHoverStart={() => {
                if (isPinned(n)) return;
                n.savedVx = n.vx ?? 0;
                n.savedVy = n.vy ?? 0;
                n.fx = n.x ?? 0;
                n.fy = n.y ?? 0;
              }}
              onHoverEnd={() => {
                n.fx = null;
                n.fy = null;
                // Restore the drift the ball had when we paused it so it
                // doesn't sit dead until thermal noise picks it back up.
                n.vx = n.savedVx ?? 0;
                n.vy = n.savedVy ?? 0;
              }}
              style={{
                width: "100%",
                height: "100%",
                margin: 0,
                padding: 0,
                borderRadius: "50%",
                border: "1px solid rgba(255, 255, 255, 0.35)",
                boxShadow: "0 4px 14px rgba(0, 0, 0, 0.25)",
                backgroundColor: n.color,
                backgroundImage: n.avatar ? `url(${n.avatar})` : "none",
                backgroundSize: "cover",
                backgroundPosition: "center",
                cursor: "pointer",
                display: "block",
              }}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 220, damping: 18 }}
              whileHover={{ scale: 1.08 }}
              whileTap={{ scale: 0.95 }}
              aria-label={senderLabel(n.sender)}
              title={`${senderLabel(n.sender)} · ${n.sender.messageCount} messages${n.sender.unreadCount > 0 ? ` (${n.sender.unreadCount} unread)` : ""}`}
            />
            {n.sender.unreadCount > 0 && (() => {
              const label =
                n.sender.unreadCount > 99 ? "99+" : String(n.sender.unreadCount);
              // Width = height keeps the badge a perfect circle. Step the
              // size up with digit count so multi-digit numbers still fit.
              const size = label.length >= 3 ? 24 : label.length === 2 ? 20 : 18;
              return (
                <div
                  aria-hidden
                  style={{
                    position: "absolute",
                    top: -4,
                    right: -4,
                    width: size,
                    height: size,
                    borderRadius: "50%",
                    background: "#ff4d4f",
                    color: "white",
                    fontSize: label.length >= 3 ? 9 : 11,
                    fontWeight: 600,
                    lineHeight: `${size}px`,
                    textAlign: "center",
                    boxShadow: "0 2px 6px rgba(0, 0, 0, 0.4)",
                    border: "1.5px solid rgba(20, 20, 20, 0.9)",
                    boxSizing: "border-box",
                    pointerEvents: "none",
                  }}
                >
                  {label}
                </div>
              );
            })()}
          </div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
