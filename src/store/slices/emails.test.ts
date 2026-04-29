import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

// ---------------------------------------------------------------------------
// Mock the Tauri-backed IMAP functions before importing the slice, so the
// slice's top-level fetchEmailBody / fetchEnvelopesByUids / … references
// point at the mocks.
// ---------------------------------------------------------------------------

const mockFetchEnvelopesByUids = vi.fn();
const mockFetchEmailsFromSender = vi.fn();
const mockFetchEmailBody = vi.fn();
const mockSenderEmail = vi.fn();

vi.mock("../../lib/imap", () => ({
  fetchEnvelopesByUids: (...a: unknown[]) => mockFetchEnvelopesByUids(...a),
  fetchEmailsFromSender: (...a: unknown[]) => mockFetchEmailsFromSender(...a),
  fetchEmailBody: (...a: unknown[]) => mockFetchEmailBody(...a),
  senderEmail: (...a: unknown[]) => mockSenderEmail(...a),
}));

import type { AccountConn, EmailEnvelope, SenderSummary } from "../../lib/imap";
import type { AppStore } from "../types";
import { createAccountSlice } from "./account";
import { createEmailsSlice } from "./emails";
import { createSendersSlice } from "./senders";
import { createUiSlice } from "./ui";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const account: AccountConn = {
  host: "imap.example.com",
  port: 993,
  auth: { kind: "password", username: "u", password: "p" },
  mailbox: "INBOX",
};

const senderA: SenderSummary = {
  address: { name: null, mailbox: "alice", host: "example.com" },
  displayName: "Alice",
  messageCount: 2,
  unreadCount: 1,
  hosts: ["example.com"],
  latestUid: 10,
  latestSubject: "Hi from Alice",
  latestDate: null,
  uids: [10, 9],
};

const senderB: SenderSummary = {
  address: { name: null, mailbox: "bob", host: "example.com" },
  displayName: "Bob",
  messageCount: 1,
  unreadCount: 0,
  hosts: ["example.com"],
  latestUid: 20,
  latestSubject: "Hi from Bob",
  latestDate: null,
  uids: [20],
};

const envA10: EmailEnvelope = {
  uid: 10,
  subject: "Hi from Alice",
  from: [],
  to: [],
  cc: [],
  date: null,
  messageId: null,
  inReplyTo: null,
  flags: [],
};

const envB20: EmailEnvelope = {
  uid: 20,
  subject: "Hi from Bob",
  from: [],
  to: [],
  cc: [],
  date: null,
  messageId: null,
  inReplyTo: null,
  flags: [],
};

// ---------------------------------------------------------------------------
// Store factory — fresh per test so the generation counters reset.
// ---------------------------------------------------------------------------

