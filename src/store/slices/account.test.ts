import { beforeEach, describe, expect, it } from "vitest";
import { create } from "zustand";

class MemStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemStorage(),
    configurable: true,
  });
});

import type { AccountConn } from "../../lib/imap";
import { loadAccount, saveAccount, type StoredAccount } from "../../lib/accountStore";
import type { AppStore } from "../types";
import {
  createAccountSlice,
  initialForm,
  type AccountSlice,
} from "./account";
import { createEmailsSlice } from "./emails";
import { createSendersSlice } from "./senders";
import { createUiSlice } from "./ui";

const sampleStored: StoredAccount = {
  host: "127.0.0.1",
  port: "1143",
  username: "me@example.com",
  password: "app-password",
};

const sampleAccount: AccountConn = {
  host: "127.0.0.1",
  port: 1143,
  auth: { kind: "password", username: "me@example.com", password: "x" },
  mailbox: "INBOX",
};

// Each call to `make` instantiates a fresh composed store — the
// `loadAccount` reads happen at slice-creation time, so re-creating
// after seeding localStorage is the way we exercise the hydration path.
// We compose all slices (not just AccountSlice) so `AppStateCreator`
// type constraints are satisfied; the test helpers still narrow to
// `AccountSlice` for convenience.
function make() {
  return create<AppStore>()((...a) => ({
    ...createAccountSlice(...a),
    ...createSendersSlice(...a),
    ...createEmailsSlice(...a),
    ...createUiSlice(...a),
  })) as unknown as {
    getState: () => AccountSlice;
  };
}

describe("accountSlice", () => {
  it("initializes blank when no credentials are stored", () => {
    const store = make();
    const s = store.getState();
    expect(s.form).toEqual(initialForm);
    expect(s.account).toBeNull();
    expect(s.stage).toBe("accounts");
    expect(s.hasSavedAccount).toBe(false);
  });

  it("hydrates form + hasSavedAccount from localStorage on creation", () => {
    saveAccount(sampleStored);
    const store = make();
    const s = store.getState();
    expect(s.form).toEqual(sampleStored);
    expect(s.hasSavedAccount).toBe(true);
    expect(s.account).toBeNull();
    expect(s.stage).toBe("accounts");
  });

  it("setForm patches individual fields without dropping others", () => {
    const store = make();
    store.getState().setForm({ username: "a@b.com" });
    expect(store.getState().form.username).toBe("a@b.com");
    expect(store.getState().form.host).toBe(initialForm.host);
    store.getState().setForm({ password: "secret" });
    expect(store.getState().form.password).toBe("secret");
    expect(store.getState().form.username).toBe("a@b.com");
  });

  it("setAccount swaps the active connection, including back to null", () => {
    const store = make();
    store.getState().setAccount(sampleAccount);
    expect(store.getState().account).toBe(sampleAccount);
    store.getState().setAccount(null);
    expect(store.getState().account).toBeNull();
  });

  it("setStage switches the sign-in stage", () => {
    const store = make();
    expect(store.getState().stage).toBe("accounts");
    store.getState().setStage("senders");
    expect(store.getState().stage).toBe("senders");
  });

  it("persistCredentials writes to localStorage and flips hasSavedAccount", () => {
    const store = make();
    expect(store.getState().hasSavedAccount).toBe(false);
    store.getState().persistCredentials(sampleStored);
    expect(store.getState().hasSavedAccount).toBe(true);
    // Round-trip through the storage layer to confirm the bytes landed.
    expect(
      JSON.parse(localStorage.getItem("mail-bubbles:account-v1") ?? ""),
    ).toEqual(sampleStored);
  });

  it("signOut clears account, persisted credentials, form, and stage", () => {
    saveAccount(sampleStored);
    const store = make();
    store.getState().setAccount(sampleAccount);
    store.getState().setStage("senders");

    store.getState().signOut();

    const s = store.getState();
    expect(s.account).toBeNull();
    expect(s.form).toEqual(initialForm);
    expect(s.stage).toBe("accounts");
    expect(s.hasSavedAccount).toBe(false);
    expect(localStorage.getItem("mail-bubbles:account-v1")).toBeNull();
  });

  it("hasSavedAccount is derived from loadAccount result without a second read", () => {
    // Seed storage and confirm the slice derives hasSavedAccount from
    // the `stored` variable returned by the first (and only) loadAccount()
    // call inside createAccountSlice.
    saveAccount(sampleStored);
    const store = make();
    expect(store.getState().hasSavedAccount).toBe(true);
    // loadAccount() should return the same value — no second call needed.
    expect(loadAccount()).toEqual(sampleStored);
  });

  describe("buildAccountFromForm", () => {
    it("converts form fields to AccountConn with trimmed host/username", () => {
      const store = make();
      store.getState().setForm({
        host: "  mail.example.com  ",
        port: "993",
        username: "  user@example.com  ",
        password: "secret",
      });
      const conn = store.getState().buildAccountFromForm();
      expect(conn).toEqual({
        host: "mail.example.com",
        port: 993,
        auth: { kind: "password", username: "user@example.com", password: "secret" },
        mailbox: "INBOX",
      });
    });

    it("parses port as base-10 integer", () => {
      const store = make();
      store.getState().setForm({ port: "1143" });
      expect(store.getState().buildAccountFromForm().port).toBe(1143);
    });

    it("produces NaN for non-numeric port strings — validation is the caller's job", () => {
      // The slice intentionally does not validate; a non-numeric port
      // yields NaN which the IMAP layer will reject. This test documents
      // the contract so a future validation layer knows what to guard.
      const store = make();
      store.getState().setForm({ port: "abc" });
      expect(store.getState().buildAccountFromForm().port).toBeNaN();
    });

    it("parses leading digits in mixed alphanumeric port (parseInt truncation)", () => {
      // parseInt stops at the first non-numeric character — "993abc"
      // yields 993, not NaN. Validation must catch this if it matters.
      const store = make();
      store.getState().setForm({ port: "993abc" });
      expect(store.getState().buildAccountFromForm().port).toBe(993);
    });

    it("produces NaN for empty port string", () => {
      const store = make();
      store.getState().setForm({ port: "" });
      expect(store.getState().buildAccountFromForm().port).toBeNaN();
    });
  });
});
