// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { SenderBubbles } from "./SenderBubbles";
import type { SenderSummary } from "../lib/imap";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../lib/avatar", () => ({
  resolveAvatarForSender: vi.fn().mockResolvedValue({
    url: "https://example.com/avatar.png",
  }),
}));

vi.mock("../lib/physics", () => ({
  forceBounce: vi.fn(() => vi.fn()),
  forceThermal: vi.fn(() => vi.fn()),
  forceWalls: vi.fn(() => vi.fn()),
  isPinned: vi.fn(() => false),
}));

vi.mock("d3-force", () => ({
  forceSimulation: vi.fn(() => ({
    velocityDecay: vi.fn().mockReturnThis(),
    alphaTarget: vi.fn().mockReturnThis(),
    alpha: vi.fn().mockReturnThis(),
    restart: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    nodes: vi.fn().mockReturnThis(),
    force: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
  })),
}));

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const makeMotion = (tag: string) => {
    return React.forwardRef((props: any, ref: any) => {
      const {
        initial,
        animate,
        exit,
        transition,
        whileHover,
        whileTap,
        onHoverStart,
        onHoverEnd,
        ...rest
      } = props;
      return React.createElement(tag, { ...rest, ref });
    });
  };
  return {
    motion: {
      button: makeMotion("button"),
    },
    AnimatePresence: ({ children }: any) =>
      React.createElement(React.Fragment, null, children),
  };
});

const mockSender: SenderSummary = {
  address: { name: "Alice", mailbox: "alice", host: "example.com" },
  displayName: "Alice",
  messageCount: 5,
  unreadCount: 2,
  hosts: ["example.com"],
  latestUid: 10,
  latestSubject: "Hello",
  latestDate: "2024-01-01",
  uids: [10, 9, 8],
};

describe("SenderBubbles", () => {
  it("renders without crashing", () => {
    const { container } = render(
      <SenderBubbles senders={[mockSender]} onPick={() => {}} />,
    );
    expect(container).toBeTruthy();
  });

  it("renders with empty senders", () => {
    const { container } = render(
      <SenderBubbles senders={[]} onPick={() => {}} />,
    );
    expect(container).toBeTruthy();
  });
});