function makeStore() {
  return create<AppStore>()((...a) => ({
    ...createAccountSlice(...a),
    ...createSendersSlice(...a),
    ...createEmailsSlice(...a),
    ...createUiSlice(...a),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSenderEmail.mockImplementation((s: SenderSummary) => {
    const m = (s.address.mailbox ?? "").toLowerCase();
    const h = (s.address.host ?? "").toLowerCase();
    return `${m}@${h}`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("emailsSlice — initial state", () => {
  it("starts with empty emails, null body, and no loading/error flags", () => {
    const store = makeStore();
    const s = store.getState();
    expect(s.emails).toEqual([]);
    expect(s.body).toBeNull();
    expect(s.bodyLoading).toBe(false);
    expect(s.emailsLoading).toBe(false);
    expect(s.emailsError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// closeBody / clearEmails
// ---------------------------------------------------------------------------

describe("emailsSlice — closeBody", () => {
  it("clears body and bodyLoading", () => {
    const store = makeStore();
    // Simulate an open body.
    store.setState({
      body: {
        uid: 10,
        subject: "test",
        from: [],
        to: [],
        cc: [],
        date: null,
        textBody: "hello",
        htmlBody: null,
        attachments: [],
        inlineParts: [],
      },
      bodyLoading: true,
    });
    store.getState().closeBody();
    expect(store.getState().body).toBeNull();
    expect(store.getState().bodyLoading).toBe(false);
  });
});

describe("emailsSlice — clearEmails", () => {
  it("resets all email state to initial values", () => {
    const store = makeStore();
    store.setState({
      emails: [envA10],
      body: {
        uid: 10,
        subject: "test",
        from: [],
        to: [],
        cc: [],
        date: null,
        textBody: "hello",
        htmlBody: null,
        attachments: [],
        inlineParts: [],
      },
      bodyLoading: true,
      emailsLoading: true,
      emailsError: "something broke",
    });
    store.getState().clearEmails();
    const s = store.getState();
    expect(s.emails).toEqual([]);
    expect(s.body).toBeNull();
    expect(s.bodyLoading).toBe(false);
    expect(s.emailsLoading).toBe(false);
    expect(s.emailsError).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// loadEmailsForSender
// ---------------------------------------------------------------------------

describe("emailsSlice — loadEmailsForSender", () => {
  it("fetches envelopes by UIDs and stores them", async () => {
    const store = makeStore();
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envA10]);

    await store.getState().loadEmailsForSender(account, senderA);

    expect(mockFetchEnvelopesByUids).toHaveBeenCalledWith(account, senderA.uids);
    expect(store.getState().emails).toEqual([envA10]);
    expect(store.getState().emailsLoading).toBe(false);
    expect(store.getState().emailsError).toBeNull();
  });

  it("falls back to fetchEmailsFromSender when sender has no UIDs", async () => {
    const store = makeStore();
    const senderNoUids: SenderSummary = { ...senderA, uids: [] };
    mockFetchEmailsFromSender.mockResolvedValueOnce([envA10]);

    await store.getState().loadEmailsForSender(account, senderNoUids);

    expect(mockFetchEmailsFromSender).toHaveBeenCalledWith(
      account,
      "alice@example.com",
      200,
    );
    expect(store.getState().emails).toEqual([envA10]);
  });

  it("clears body and previous emails upfront", async () => {
    const store = makeStore();
    store.setState({
      emails: [envB20],
      body: {
        uid: 20,
        subject: "old",
        from: [],
        to: [],
        cc: [],
        date: null,
        textBody: "old body",
        htmlBody: null,
        attachments: [],
        inlineParts: [],
      },
    });
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envA10]);

    const promise = store.getState().loadEmailsForSender(account, senderA);
    // Even before the fetch resolves, the body and emails should be cleared.
    expect(store.getState().body).toBeNull();
    expect(store.getState().emails).toEqual([]);
    await promise;
  });

  it("stores error on fetch failure", async () => {
    const store = makeStore();
    mockFetchEnvelopesByUids.mockRejectedValueOnce({
      kind: "fetch",
      message: "network error",
    });

    await store.getState().loadEmailsForSender(account, senderA);

    expect(store.getState().emailsError).toBe("[fetch] network error");
    expect(store.getState().emailsLoading).toBe(false);
  });

  it("discards stale envelope response when a newer fetch is issued", async () => {
    const store = makeStore();

    // First fetch for senderA resolves slowly.
    let resolveA: (v: EmailEnvelope[]) => void;
    mockFetchEnvelopesByUids.mockImplementationOnce(
      () => new Promise<EmailEnvelope[]>((r) => { resolveA = r; }),
    );

    // Second fetch for senderB resolves immediately.
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envB20]);

    // Fire both fetches — the user clicked from Alice to Bob before
    // Alice's fetch returned.
    const promiseA = store.getState().loadEmailsForSender(account, senderA);
    const promiseB = store.getState().loadEmailsForSender(account, senderB);

    // Bob's result should be stored.
    await promiseB;
    expect(store.getState().emails).toEqual([envB20]);
    expect(store.getState().emailsLoading).toBe(false);

    // Now resolve Alice's (stale) fetch.
    resolveA!([envA10]);
    await promiseA;

    // Emails should still be Bob's — the stale response was discarded.
    expect(store.getState().emails).toEqual([envB20]);
  });
});

// ---------------------------------------------------------------------------
// loadBody
// ---------------------------------------------------------------------------

describe("emailsSlice — loadBody", () => {
  it("sets a placeholder body immediately, then fills it on fetch", async () => {
    const store = makeStore();
    const fullBody = {
      uid: 10,
      subject: "Hi from Alice",
      from: [],
      to: [],
      cc: [],
      date: null,
      textBody: "Hello world",
      htmlBody: "<p>Hello world</p>",
      attachments: [],
      inlineParts: [],
    };
    mockFetchEmailBody.mockResolvedValueOnce(fullBody);

    store.getState().loadBody(account, envA10);

    // Placeholder should be set immediately.
    const placeholder = store.getState().body;
    expect(placeholder).not.toBeNull();
    expect(placeholder!.uid).toBe(10);
    expect(placeholder!.textBody).toBeNull();
    expect(placeholder!.htmlBody).toBeNull();
    expect(store.getState().bodyLoading).toBe(true);

    // Wait for the async fetch to resolve.
    await vi.waitFor(() => {
      expect(store.getState().bodyLoading).toBe(false);
    });
    expect(store.getState().body).toEqual(fullBody);
  });

  it("marks the email as seen in the envelope list", () => {
    const store = makeStore();
    store.setState({ emails: [{ ...envA10, flags: [] }] });
    mockFetchEmailBody.mockReturnValueOnce(new Promise(() => {})); // never resolves

    store.getState().loadBody(account, envA10);

    // The flag should be added immediately.
    expect(store.getState().emails[0].flags).toContain("\\Seen");
  });

  it("does not double-add \\Seen if already present", () => {
    const store = makeStore();
    const seenEnv = { ...envA10, flags: ["\\Seen"] };
    store.setState({ emails: [seenEnv] });
    mockFetchEmailBody.mockReturnValueOnce(new Promise(() => {}));

    store.getState().loadBody(account, seenEnv);

    expect(store.getState().emails[0].flags).toEqual(["\\Seen"]);
  });

  it("stores error on body fetch failure", async () => {
    const store = makeStore();
    mockFetchEmailBody.mockRejectedValueOnce({
      kind: "notFound",
      message: "uid vanished",
    });

    store.getState().loadBody(account, envA10);

    await vi.waitFor(() => {
      expect(store.getState().bodyLoading).toBe(false);
    });
    expect(store.getState().emailsError).toBe("[notFound] uid vanished");
  });

  it("discards stale body response when a newer loadBody is issued", async () => {
    const store = makeStore();

    // First loadBody for envA10 resolves slowly.
    let resolveA: (v: unknown) => void;
    mockFetchEmailBody.mockImplementationOnce(
      () => new Promise((r) => { resolveA = r; }),
    );

    // Second loadBody for envB20 resolves immediately.
    const bodyB = {
      uid: 20,
      subject: "Hi from Bob",
      from: [],
      to: [],
      cc: [],
      date: null,
      textBody: "Bob's body",
      htmlBody: null,
      attachments: [],
      inlineParts: [],
    };
    mockFetchEmailBody.mockResolvedValueOnce(bodyB);

    // Fire both — user clicked from email A to email B before A's body
    // fetch returned.
    store.getState().loadBody(account, envA10);
    store.getState().loadBody(account, envB20);

    // Bob's body should land.
    await vi.waitFor(() => {
      expect(store.getState().bodyLoading).toBe(false);
    });
    expect(store.getState().body!.uid).toBe(20);

    // Now resolve Alice's (stale) body fetch.
    const bodyA = {
      uid: 10,
      subject: "Hi from Alice",
      from: [],
      to: [],
      cc: [],
      date: null,
      textBody: "Alice's body",
      htmlBody: null,
      attachments: [],
      inlineParts: [],
    };
    resolveA!(bodyA);
    // Allow microtask queue to flush.
    await new Promise((r) => setTimeout(r, 0));

    // Body should still be Bob's — the stale response was discarded.
    expect(store.getState().body!.uid).toBe(20);
    expect(store.getState().bodyLoading).toBe(false);
  });

  it("discards stale body response when the sender is switched", async () => {
    const store = makeStore();

    // Start loading body for envA10 — fetch will resolve slowly.
    let resolveA: (v: unknown) => void;
    mockFetchEmailBody.mockImplementationOnce(
      () => new Promise((r) => { resolveA = r; }),
    );

    store.getState().loadBody(account, envA10);

    // Placeholder should be set.
    expect(store.getState().body).not.toBeNull();
    expect(store.getState().body!.uid).toBe(10);

    // User switches to senderB — this clears body and bumps _bodyFetchSeq.
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envB20]);
    await store.getState().loadEmailsForSender(account, senderB);

    // Body should be cleared by the sender switch.
    expect(store.getState().body).toBeNull();

    // Now the old body fetch resolves.
    const bodyA = {
      uid: 10,
      subject: "Hi from Alice",
      from: [],
      to: [],
      cc: [],
      date: null,
      textBody: "Alice's body",
      htmlBody: null,
      attachments: [],
      inlineParts: [],
    };
    resolveA!(bodyA);
    await new Promise((r) => setTimeout(r, 0));

    // Body should remain null — the stale response was discarded.
    expect(store.getState().body).toBeNull();
  });
});
