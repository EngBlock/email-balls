import { describe, expect, it, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  fetchEmailBody,
  fetchEmailsFromSender,
  listSenders,
  senderEmail,
  senderLabel,
  type AccountConn,
  type SenderSummary,
} from "./imap";

const account: AccountConn = {
  host: "imap.example.com",
  port: 993,
  auth: { kind: "password", username: "u", password: "p" },
  mailbox: "INBOX",
};

beforeEach(() => {
  invokeMock.mockReset();
});

describe("listSenders", () => {
  it("invokes the list_senders command and forwards account fields plus scanLimit", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await listSenders(account, 250);
    expect(invokeMock).toHaveBeenCalledWith("list_senders", {
      ...account,
      scanLimit: 250,
    });
  });

  it("omits scanLimit when not provided (sends undefined, command treats as default)", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await listSenders(account);
    const arg = invokeMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(arg.scanLimit).toBeUndefined();
    expect(arg.host).toBe("imap.example.com");
  });

  it("returns the sender summaries from the command unchanged", async () => {
    const summaries: SenderSummary[] = [
      {
        address: { name: null, mailbox: "ada", host: "example.com" },
        displayName: "Ada L.",
        messageCount: 3,
        unreadCount: 1,
        hosts: ["example.com"],
        latestUid: 42,
        latestSubject: "Hi",
        latestDate: null,
        uids: [42, 41, 40],
      },
    ];
    invokeMock.mockResolvedValueOnce(summaries);
    await expect(listSenders(account)).resolves.toEqual(summaries);
  });
});

describe("fetchEmailsFromSender", () => {
  it("forwards fromAddress and optional limit using the snake_case-aligned camelCase keys", async () => {
    invokeMock.mockResolvedValueOnce([]);
    await fetchEmailsFromSender(account, "noreply@example.org", 25);
    expect(invokeMock).toHaveBeenCalledWith("fetch_emails_from_sender", {
      ...account,
      fromAddress: "noreply@example.org",
      limit: 25,
    });
  });

  it("propagates command errors back to the caller", async () => {
    invokeMock.mockRejectedValueOnce({ kind: "auth", message: "bad creds" });
    await expect(
      fetchEmailsFromSender(account, "x@y.com"),
    ).rejects.toMatchObject({ kind: "auth" });
  });
});

describe("fetchEmailBody", () => {
  it("invokes fetch_email_body with the uid", async () => {
    invokeMock.mockResolvedValueOnce({
      uid: 7,
      subject: "Hi",
      from: [],
      to: [],
      cc: [],
      date: null,
      textBody: "body",
      htmlBody: null,
      attachments: [],
    });
    const body = await fetchEmailBody(account, 7);
    expect(invokeMock).toHaveBeenCalledWith("fetch_email_body", {
      ...account,
      uid: 7,
    });
    expect(body.textBody).toBe("body");
  });
});

describe("senderLabel / senderEmail", () => {
  const base: SenderSummary = {
    address: { name: null, mailbox: "ada", host: "example.com" },
    displayName: "Ada Lovelace",
    messageCount: 1,
    unreadCount: 0,
    hosts: ["example.com"],
    latestUid: 1,
    latestSubject: null,
    latestDate: null,
    uids: [1],
  };

  it("prefers displayName when present", () => {
    expect(senderLabel(base)).toBe("Ada Lovelace");
  });

  it("falls back to mailbox@host when displayName is null", () => {
    expect(senderLabel({ ...base, displayName: null })).toBe(
      "ada@example.com",
    );
  });

  it("senderEmail always returns mailbox@host (no display name fallback)", () => {
    expect(senderEmail(base)).toBe("ada@example.com");
  });

  it("handles missing host gracefully (returns just mailbox)", () => {
    const s: SenderSummary = {
      ...base,
      displayName: null,
      address: { name: null, mailbox: "lonely", host: null },
    };
    expect(senderLabel(s)).toBe("lonely");
    expect(senderEmail(s)).toBe("lonely");
  });
});
