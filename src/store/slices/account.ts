import type { AppStateCreator } from "../types";

import type { AccountConn } from "../../lib/imap";
import {
  clearAccount,
  loadAccount,
  saveAccount,
  type StoredAccount,
} from "../../lib/accountStore";

/**
 * Account / connection state.
 *
 * Owns the IMAP connection form, the active `AccountConn`, the
 * sign-in stage, and the persisted-credentials flag. Auth-level errors
 * are deliberately left in the cross-cutting `UiSlice.error` until the
 * App.tsx migration scopes errors per surface — splitting them here
 * would force the migration to introduce a parallel `error` field and
 * route every existing setError call to one of two slices. Easier to
 * land that as its own task once the migration is in flight.
 */
export type Stage = "accounts" | "senders";

export interface FormState {
  host: string;
  port: string;
  username: string;
  password: string;
}

/** Defaults match the ProtonMail Bridge localhost setup the README ships
 *  with — host/port pre-filled so a first-time user only types creds. */
export const initialForm: FormState = {
  host: "127.0.0.1",
  port: "1143",
  username: "",
  password: "",
};

export interface AccountSlice {
  form: FormState;
  account: AccountConn | null;
  stage: Stage;
  hasSavedAccount: boolean;

  setForm: (patch: Partial<FormState>) => void;
  setAccount: (account: AccountConn | null) => void;
  setStage: (stage: Stage) => void;
  /** Convert the current form fields into an `AccountConn` suitable for
   *  IMAP operations. Trims host/username; parses port as base-10 int.
   *  Validation (e.g. NaN port, empty host) remains the caller's
   *  responsibility — the slice deliberately does not reject bad input
   *  so the UI can show inline errors without the store fighting it. */
  buildAccountFromForm: () => AccountConn;
  /** Write-through to localStorage; flips `hasSavedAccount`. Callers
   *  invoke this only after a successful authenticated fetch so we
   *  don't persist credentials that haven't proven themselves. */
  persistCredentials: (creds: StoredAccount) => void;
  /** Clears in-memory account, the persisted credentials, and resets
   *  the form + stage so the sign-in screen renders blank. Cascades
   *  to sibling slices (resetSenders, clearEmails, resetUi) so no
   *  stale state leaks across sign-out. */
  signOut: () => void;
}

export const createAccountSlice: AppStateCreator<AccountSlice> = (set, get) => {
  const stored = loadAccount();
  return {
    form: stored ?? initialForm,
    account: null,
    stage: "accounts",
    hasSavedAccount: stored !== null,

    setForm: (patch) =>
      set((state) => ({ form: { ...state.form, ...patch } })),
    setAccount: (account) => set({ account }),
    setStage: (stage) => set({ stage }),
    buildAccountFromForm: () => {
      const { form } = get();
      return {
        host: form.host.trim(),
        port: parseInt(form.port, 10),
        auth: {
          kind: "password",
          username: form.username.trim(),
          password: form.password,
        },
        mailbox: "INBOX",
      };
    },
    persistCredentials: (creds) => {
      saveAccount(creds);
      set({ hasSavedAccount: true });
    },
    signOut: () => {
      clearAccount();
      get().resetSenders();
      get().clearEmails();
      get().resetUi();
      set({
        account: null,
        form: initialForm,
        stage: "accounts",
        hasSavedAccount: false,
      });
    },
  };
};
