//! IMAP integration layer.
//!
//! Two IMAP sessions per account run concurrently: a foreground session
//! owned by `ImapState` that serves command-driven fetches, and a
//! dedicated IDLE session inside `IdleManager` that pushes
//! `imap-update` events when the server reports mailbox changes — the
//! frontend reacts by re-running a `stream_senders` delta sync.
//! Submodules are public so command handlers in `crate::commands`
//! can call into the lower-level helpers (e.g. `client::stream_senders`);
//! the re-exports below are the curated surface most callers should
//! reach for. Wire-format types in `types` are serde-serialisable and
//! flow across the Tauri boundary to the frontend, while errors are
//! normalised through `ImapError` into a `{ kind, message }` shape.

/// Authentication strategies for opening an IMAP session (currently
/// `Password`; `OAuth2` is reserved for future use).
pub mod auth;
/// Connection, search, fetch, and aggregation routines that drive the
/// `list_senders` / `stream_senders` / `fetch_body` Tauri commands.
pub mod client;
/// Typed IMAP error enum, serialised to the frontend as `{ kind, message }`.
pub mod error;
/// Background IDLE worker that emits `imap-update` events when the server
/// reports mailbox changes.
pub mod idle;
/// Tauri-managed persistent-session state and the `run_with_session` helper
/// used by command handlers.
pub mod state;
/// Serde-serialisable payloads shared with the frontend (envelopes, bodies,
/// sender summaries, streaming events).
pub mod types;

/// Authentication method used when opening an IMAP session.
pub use auth::ImapAuth;
/// Error type returned by every fallible IMAP operation in this crate.
pub use error::ImapError;
/// Owns the IDLE worker thread; constructed once and stored in Tauri state.
pub use idle::IdleManager;
/// Tauri-managed handle to the persistent foreground IMAP session.
pub use state::ImapState;
/// Wire-format types exchanged with the frontend: full email body, envelope
/// metadata, streaming sender event, and per-sender summary row.
pub use types::{EmailBody, EmailEnvelope, SenderEvent, SenderSummary};
