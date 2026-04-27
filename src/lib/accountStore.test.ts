import { beforeEach, describe, expect, it } from "vitest";

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

import {
  clearAccount,
  hasStoredAccount,
  loadAccount,
  saveAccount,
  type StoredAccount,
} from "./accountStore";

const sample: StoredAccount = {
  host: "127.0.0.1",
  port: "1143",
  username: "me@example.com",
  password: "app-password",
};

describe("accountStore", () => {
  it("returns null when nothing has been stored", () => {
    expect(loadAccount()).toBeNull();
    expect(hasStoredAccount()).toBe(false);
  });

  it("round-trips a stored account", () => {
    saveAccount(sample);
    expect(loadAccount()).toEqual(sample);
    expect(hasStoredAccount()).toBe(true);
  });

  it("overwrites a previous account on second save", () => {
    saveAccount(sample);
    saveAccount({ ...sample, username: "other@example.com" });
    expect(loadAccount()?.username).toBe("other@example.com");
  });

  it("clear removes the stored entry", () => {
    saveAccount(sample);
    clearAccount();
    expect(loadAccount()).toBeNull();
    expect(hasStoredAccount()).toBe(false);
  });

  it("returns null when stored value is not valid JSON", () => {
    localStorage.setItem("mail-bubbles:account-v1", "{not json");
    expect(loadAccount()).toBeNull();
  });

  it("returns null when stored value is missing required fields", () => {
    localStorage.setItem(
      "mail-bubbles:account-v1",
      JSON.stringify({ host: "x" }),
    );
    expect(loadAccount()).toBeNull();
  });

  it("returns null when a field has the wrong type", () => {
    localStorage.setItem(
      "mail-bubbles:account-v1",
      JSON.stringify({ ...sample, port: 1143 }),
    );
    expect(loadAccount()).toBeNull();
  });
});
