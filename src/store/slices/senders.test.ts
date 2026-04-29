import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create } from "zustand";

import type { AppStore } from "../types";
import { createAccountSlice } from "./account";
import { createEmailsSlice } from "./emails";
import { createSendersSlice, type SendersSlice } from "./senders";
import { createUiSlice } from "./ui";

// Mock imap functions that the senders slice calls directly (streamSenders).
// The emails slice also imports from imap, so we mock everything it might
// call to prevent real Tauri invocations.
const mockStreamSenders = vi.fn();
const mockMergeSenders = vi.fn();
const mockSenderEmail = vi.fn();

vi.mock("../../lib/imap", () => ({
  streamSenders: (...a: unknown[]) => mockStreamSenders(...a),
  mergeSenders: (...a: unknown[]) => mockMergeSenders(...a),
  senderEmail: (...a: unknown[]) => mockSenderEmail(...a),
  // Stubs for the emails slice (not exercised in these tests).
  fetchEnvelopesByUids: vi.fn(),
  fetchEmailsFromSender: vi.fn(),
  fetchEmailBody: vi.fn(),
}));

import type { SenderSummary } from "../../lib/imap";

/** Build a full store so slice cross-references resolve correctly. */
function makeStore() {
  return create<AppStore>()((...a) => ({
    ...createAccountSlice(...a),
    ...createSendersSlice(...a),
    ...createEmailsSlice(...a),
    ...createUiSlice(...a),
  }));
}

/** Minimal SenderSummary factory. */
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

