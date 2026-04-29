import "./App.css";
import styles from "./App.module.css";
import { AccountsStage } from "./components/AccountsStage";
import { SendersStage } from "./components/SendersStage";
import { useAppStore } from "./store";
import { useImapEventBridge } from "./hooks/useImapEventBridge";
import { useImapIdleLifecycle } from "./hooks/useImapIdleLifecycle";

function App() {
  const stage = useAppStore((s) => s.stage);
  // Top-level error banner: show whichever slice reported a problem.
  const error = useAppStore(
    (s) => s.error ?? s.sendersError ?? s.emailsError,
  );

  // Background hooks live at the root because they manage IMAP IDLE
  // state tied to the connected account regardless of stage.
  useImapIdleLifecycle();
  useImapEventBridge();

  return (
    <main className={`container ${styles.container}`}>
      {stage === "accounts" && <AccountsStage />}
      {error && <p className={styles.errorBanner}>error: {error}</p>}
      {stage === "senders" && <SendersStage />}
    </main>
  );
}

export default App;
