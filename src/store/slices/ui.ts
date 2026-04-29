import type { AppStateCreator } from "../types";

/**
 * UI / transient state.
 *
 * Owns cross-slice transient flags that don't belong to a single domain
 * concept — the global `loading` indicator, top-level `error` string,
 * and a `resetUi` action that clears transient UI state on sign-out or
 * account swap. Sequence-number refs and IDLE refresh machinery stay in
 * component-local refs (they aren't render state).
 *
 * Design note: `bodyLoading` lives in `EmailsSlice` because it is
 * scoped to the email body drawer; `activeSender` / drawer-open state
 * is derived from `SendersSlice.activeSender` and `EmailsSlice.body`.
 * Only truly cross-cutting UI flags belong here.
 */
export interface UiSlice {
  /** Global loading indicator — true while an IMAP fetch is in flight
   *  (sender scan, email list fetch, etc.). Components should prefer
   *  more specific loading flags (e.g. `EmailsSlice.bodyLoading`) when
   *  available; this flag covers the shared spinner / button-disabled
   *  state on the sign-in form and the email list drawer header. */
  loading: boolean;
  /** Top-level error string. Set by any slice that catches an IMAP
   *  error; cleared on sign-out or when a new operation begins. */
  error: string | null;

  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  /** Convenience: set `error` to `null`. Useful in `onSignOut` and when
   *  starting a new fetch that should clear a stale error. */
  clearError: () => void;
  /** Reset all transient UI state to initial values. Automatically
   *  invoked by `AccountSlice.signOut` as part of the sign-out cascade,
   *  and by any future account-swap flow to ensure stale loading
   *  spinners / error toasts don't survive the transition. */
  resetUi: () => void;
}

const INITIAL: Pick<UiSlice, "loading" | "error"> = {
  loading: false,
  error: null,
};

export const createUiSlice: AppStateCreator<UiSlice> = (set) => ({
  ...INITIAL,

  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  clearError: () => set({ error: null }),
  resetUi: () => set({ ...INITIAL }),
});
