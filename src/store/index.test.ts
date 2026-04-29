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

import { useAppStore } from "./index";
import { initialForm } from "./slices/account";

/**
 * Smoke test for the composed store. Verifies that all slices are wired
 * together and the initial state is consistent — this catches wiring
 * mistakes (missing spread, colliding keys, wrong type intersection)
 * that per-slice unit tests cannot see.
 */
describe("useAppStore (composed)", () => {
  it("initializes with all slice defaults", () => {
    const s = useAppStore.getState();

    // AccountSlice defaults
    expect(s.form).toEqual(initialForm);
    expect(s.account).toBeNull();
    expect(s.stage).toBe("accounts");
    expect(s.hasSavedAccount).toBe(false);

    // UiSlice defaults
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("account setForm patches the form and is visible via getState", () => {
    useAppStore.getState().setForm({ username: "test@x.com" });
    expect(useAppStore.getState().form.username).toBe("test@x.com");
    // Clean up for other tests
    useAppStore.getState().setForm(initialForm);
  });

  it("account setStage works in the composed store", () => {
    useAppStore.getState().setStage("senders");
    expect(useAppStore.getState().stage).toBe("senders");
    useAppStore.getState().setStage("accounts");
  });

  it("ui setError / clearError round-trips through the composed store", () => {
    useAppStore.getState().setError("boom");
    expect(useAppStore.getState().error).toBe("boom");
    useAppStore.getState().clearError();
    expect(useAppStore.getState().error).toBeNull();
  });

  it("ui resetUi clears loading and error", () => {
    useAppStore.getState().setLoading(true);
    useAppStore.getState().setError("oops");
    useAppStore.getState().resetUi();
    expect(useAppStore.getState().loading).toBe(false);
    expect(useAppStore.getState().error).toBeNull();
  });

  it("account signOut resets account slice and cascades to ui slice", () => {
    useAppStore.getState().setForm({ username: "u@x.com" });
    useAppStore.getState().setStage("senders");
    useAppStore.getState().setError("some error");

    useAppStore.getState().signOut();

    const s = useAppStore.getState();
    expect(s.form).toEqual(initialForm);
    expect(s.stage).toBe("accounts");
    expect(s.account).toBeNull();
    expect(s.hasSavedAccount).toBe(false);
    expect(s.error).toBeNull();
  });

  it("buildAccountFromForm is available on the composed store", () => {
    const conn = useAppStore.getState().buildAccountFromForm();
    expect(conn).toEqual({
      host: initialForm.host,
      port: parseInt(initialForm.port, 10),
      auth: {
        kind: "password",
        username: initialForm.username,
        password: initialForm.password,
      },
      mailbox: "INBOX",
    });
  });
});