beforeEach(() => {
  vi.clearAllMocks();
  // Default: mergeSenders just concatenates and sorts by latestUid desc.
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

function senders(store: ReturnType<typeof makeStore>): SendersSlice {
  return store.getState() as SendersSlice;
}

describe("sendersSlice", () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore();
  });

  // ── Initial state ────────────────────────────────────────────────

  it("initialises with empty senders, no active sender, no filters", () => {
    const s = senders(store);
    expect(s.senders).toEqual([]);
    expect(s.activeSender).toBeNull();
    expect(s.searchQuery).toBe("");
    expect(s.unreadOnly).toBe(false);
    expect(s.sendersLoading).toBe(false);
    expect(s.sendersError).toBeNull();
  });

  // ── Generation counter / stale-request discard ────────────────────

  describe("pickSender generation counter", () => {
    it("returns a monotonically increasing generation number", () => {
      const a = fakeSender({
        address: { name: "A", mailbox: "a", host: "x.com" },
      });
      const b = fakeSender({
        address: { name: "B", mailbox: "b", host: "x.com" },
      });

      const gen1 = senders(store).pickSender(a);
      const gen2 = senders(store).pickSender(b);

      expect(gen2).toBeGreaterThan(gen1);
      expect(senders(store).isFetchCurrent(gen2)).toBe(true);
      expect(senders(store).isFetchCurrent(gen1)).toBe(false);
    });

    it("isFetchCurrent returns false for a stale gen after a newer pick", () => {
      const a = fakeSender({
        address: { name: "A", mailbox: "a", host: "x.com" },
      });
      const b = fakeSender({
        address: { name: "B", mailbox: "b", host: "x.com" },
      });

      const staleGen = senders(store).pickSender(a);
      senders(store).pickSender(b);

      expect(senders(store).isFetchCurrent(staleGen)).toBe(false);
    });

    it("isFetchCurrent returns true when no newer pick has occurred", () => {
      const a = fakeSender({
        address: { name: "A", mailbox: "a", host: "x.com" },
      });
      const gen = senders(store).pickSender(a);
      expect(senders(store).isFetchCurrent(gen)).toBe(true);
    });

    it("simulates stale response discard: only the latest pick's results apply", () => {
      const senderA = fakeSender({
        address: { name: "A", mailbox: "alice", host: "x.com" },
      });
      const senderB = fakeSender({
        address: { name: "B", mailbox: "bob", host: "x.com" },
      });

      // User clicks sender A — slow fetch begins
      const genA = senders(store).pickSender(senderA);
      expect(senders(store).activeSender).toBe(senderA);

      // User quickly clicks sender B before A's fetch returns
      const genB = senders(store).pickSender(senderB);
      expect(senders(store).activeSender).toBe(senderB);

      // A's fetch finally resolves — stale, should be discarded
      expect(senders(store).isFetchCurrent(genA)).toBe(false);

      // B's fetch resolves — current, should be applied
      expect(senders(store).isFetchCurrent(genB)).toBe(true);
    });

    it("resets the generation counter on resetSenders", () => {
      const a = fakeSender();
      const gen = senders(store).pickSender(a);
      expect(gen).toBeGreaterThan(0);

      senders(store).resetSenders();

      // After reset, the old gen is stale (counter is 0 again)
      expect(senders(store).isFetchCurrent(gen)).toBe(false);

      // A fresh pick starts from 1 again
      const newGen = senders(store).pickSender(a);
      expect(newGen).toBe(1);
      expect(senders(store).isFetchCurrent(newGen)).toBe(true);
    });
  });

  // ── Simple state actions ──────────────────────────────────────────

  it("setSearchQuery updates the query", () => {
    senders(store).setSearchQuery("alice");
    expect(senders(store).searchQuery).toBe("alice");
  });

  it("setUnreadOnly toggles the flag", () => {
    senders(store).setUnreadOnly(true);
    expect(senders(store).unreadOnly).toBe(true);
    senders(store).setUnreadOnly(false);
    expect(senders(store).unreadOnly).toBe(false);
  });

  it("clearActiveSender sets activeSender back to null", () => {
    const a = fakeSender();
    senders(store).pickSender(a);
    expect(senders(store).activeSender).toBe(a);
    senders(store).clearActiveSender();
    expect(senders(store).activeSender).toBeNull();
  });

  it("mergeSenderChunk appends / updates senders", () => {
    const a = fakeSender({
      address: { name: null, mailbox: "alice", host: "x.com" },
      messageCount: 3,
    });
    senders(store).mergeSenderChunk([a]);
    expect(senders(store).senders).toHaveLength(1);
    expect(senders(store).senders[0].messageCount).toBe(3);

    // Merge an update for the same sender
    const aUpdated = fakeSender({
      address: { name: null, mailbox: "alice", host: "x.com" },
      messageCount: 5,
    });
    senders(store).mergeSenderChunk([aUpdated]);
    expect(senders(store).senders).toHaveLength(1);
    expect(senders(store).senders[0].messageCount).toBe(5);
  });

  it("decrementUnread reduces unreadCount on the matching sender", () => {
    const a = fakeSender({
      address: { name: null, mailbox: "alice", host: "x.com" },
      unreadCount: 3,
    });
    senders(store).mergeSenderChunk([a]);
    senders(store).decrementUnread("alice@x.com");
    expect(senders(store).senders[0].unreadCount).toBe(2);
  });

  it("decrementUnread floors at zero", () => {
    const a = fakeSender({
      address: { name: null, mailbox: "alice", host: "x.com" },
      unreadCount: 0,
    });
    senders(store).mergeSenderChunk([a]);
    senders(store).decrementUnread("alice@x.com");
    expect(senders(store).senders[0].unreadCount).toBe(0);
  });

  it("resetSenders clears all sender state", () => {
    const a = fakeSender();
    senders(store).pickSender(a);
    senders(store).setSearchQuery("test");
    senders(store).setUnreadOnly(true);
    senders(store).mergeSenderChunk([a]);

    senders(store).resetSenders();

    const s = senders(store);
    expect(s.senders).toEqual([]);
    expect(s.activeSender).toBeNull();
    expect(s.searchQuery).toBe("");
    expect(s.unreadOnly).toBe(false);
    expect(s.sendersLoading).toBe(false);
    expect(s.sendersError).toBeNull();
  });
});
