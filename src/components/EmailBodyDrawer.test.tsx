// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmailBodyDrawer } from "./EmailBodyDrawer";
import type { EmailBody } from "../lib/imap";

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(),
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

const mockBody: EmailBody = {
  uid: 1,
  subject: "Test subject",
  from: [{ name: "Alice", mailbox: "alice", host: "example.com" }],
  to: [{ name: "Bob", mailbox: "bob", host: "example.com" }],
  cc: [],
  date: "2024-01-01",
  textBody: "Hello world",
  htmlBody: null,
  attachments: [],
  inlineParts: [],
};

const mockHtmlBody: EmailBody = {
  ...mockBody,
  textBody: null,
  htmlBody: "<p>Hello world</p>",
};

describe("EmailBodyDrawer", () => {
  it("renders without crashing with text body", () => {
    const { container } = render(
      <EmailBodyDrawer body={mockBody} onClose={() => {}} />,
    );
    expect(container).toBeTruthy();
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders without crashing with html body", () => {
    const { container } = render(
      <EmailBodyDrawer body={mockHtmlBody} onClose={() => {}} />,
    );
    expect(container).toBeTruthy();
  });

  it("renders loading state", () => {
    render(
      <EmailBodyDrawer
        body={{ ...mockBody, textBody: null, htmlBody: null }}
        loading
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/Loading message/)).toBeInTheDocument();
  });

  it("renders no body state", () => {
    render(
      <EmailBodyDrawer
        body={{ ...mockBody, textBody: null, htmlBody: null }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/no body/)).toBeInTheDocument();
  });
});
