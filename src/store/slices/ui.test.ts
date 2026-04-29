import { describe, expect, it } from "vitest";
import { create } from "zustand";

import {
  createUiSlice,
  type UiSlice,
} from "./ui";

// Each call to `make` instantiates a fresh slice so tests are isolated.
// The `as any` cast sidesteps the composed-AppStore constraint on
// AppStateCreator — in isolation the slice doesn't provide sibling
// fields, and the runtime behaviour is correct.
function make() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const creator = createUiSlice as any;
  return create<UiSlice>()((set: any, get: any, store: any) => creator(set, get, store));
}

describe("uiSlice", () => {
  it("initializes with loading=false and error=null", () => {
    const store = make();
    const s = store.getState();
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("setLoading toggles the loading flag", () => {
    const store = make();
    store.getState().setLoading(true);
    expect(store.getState().loading).toBe(true);
    store.getState().setLoading(false);
    expect(store.getState().loading).toBe(false);
  });

  it("setError sets an error string", () => {
    const store = make();
    store.getState().setError("[auth] Invalid credentials");
    expect(store.getState().error).toBe("[auth] Invalid credentials");
  });

  it("setError(null) clears the error", () => {
    const store = make();
    store.getState().setError("boom");
    store.getState().setError(null);
    expect(store.getState().error).toBeNull();
  });

  it("clearError is a convenience that sets error to null", () => {
    const store = make();
    store.getState().setError("something went wrong");
    store.getState().clearError();
    expect(store.getState().error).toBeNull();
  });

  it("resetUi restores both loading and error to initial values", () => {
    const store = make();
    store.getState().setLoading(true);
    store.getState().setError("[fetch] timeout");
    store.getState().resetUi();
    const s = store.getState();
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("resetUi is idempotent — calling it on a fresh store is a no-op", () => {
    const store = make();
    store.getState().resetUi();
    const s = store.getState();
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("loading and error can be set independently without affecting each other", () => {
    const store = make();
    store.getState().setLoading(true);
    expect(store.getState().error).toBeNull();
    store.getState().setError("err");
    expect(store.getState().loading).toBe(true);
    store.getState().setLoading(false);
    expect(store.getState().error).toBe("err");
  });
});
