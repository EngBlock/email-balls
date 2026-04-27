pub mod auth;
pub mod client;
pub mod error;
pub mod state;
pub mod types;

pub use auth::ImapAuth;
pub use error::ImapError;
pub use state::ImapState;
pub use types::{EmailBody, EmailEnvelope, SenderEvent, SenderSummary};
