use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use imap::Session;
use native_tls::TlsStream;

use crate::imap::auth::ImapAuth;
use crate::imap::client::connect_and_auth;
use crate::imap::error::ImapError;

/// Identity of an IMAP connection. If anything here changes between calls
/// we drop the existing session and reconnect.
#[derive(Clone, PartialEq, Eq, Debug)]
struct ConnFingerprint {
    host: String,
    port: u16,
    username: String,
}

impl ConnFingerprint {
    fn new(host: &str, port: u16, username: &str) -> Self {
        Self {
            host: host.to_owned(),
            port,
            username: username.to_owned(),
        }
    }
}

#[derive(Debug)]
struct ImapHandle {
    session: Session<TlsStream<TcpStream>>,
    fingerprint: ConnFingerprint,
    selected: Option<String>,
}

/// Holds at most one persistent IMAP session. Lock with `Mutex` and access
/// only inside `spawn_blocking` closures — we never hold the guard across
/// `.await`.
#[derive(Default)]
pub struct HandleSlot {
    handle: Option<ImapHandle>,
}

impl HandleSlot {
    /// Reuse the live session if its fingerprint matches; otherwise
    /// connect+auth fresh. After this returns, `self.handle` is `Some`
    /// with a session matching `host`/`port`/`auth.username()`.
    /// `auth` is borrowed and only cloned when we actually reconnect,
    /// so steady-state callers don't pay to copy a password per call.
    fn connect_if_needed(
        &mut self,
        host: &str,
        port: u16,
        auth: &ImapAuth,
    ) -> Result<&mut ImapHandle, ImapError> {
        let fp = ConnFingerprint::new(host, port, auth.username());
        let needs_connect = self.handle.as_ref().is_none_or(|h| h.fingerprint != fp);
        if needs_connect {
            let session = connect_and_auth(host, port, auth.clone())?;
            self.handle = Some(ImapHandle {
                session,
                fingerprint: fp,
                selected: None,
            });
        }
        Ok(self.handle.as_mut().expect("handle just inserted"))
    }

    /// Connect if needed, SELECT mailbox if needed. Returns the live session.
    pub fn ensure_ready(
        &mut self,
        host: &str,
        port: u16,
        auth: &ImapAuth,
        mailbox: &str,
    ) -> Result<&mut Session<TlsStream<TcpStream>>, ImapError> {
        let h = self.connect_if_needed(host, port, auth)?;
        if h.selected.as_deref() != Some(mailbox) {
            h.session
                .select(mailbox)
                .map_err(|e| ImapError::Mailbox(e.to_string()))?;
            h.selected = Some(mailbox.to_owned());
        }
        Ok(&mut h.session)
    }

    /// Force a fresh SELECT to read up-to-date `Mailbox::exists`. Connects
    /// if needed. Use this when the caller cares about the message count.
    pub fn refresh_mailbox(
        &mut self,
        host: &str,
        port: u16,
        auth: &ImapAuth,
        mailbox: &str,
    ) -> Result<imap::types::Mailbox, ImapError> {
        let h = self.connect_if_needed(host, port, auth)?;
        let meta = h
            .session
            .select(mailbox)
            .map_err(|e| ImapError::Mailbox(e.to_string()))?;
        h.selected = Some(mailbox.to_owned());
        Ok(meta)
    }

    /// Drop the live session — next call will reconnect from scratch. Use
    /// after any IMAP-tier error so we don't keep handing out a broken
    /// session.
    pub fn invalidate(&mut self) {
        self.handle = None;
    }
}

/// Tauri-managed wrapper around `HandleSlot`. Cloneable (Arc) so commands
/// can pass it into `spawn_blocking`.
#[derive(Clone, Default)]
pub struct ImapState(pub Arc<Mutex<HandleSlot>>);

/// Run an IMAP op against the persistent session. Locks the slot, ensures
/// the right mailbox is selected, runs `f`, and invalidates the slot on
/// any error so the next caller reconnects.
pub fn run_with_session<F, T>(
    slot: &Mutex<HandleSlot>,
    host: &str,
    port: u16,
    auth: &ImapAuth,
    mailbox: &str,
    f: F,
) -> Result<T, ImapError>
where
    F: FnOnce(&mut Session<TlsStream<TcpStream>>) -> Result<T, ImapError>,
{
    let mut g = slot.lock().expect("imap state poisoned");
    let session = match g.ensure_ready(host, port, auth, mailbox) {
        Ok(s) => s,
        Err(e) => {
            g.invalidate();
            return Err(e);
        }
    };
    let result = f(session);
    if result.is_err() {
        g.invalidate();
    }
    result
}
