/**
 * Composed-store integration tests for useAppStore.
 *
 * These tests exercise cross-slice interactions that per-slice unit tests
 * cannot see: sign-out cascades across all four slices, pickSender ↔
 * loadEmailsForSender coordination, generation-counter races spanning
 * both senders and emails slices, and structural checks (no key
 * collisions). Per-slice behaviour is tested in the individual
 * `slices/*.test.ts` files — we do not duplicate those here.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

// ── localStorage stub ────────────────────────────────────────────────

class MemStorage implements Storage {
  private store = new Map<string, string>();
  get length() {
    return this.store.size;
  }
  clear() {
    this.store.clear();
  }
  getItem(key: string) {
    return this.store.get(key) ?? null;
  }
  key(index: number) {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string) {
    this.store.delete(key);
  }
  setItem(key: string, value: string) {
    this.store.set(key, value);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemStorage(),
    configurable: true,
  });
});

// ── IMAP mocks ───────────────────────────────────────────────────────

const mockStreamSenders = vi.fn();
const mockMergeSenders = vi.fn();
const mockSenderEmail = vi.fn();
const mockFetchEnvelopesByUids = vi.fn();
const mockFetchEmailsFromSender = vi.fn();
const mockFetchEmailBody = vi.fn();

vi.mock("../lib/imap", () => ({
  streamSenders: (...a: unknown[]) => mockStreamSenders(...a),
  mergeSenders: (...a: unknown[]) => mockMergeSenders(...a),
  senderEmail: (...a: unknown[]) => mockSenderEmail(...a),
  fetchEnvelopesByUids: (...a: unknown[]) => mockFetchEnvelopesByUids(...a),
  fetchEmailsFromSender: (...a: unknown[]) => mockFetchEmailsFromSender(...a),
  fetchEmailBody: (...a: unknown[]) => mockFetchEmailBody(...a),
}));

// ── Imports (after mocks) ────────────────────────────────────────────

import type { AccountConn, EmailEnvelope, SenderSummary } from "../lib/imap";
import type { AppStore } from "./types";
import { createAccountSlice, initialForm } from "./slices/account";
import { createSendersSlice } from "./slices/senders";
import { createEmailsSlice } from "./slices/emails";
import { createUiSlice } from "./slices/ui";

// ── Fixtures ─────────────────────────────────────────────────────────

const account: AccountConn = {
  host: "imap.example.com",
  port: 993,
  auth: { kind: "password", username: "u", password: "p" },
  mailbox: "INBOX",
};

function fakeSender(overrides: Partial<SenderSummary> = {}): SenderSummary {
  return {
    address: { name: null, mailbox: "user", host: "example.com" },
    displayName: null,
    messageCount: 1,
    unreadCount: 0,
    latestUid: 1,
    latestSubject: null,
    latestDate: null,
    uids: [1],
    hosts: ["example.com"],
    ...overrides,
  };
}

const senderA = fakeSender({
  address: { name: "Alice", mailbox: "alice", host: "example.com" },
  displayName: "Alice",
  unreadCount: 2,
  uids: [10, 9],
});

const senderB = fakeSender({
  address: { name: "Bob", mailbox: "bob", host: "example.com" },
  displayName: "Bob",
  unreadCount: 1,
  uids: [20],
});

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

// ── Store factory ────────────────────────────────────────────────────

/** Create a fresh composed store. Each call re-runs all slice creators
 *  so closure-scoped generation counters reset to zero. */
function makeStore() {
  return create<AppStore>()((...a) => ({
    ...createAccountSlice(...a),
    ...createSendersSlice(...a),
    ...createEmailsSlice(...a),
    ...createUiSlice(...a),
  }));
}

