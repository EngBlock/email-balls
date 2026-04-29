// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmailListDrawer } from "./EmailListDrawer";
import type { EmailEnvelope, SenderSummary } from "../lib/imap";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../lib/avatar", () => ({
  resolveAvatarForSender: vi.fn().mockResolvedValue({
    url: "https://example.com/avatar.png",
  }),
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
      aside: makeMotion("aside"),
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

const mockEmail: EmailEnvelope = {
  uid: 1,
  subject: "Test subject",
  from: [{ name: "Alice", mailbox: "alice", host: "example.com" }],
  to: [{ name: "Bob", mailbox: "bob", host: "example.com" }],
  cc: [],
  date: "2024-01-01",
  messageId: "<msg1@example.com>",
  inReplyTo: null,
  flags: ["\\Seen"],
};

describe("EmailListDrawer", () => {
  it("renders without crashing", () => {
    const { container } = render(
      <EmailListDrawer
        sender={mockSender}
        emails={[mockEmail]}
        loading={false}
        bodyOpen={false}
        bodyDrawerWidth={560}
        onPickEmail={() => {}}
        onClose={() => {}}
      />,
    );
    expect(container).toBeTruthy();
    expect(screen.getByText("Test subject")).toBeInTheDocument();
  });

  it("renders loading state", () => {
    render(
      <EmailListDrawer
        sender={mockSender}
        emails={[]}
        loading
        bodyOpen={false}
        bodyDrawerWidth={560}
        onPickEmail={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Loading messages/)).toBeInTheDocument();
  });

  it("renders empty state", () => {
    render(
      <EmailListDrawer
        sender={mockSender}
        emails={[]}
        loading={false}
        bodyOpen={false}
        bodyDrawerWidth={560}
        onPickEmail={() => {}}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/No messages/)).toBeInTheDocument();
  });
});
