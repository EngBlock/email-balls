import { useEffect, useRef } from "react";

import styles from "./AccountsStage.module.css";
import { useAppStore } from "../store";

export function AccountsStage() {
  const form = useAppStore((s) => s.form);
  const hasSavedAccount = useAppStore((s) => s.hasSavedAccount);
  const sendersLoading = useAppStore((s) => s.sendersLoading);

  const setForm = useAppStore((s) => s.setForm);
  const setAccount = useAppStore((s) => s.setAccount);
  const setStage = useAppStore((s) => s.setStage);
  const buildAccountFromForm = useAppStore((s) => s.buildAccountFromForm);
  const persistCredentials = useAppStore((s) => s.persistCredentials);
  const signOut = useAppStore((s) => s.signOut);
  const loadSenders = useAppStore((s) => s.loadSenders);
  const clearError = useAppStore((s) => s.clearError);

  const autoTriedRef = useRef(false);

  /** Sign in: build AccountConn from the form, stream senders, persist
   *  credentials on success. */
  async function onLoadSenders() {
    const acc = buildAccountFromForm();
    setAccount(acc);
    clearError();
    setStage("senders");
    await loadSenders(acc, 5000);
    // Only persist if the sender scan succeeded (no sendersError).
    const { sendersError } = useAppStore.getState();
    if (!sendersError) {
      persistCredentials(form);
    }
  }

  // Auto-login on mount if credentials are saved. signOut clears
  // hasSavedAccount + form, so a remount after sign-out won't re-fire.
  useEffect(() => {
    if (autoTriedRef.current) return;
    autoTriedRef.current = true;
    if (hasSavedAccount && form.username && form.password) {
      void onLoadSenders();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void onLoadSenders();
      }}
      className={`row ${styles.form}`}
    >
      <input
        value={form.host}
        onChange={(e) => setForm({ host: e.target.value })}
        placeholder="IMAP host"
      />
      <input
        value={form.port}
        onChange={(e) => setForm({ port: e.target.value })}
        placeholder="port"
      />
      <input
        value={form.username}
        onChange={(e) => setForm({ username: e.target.value })}
        placeholder="username / email"
      />
      <input
        type="password"
        value={form.password}
        onChange={(e) => setForm({ password: e.target.value })}
        placeholder="password / app password"
      />
      <button type="submit" disabled={sendersLoading}>
        {sendersLoading ? "Loading…" : "Load senders"}
      </button>
      {hasSavedAccount && (
        <button
          type="button"
          onClick={signOut}
          disabled={sendersLoading}
          className={styles.signOutButton}
        >
          Sign out (forget saved credentials)
        </button>
      )}
    </form>
  );
}