// ── Mock defaults ────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();

  mockMergeSenders.mockImplementation(
    (prev: SenderSummary[], delta: SenderSummary[]) => {
      const map = new Map(
        prev.map((s) => {
          const m = (s.address.mailbox ?? "").toLowerCase();
          const h = (s.address.host ?? "").toLowerCase();
          return [`${m}@${h}`, s];
        }),
      );
      for (const s of delta) {
        const m = (s.address.mailbox ?? "").toLowerCase();
        const h = (s.address.host ?? "").toLowerCase();
        map.set(`${m}@${h}`, s);
      }
      return Array.from(map.values()).sort((a, b) => b.latestUid - a.latestUid);
    },
  );

  mockSenderEmail.mockImplementation((s: SenderSummary) => {
    const m = (s.address.mailbox ?? "").toLowerCase();
    const h = (s.address.host ?? "").toLowerCase();
    return `${m}@${h}`;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ═══════════════════════════════════════════════════════════════════════
// 1. Structural: no key collisions across slices
// ═══════════════════════════════════════════════════════════════════════

describe("composed store – structural", () => {
  it("has no key collisions across slices", () => {
    const store = makeStore();
    const state = store.getState();

    // Build a map of key → which slice(s) own it. We check this by
    // creating each slice in isolation and comparing keys.
    const standalone = {
      account: Object.keys(createAccountSlice((() => {}) as never, () => state, store as never)),
      senders: Object.keys(createSendersSlice((() => {}) as never, () => state, store as never)),
      emails: Object.keys(createEmailsSlice((() => {}) as never, () => state, store as never)),
      ui: Object.keys(createUiSlice((() => {}) as never, () => state, store as never)),
    };

    // Any key appearing in more than one slice is a collision.
    const keyOwners = new Map<string, string[]>();
    for (const [slice, keys] of Object.entries(standalone)) {
      for (const k of keys) {
        const owners = keyOwners.get(k) ?? [];
        owners.push(slice);
        keyOwners.set(k, owners);
      }
    }

    const collisions = Array.from(keyOwners.entries())
      .filter(([, owners]) => owners.length > 1)
      .map(([key, owners]) => `${key} → [${owners.join(", ")}]`);

    expect(collisions).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. Full signOut cascade across all slices
// ═══════════════════════════════════════════════════════════════════════

describe("composed store – signOut cascade", () => {
  it("signOut alone restores entire store to initial state", () => {
    const store = makeStore();
    const s = store.getState;

    // Populate every slice with non-initial data
    s().setForm({ username: "alice@x.com", password: "secret" });
    s().setAccount(account);
    s().setStage("senders");
    s().persistCredentials({
      host: "imap.x.com",
      port: "993",
      username: "alice@x.com",
      password: "secret",
    });
    s().setSearchQuery("alice");
    s().setUnreadOnly(true);
    s().mergeSenderChunk([senderA]);
    s().pickSender(senderA);
    s().setError("[fetch] oops");
    s().setLoading(true);

    // Simulate having emails loaded
    store.setState({ emails: [envA10], emailsLoading: false });
    // Simulate body open
    store.setState({
      body: {
        uid: 10,
        subject: "Hi",
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

    // signOut cascades to all sibling slices automatically
    s().signOut();

    const after = s();

    // AccountSlice
    expect(after.form).toEqual(initialForm);
    expect(after.account).toBeNull();
    expect(after.stage).toBe("accounts");
    expect(after.hasSavedAccount).toBe(false);

    // SendersSlice
    expect(after.senders).toEqual([]);
    expect(after.activeSender).toBeNull();
    expect(after.searchQuery).toBe("");
    expect(after.unreadOnly).toBe(false);
    expect(after.sendersLoading).toBe(false);
    expect(after.sendersError).toBeNull();

    // EmailsSlice
    expect(after.emails).toEqual([]);
    expect(after.body).toBeNull();
    expect(after.bodyLoading).toBe(false);
    expect(after.emailsLoading).toBe(false);
    expect(after.emailsError).toBeNull();

    // UiSlice
    expect(after.loading).toBe(false);
    expect(after.error).toBeNull();
  });

  it("signOut alone resets senders, emails, and ui state", () => {
    // signOut cascades to sibling slices via the composed store.
    const store = makeStore();
    const s = store.getState;

    s().setStage("senders");
    s().setSearchQuery("test");
    s().setError("err");
    store.setState({ emails: [envA10] });

    s().signOut();

    const after = s();
    // AccountSlice is reset
    expect(after.stage).toBe("accounts");
    // Other slices are also reset by the cascade
    expect(after.searchQuery).toBe("");
    expect(after.error).toBeNull();
    expect(after.emails).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. pickSender → loadEmailsForSender coordination
// ═══════════════════════════════════════════════════════════════════════

describe("composed store – pickSender + loadEmailsForSender", () => {
  it("pickSender sets activeSender, then loadEmailsForSender populates emails for that sender", async () => {
    const store = makeStore();
    const s = store.getState;

    const gen = s().pickSender(senderA);
    expect(s().activeSender).toBe(senderA);
    expect(s().isFetchCurrent(gen)).toBe(true);

    mockFetchEnvelopesByUids.mockResolvedValueOnce([envA10]);
    await s().loadEmailsForSender(account, senderA);

    expect(s().emails).toEqual([envA10]);
    expect(s().emailsLoading).toBe(false);
    expect(s().body).toBeNull();
  });

  it("switching activeSender then loading emails replaces previous sender's emails", async () => {
    const store = makeStore();
    const s = store.getState;

    // Load emails for sender A
    s().pickSender(senderA);
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envA10]);
    await s().loadEmailsForSender(account, senderA);
    expect(s().emails).toEqual([envA10]);

    // Switch to sender B
    s().pickSender(senderB);
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envB20]);
    await s().loadEmailsForSender(account, senderB);
    expect(s().emails).toEqual([envB20]);
  });

  it("clearActiveSender does not auto-clear emails (caller must clearEmails)", () => {
    // Documents the contract: deselecting a sender leaves the email
    // list in place until the caller explicitly clears it.
    const store = makeStore();
    const s = store.getState;

    s().pickSender(senderA);
    store.setState({ emails: [envA10] });

    s().clearActiveSender();
    expect(s().activeSender).toBeNull();
    expect(s().emails).toEqual([envA10]); // still present

    // Caller must clearEmails separately
    s().clearEmails();
    expect(s().emails).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. Cross-slice generation-counter races
// ═══════════════════════════════════════════════════════════════════════

describe("composed store – cross-slice race conditions", () => {
  it("rapid sender switching discards stale envelope fetches even when pickSender gen is current", async () => {
    // Scenario: user clicks sender A → slow email fetch starts → user
    // clicks sender B → fast email fetch completes → A's fetch resolves
    // but should be discarded by the emails slice's own counter.
    const store = makeStore();
    const s = store.getState;

    // Sender A: slow fetch
    let resolveA: (v: EmailEnvelope[]) => void;
    mockFetchEnvelopesByUids.mockImplementationOnce(
      () => new Promise<EmailEnvelope[]>((r) => { resolveA = r; }),
    );
    // Sender B: fast fetch
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envB20]);

    // Click A
    s().pickSender(senderA);
    const promiseA = s().loadEmailsForSender(account, senderA);

    // Click B before A resolves
    s().pickSender(senderB);
    const promiseB = s().loadEmailsForSender(account, senderB);

    // B resolves
    await promiseB;
    expect(s().emails).toEqual([envB20]);

    // A resolves late — stale, should be discarded
    resolveA!([envA10]);
    await promiseA;
    expect(s().emails).toEqual([envB20]); // still B's emails
  });

  it("rapid sender switching discards stale body fetches", async () => {
    // User opens email from sender A, then switches to sender B and
    // opens an email there — A's body fetch is still in flight.
    const store = makeStore();
    const s = store.getState;

    // Seed envelopes for both senders
    store.setState({ emails: [envA10] });

    // Body fetch for email A: slow
    let resolveBodyA: (v: unknown) => void;
    mockFetchEmailBody.mockImplementationOnce(
      () => new Promise((r) => { resolveBodyA = r; }),
    );
    // Body fetch for email B: fast
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

    // Open email A
    s().loadBody(account, envA10);
    expect(s().body!.uid).toBe(10);
    expect(s().bodyLoading).toBe(true);

    // Switch to sender B and open email B
    s().pickSender(senderB);
    store.setState({ emails: [envB20] });
    s().loadBody(account, envB20);

    // Wait for B's body
    await vi.waitFor(() => {
      expect(store.getState().bodyLoading).toBe(false);
    });
    expect(s().body!.uid).toBe(20);

    // A's body resolves late — stale, discarded
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
    resolveBodyA!(bodyA);
    await new Promise((r) => setTimeout(r, 0));

    expect(s().body!.uid).toBe(20); // still B's body
  });

  it("loadEmailsForSender clears a previously-opened body drawer", async () => {
    // After switching senders, the body drawer should be cleared even
    // if the user had an email open from the previous sender.
    const store = makeStore();
    const s = store.getState;

    // Open sender A's email
    s().pickSender(senderA);
    store.setState({ emails: [envA10] });
    mockFetchEmailBody.mockResolvedValueOnce({
      uid: 10,
      subject: "Hi",
      from: [],
      to: [],
      cc: [],
      date: null,
      textBody: "body text",
      htmlBody: null,
      attachments: [],
      inlineParts: [],
    });
    s().loadBody(account, envA10);
    await vi.waitFor(() => {
      expect(store.getState().bodyLoading).toBe(false);
    });
    expect(s().body).not.toBeNull();

    // Switch to sender B — loadEmailsForSender clears body upfront
    s().pickSender(senderB);
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envB20]);
    const promise = s().loadEmailsForSender(account, senderB);

    // body is cleared even before the fetch resolves
    expect(s().body).toBeNull();

    await promise;
    expect(s().emails).toEqual([envB20]);
  });

  it("pickSender generation counter and emails senderFetchSeq are independent but coordinated", async () => {
    // Both counters reset to 0 when a new store is created. pickSender
    // increments _fetchGen; loadEmailsForSender increments
    // _senderFetchSeq. They are independent but the App layer uses
    // pickSender's gen to decide whether to call loadEmailsForSender.
    const store = makeStore();
    const s = store.getState;

    // First pick — both counters advance from 0 → 1
    const gen1 = s().pickSender(senderA);
    expect(gen1).toBe(1);
    expect(s().isFetchCurrent(gen1)).toBe(true);

    // Load emails for sender A — _senderFetchSeq goes 0 → 1
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envA10]);
    await s().loadEmailsForSender(account, senderA);
    expect(s().emails).toEqual([envA10]);

    // Second pick — _fetchGen goes 1 → 2
    const gen2 = s().pickSender(senderB);
    expect(gen2).toBe(2);
    expect(s().isFetchCurrent(gen1)).toBe(false);
    expect(s().isFetchCurrent(gen2)).toBe(true);

    // Load emails for sender B — _senderFetchSeq goes 1 → 2
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envB20]);
    await s().loadEmailsForSender(account, senderB);
    expect(s().emails).toEqual([envB20]);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. Cross-slice: decrementUnread after loadBody
// ═══════════════════════════════════════════════════════════════════════

describe("composed store – unread decrement after body open", () => {
  it("loadBody marks email seen; decrementUnread updates the sender badge", () => {
    // Simulates the cross-slice coordination the App layer performs:
    // 1. loadBody marks the email as \\Seen in the envelope list
    // 2. The caller also decrements the sender's unreadCount
    const store = makeStore();
    const s = store.getState;

    // Seed senders and emails
    s().mergeSenderChunk([senderA]); // unreadCount: 2
    s().pickSender(senderA);
    store.setState({ emails: [{ ...envA10, flags: [] }] });

    // Open email — marks it seen
    mockFetchEmailBody.mockReturnValueOnce(new Promise(() => {})); // pending
    s().loadBody(account, envA10);
    expect(s().emails[0].flags).toContain("\\Seen");

    // Caller also decrements the sender badge
    s().decrementUnread("alice@example.com");
    expect(s().senders[0].unreadCount).toBe(1); // was 2
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. Store re-creation resets generation counters
// ═══════════════════════════════════════════════════════════════════════

describe("composed store – generation counter lifecycle", () => {
  it("creating a new store resets all generation counters", async () => {
    const store1 = makeStore();
    const s1 = store1.getState;

    // Advance counters with multiple picks so gen values exceed what a
    // fresh store could produce with a single pick.
    s1().pickSender(senderA); // gen = 1
    const gen1 = s1().pickSender(senderB); // gen = 2

    mockFetchEnvelopesByUids.mockResolvedValueOnce([envA10]);
    await s1().loadEmailsForSender(account, senderA);

    // Create a fresh store — counters should reset
    const store2 = makeStore();
    const s2 = store2.getState;

    const gen2 = s2().pickSender(senderA);
    // gen2 should be 1 (reset counter starts at 0, increments to 1)
    expect(gen2).toBe(1);
    expect(s2().isFetchCurrent(gen2)).toBe(true);

    // Stale gen1 (= 2) should fail isFetchCurrent in the new store (counter at 1)
    expect(s2().isFetchCurrent(gen1)).toBe(false);
  });

  it("resetSenders resets the pickSender counter within the same store", () => {
    const store = makeStore();
    const s = store.getState;

    s().pickSender(senderA); // gen = 1
    const gen1 = s().pickSender(senderB); // gen = 2

    s().resetSenders(); // _fetchGen → 0

    const gen2 = s().pickSender(senderA);
    expect(gen2).toBe(1); // 0 → 1
    // gen1 (= 2) is stale because the counter reset to 0 and advanced to 1
    expect(s().isFetchCurrent(gen1)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. Error propagation across slices
// ═══════════════════════════════════════════════════════════════════════

describe("composed store – error state across slices", () => {
  it("sendersError and emailsError are independent of uiSlice error", () => {
    // All three error fields exist simultaneously without clobbering
    const store = makeStore();
    const s = store.getState;

    s().setError("global oops");
    store.setState({ sendersError: "sender fail" });
    store.setState({ emailsError: "email fail" });

    expect(s().error).toBe("global oops");
    expect(s().sendersError).toBe("sender fail");
    expect(s().emailsError).toBe("email fail");
  });

  it("pickSender clears sendersError but not emailsError or ui error", () => {
    const store = makeStore();
    const s = store.getState;

    store.setState({ sendersError: "old", emailsError: "old", error: "old" });
    s().pickSender(senderA);

    expect(s().sendersError).toBeNull();
    expect(s().emailsError).toBe("old");
    expect(s().error).toBe("old");
  });

  it("loadEmailsForSender clears emailsError upfront", async () => {
    const store = makeStore();
    const s = store.getState;

    store.setState({ emailsError: "old" });
    mockFetchEnvelopesByUids.mockResolvedValueOnce([envA10]);
    await s().loadEmailsForSender(account, senderA);

    expect(s().emailsError).toBeNull();
  });

  it("resetUi clears ui error but not senders/emails errors", () => {
    const store = makeStore();
    const s = store.getState;

    store.setState({ sendersError: "s", emailsError: "e", error: "u" });
    s().resetUi();

    expect(s().error).toBeNull();
    expect(s().sendersError).toBe("s");
    expect(s().emailsError).toBe("e");
  });

  it("signOut alone clears all three error fields", () => {
    const store = makeStore();
    const s = store.getState;

    store.setState({ sendersError: "s", emailsError: "e", error: "u" });
    s().signOut();

    expect(s().sendersError).toBeNull();
    expect(s().emailsError).toBeNull();
    expect(s().error).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. Loading flags across slices
// ═══════════════════════════════════════════════════════════════════════

describe("composed store – loading flags", () => {
  it("sendersLoading, emailsLoading, bodyLoading, and ui.loading are independent", () => {
    const store = makeStore();
    const s = store.getState;

    // Set each independently
    s().setLoading(true);
    store.setState({ sendersLoading: true, emailsLoading: true, bodyLoading: true });

    expect(s().loading).toBe(true);
    expect(s().sendersLoading).toBe(true);
    expect(s().emailsLoading).toBe(true);
    expect(s().bodyLoading).toBe(true);

    // Clear one — others stay
    s().setLoading(false);
    expect(s().loading).toBe(false);
    expect(s().sendersLoading).toBe(true);

    // Full cascade clears all
    s().resetSenders();
    s().clearEmails();
    s().resetUi();

    expect(s().sendersLoading).toBe(false);
    expect(s().emailsLoading).toBe(false);
    expect(s().bodyLoading).toBe(false);
    expect(s().loading).toBe(false);
  });
});
