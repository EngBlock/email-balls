//! IMAP IDLE worker.
//!
//! A second IMAP session, dedicated to IDLE, runs on its own thread and
//! emits a `mail-bubbles://imap-update` Tauri event whenever the server
//! reports a mailbox change. The frontend reacts by re-running the
//! existing `stream_senders` delta sync — IDLE just *signals* a refresh,
//! it doesn't carry the new messages itself.
//!
//! Why a separate session: while a `Session` is in IDLE it can't run any
//! other command, so we keep the foreground session (the one that serves
//! `fetch_body`, `fetch_emails_from_sender`, etc.) entirely independent.
//! IMAP servers are required to allow multiple concurrent connections
//! per user.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use imap::extensions::idle::WaitOutcome;
use tauri::{AppHandle, Emitter};

use crate::imap::auth::ImapAuth;
use crate::imap::client::connect_and_auth;
use crate::imap::error::ImapError;

/// How often to break out of IDLE to check the shutdown flag. Sets a
/// ceiling on stop-IDLE latency: roughly this duration in the worst case.
/// Each timeout costs one `IDLE`/`DONE` round trip, so 60s gives one
/// keepalive-equivalent per minute — small constant overhead, snappy
/// disconnect behaviour.
const IDLE_CHECK_INTERVAL: Duration = Duration::from_secs(60);

/// First reconnect delay after a session error. Doubles up to `RECONNECT_MAX`.
const RECONNECT_INITIAL: Duration = Duration::from_secs(1);
const RECONNECT_MAX: Duration = Duration::from_secs(30);

/// Tauri event name. Frontend listens here and triggers a delta sync
/// via the existing `stream_senders` command.
pub const IMAP_UPDATE_EVENT: &str = "imap-update";

/// What the worker is configured for. Used to detect "already running
/// for this account/mailbox" so a re-issued `start` is a no-op.
#[derive(Clone, PartialEq, Eq, Debug)]
struct Fingerprint {
    host: String,
    port: u16,
    username: String,
    mailbox: String,
}

struct Running {
    shutdown: Arc<AtomicBool>,
    join: thread::JoinHandle<()>,
    fingerprint: Fingerprint,
}

#[derive(Default)]
pub struct IdleManager {
    inner: Mutex<Option<Running>>,
}

impl IdleManager {
    /// Start an IDLE worker for the given account+mailbox. If a worker
    /// is already running with the same fingerprint, this is a no-op.
    /// Otherwise any existing worker is asked to stop and joined before
    /// the new one is spawned.
    pub fn start(
        &self,
        app: AppHandle,
        host: String,
        port: u16,
        auth: ImapAuth,
        mailbox: String,
    ) {
        let new_fp = Fingerprint {
            host: host.clone(),
            port,
            username: auth.username().to_owned(),
            mailbox: mailbox.clone(),
        };
        // Same-fingerprint short-circuit, then take the old worker out
        // of the slot so we can join it without holding the lock.
        let old = {
            let mut g = self.inner.lock().expect("idle state poisoned");
            if g.as_ref().map(|r| &r.fingerprint) == Some(&new_fp) {
                return;
            }
            g.take()
        };
        if let Some(old) = old {
            stop_running(old);
        }

        let shutdown = Arc::new(AtomicBool::new(false));
        let shutdown_for_thread = shutdown.clone();
        let app_for_thread = app.clone();
        let host_for_thread = host.clone();
        let mailbox_for_thread = mailbox.clone();
        let join = thread::Builder::new()
            .name("imap-idle".into())
            .spawn(move || {
                run_loop(
                    app_for_thread,
                    host_for_thread,
                    port,
                    auth,
                    mailbox_for_thread,
                    shutdown_for_thread,
                );
            })
            .expect("spawn imap-idle thread");

        let mut g = self.inner.lock().expect("idle state poisoned");
        *g = Some(Running {
            shutdown,
            join,
            fingerprint: new_fp,
        });
    }

    /// Signal the running worker (if any) to exit and wait for it. Safe
    /// to call multiple times; subsequent calls are no-ops.
    pub fn stop(&self) {
        let old = {
            let mut g = self.inner.lock().expect("idle state poisoned");
            g.take()
        };
        if let Some(old) = old {
            stop_running(old);
        }
    }
}

fn stop_running(running: Running) {
    running.shutdown.store(true, Ordering::Release);
    // Up to IDLE_CHECK_INTERVAL of latency before the worker observes
    // the flag. Worst case ~60s; in practice a session error will
    // unblock the worker far sooner.
    if let Err(e) = running.join.join() {
        eprintln!("imap idle: worker thread panicked on shutdown: {e:?}");
    }
}

/// Outer loop: keep an IDLE session alive across reconnects until the
/// shutdown flag flips.
fn run_loop(
    app: AppHandle,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    shutdown: Arc<AtomicBool>,
) {
    let mut backoff = RECONNECT_INITIAL;
    while !shutdown.load(Ordering::Acquire) {
        match run_session(&app, &host, port, &auth, &mailbox, &shutdown) {
            Ok(()) => return, // clean shutdown
            Err(e) => {
                eprintln!(
                    "imap idle: session error, reconnecting in {:?}: {e}",
                    backoff
                );
                if !sleep_with_shutdown(backoff, &shutdown) {
                    return;
                }
                backoff = (backoff * 2).min(RECONNECT_MAX);
            }
        }
    }
}

/// One connect → SELECT → IDLE-loop session. Returns `Ok(())` only on
/// clean shutdown; any other exit returns `Err` so the outer loop can
/// back off and reconnect.
fn run_session(
    app: &AppHandle,
    host: &str,
    port: u16,
    auth: &ImapAuth,
    mailbox: &str,
    shutdown: &Arc<AtomicBool>,
) -> Result<(), ImapError> {
    let mut session = connect_and_auth(host, port, auth.clone())?;
    session
        .select(mailbox)
        .map_err(|e| ImapError::Mailbox(e.to_string()))?;

    while !shutdown.load(Ordering::Acquire) {
        let mut handle = session
            .idle()
            .map_err(|e| ImapError::Internal(format!("idle: {e}")))?;
        // Server may force-disconnect after ~30 min of IDLE per RFC
        // 2177; setting keepalive isn't actually needed because we
        // re-issue IDLE every IDLE_CHECK_INTERVAL anyway, but it's the
        // right belt-and-braces value if our timeout ever grows.
        handle.set_keepalive(Duration::from_secs(29 * 60));
        let outcome = handle
            .wait_with_timeout(IDLE_CHECK_INTERVAL)
            .map_err(|e| ImapError::Internal(format!("idle wait: {e}")))?;
        // `Drop` on `handle` already sent DONE — `session` is usable
        // again on the next loop iteration.
        match outcome {
            WaitOutcome::MailboxChanged => {
                if let Err(e) = app.emit(IMAP_UPDATE_EVENT, ()) {
                    eprintln!("imap idle: emit failed: {e}");
                }
            }
            WaitOutcome::TimedOut => {
                // Just a shutdown-check tick; loop and re-IDLE.
            }
        }
    }
    Ok(())
}

/// Sleep for the given duration, breaking out early if shutdown fires.
/// Returns `false` if shutdown was observed (caller should bail out).
fn sleep_with_shutdown(d: Duration, shutdown: &Arc<AtomicBool>) -> bool {
    let started = Instant::now();
    while started.elapsed() < d {
        if shutdown.load(Ordering::Acquire) {
            return false;
        }
        thread::sleep(Duration::from_millis(100));
    }
    !shutdown.load(Ordering::Acquire)
}
