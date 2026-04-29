import { quadtree, type QuadtreeLeaf } from "d3-quadtree";
import type { BubbleNode } from "../components/SenderBubbles";

export function isPinned(n: BubbleNode): boolean {
  return n.fx != null;
}

/// Custom force: detects pairs whose circles overlap, separates them
/// positionally, and exchanges the *normal* component of velocity (equal-
/// mass elastic collision). Tangential velocity is left alone, so bubbles
/// glance off each other naturally. Uses d3-quadtree so we only check
/// candidate pairs in O(n log n) average time.
export function forceBounce<T extends BubbleNode>() {
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
export function forceThermal<T extends BubbleNode>(magnitude = 0.4) {
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
export function forceWalls<T extends BubbleNode>(
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
