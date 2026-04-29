import { describe, expect, it } from "vitest";
import { forceBounce, forceThermal, forceWalls, isPinned } from "./physics";
import type { BubbleNode } from "../components/SenderBubbles";

function makeNode(
  key: string,
  x: number,
  y: number,
  r: number,
  vx = 0,
  vy = 0,
): BubbleNode {
  return {
    key,
    sender: {
      address: { name: null, mailbox: "test", host: "example.com" },
      displayName: "Test",
      messageCount: 1,
      unreadCount: 0,
      hosts: ["example.com"],
      latestUid: 1,
      latestSubject: null,
      latestDate: null,
      uids: [1],
    },
    r,
    x,
    y,
    vx,
    vy,
    avatar: null,
    color: "#000000",
  };
}

describe("isPinned", () => {
  it("returns true when fx is a number", () => {
    const node = makeNode("a", 0, 0, 10);
    node.fx = 5;
    expect(isPinned(node)).toBe(true);
  });

  it("returns false when fx is null or undefined", () => {
    const node = makeNode("a", 0, 0, 10);
    expect(isPinned(node)).toBe(false);
    node.fx = null;
    expect(isPinned(node)).toBe(false);
  });
});

describe("forceThermal", () => {
  it("nudges velocities of unpinned nodes over ticks", () => {
    const nodes: BubbleNode[] = [
      makeNode("a", 50, 50, 10, 0, 0),
      makeNode("b", 60, 60, 10, 0, 0),
    ];
    const force = forceThermal(1.0);
    force.initialize(nodes);

    for (let i = 0; i < 10; i++) {
      force();
    }

    // After 10 thermal kicks velocities should have changed from zero
    // (extremely unlikely all 20 random samples cancel out).
    expect(nodes[0].vx !== 0 || nodes[0].vy !== 0).toBe(true);
  });

  it("does not move pinned nodes", () => {
    const node = makeNode("a", 50, 50, 10, 0, 0);
    node.fx = 50;
    const force = forceThermal(1.0);
    force.initialize([node]);

    force();

    expect(node.vx).toBe(0);
    expect(node.vy).toBe(0);
  });
});

describe("forceWalls", () => {
  it("keeps nodes inside bounds and flips velocity on collision", () => {
    const nodes: BubbleNode[] = [makeNode("a", -5, 50, 10, -2, 0)];
    const force = forceWalls(() => 100, () => 100, 0.95);
    force.initialize(nodes);

    force();

    expect(nodes[0].x).toBe(10); // clamped to r
    expect(nodes[0].vx).toBeGreaterThan(0); // flipped and reduced by restitution
  });

  it("does not affect nodes already inside bounds", () => {
    const nodes: BubbleNode[] = [makeNode("a", 50, 50, 10, 1, 1)];
    const force = forceWalls(() => 100, () => 100);
    force.initialize(nodes);

    force();

    expect(nodes[0].x).toBe(50);
    expect(nodes[0].y).toBe(50);
    expect(nodes[0].vx).toBe(1);
    expect(nodes[0].vy).toBe(1);
  });
});

describe("forceBounce", () => {
  it("separates overlapping nodes", () => {
    const nodes: BubbleNode[] = [
      makeNode("a", 50, 50, 10),
      makeNode("b", 59, 50, 10),
    ];
    const force = forceBounce();
    force.initialize(nodes);

    force();

    const dist = Math.hypot(
      (nodes[0].x ?? 0) - (nodes[1].x ?? 0),
      (nodes[0].y ?? 0) - (nodes[1].y ?? 0),
    );
    expect(dist).toBeGreaterThanOrEqual(20 - 0.001);
  });

  it("exchanges normal velocity on collision", () => {
    const nodes: BubbleNode[] = [
      makeNode("a", 50, 50, 10, 2, 0),
      makeNode("b", 59, 50, 10, -2, 0),
    ];
    const force = forceBounce();
    force.initialize(nodes);

    force();

    // After collision, the approaching normal velocities should have changed.
    expect(nodes[0].vx).not.toBe(2);
    expect(nodes[1].vx).not.toBe(-2);
  });

  it("does not process pinned-pinned pairs", () => {
    const a = makeNode("a", 50, 50, 10);
    const b = makeNode("b", 59, 50, 10);
    a.fx = 50;
    b.fx = 50;
    const nodes = [a, b];
    const force = forceBounce();
    force.initialize(nodes);

    force();

    expect(nodes[0].x).toBe(50);
    expect(nodes[0].y).toBe(50);
    expect(nodes[1].x).toBe(59);
    expect(nodes[1].y).toBe(50);
  });
});
