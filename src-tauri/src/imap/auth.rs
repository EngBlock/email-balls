use imap::{Client, Session};
use native_tls::TlsStream;
use serde::Deserialize;
use std::net::TcpStream;

use crate::imap::error::ImapError;

#[derive(Debug, Deserialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ImapAuth {
    Password { username: String, password: String },
    // Future: OAuth2 { username: String, access_token: String },
}

impl ImapAuth {
    pub fn authenticate(
        self,
        client: Client<TlsStream<TcpStream>>,
    ) -> Result<Session<TlsStream<TcpStream>>, ImapError> {
        match self {
            ImapAuth::Password { username, password } => client
                .login(username, password)
                .map_err(|(e, _)| ImapError::Auth(e.to_string())),
        }
    }

    pub fn username(&self) -> &str {
        match self {
            ImapAuth::Password { username, .. } => username,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deserializes_password_variant_from_camel_case_tag() {
        let json = r#"{"kind":"password","username":"a","password":"b"}"#;
        let parsed: ImapAuth = serde_json::from_str(json).unwrap();
        assert_eq!(
            parsed,
            ImapAuth::Password {
                username: "a".into(),
                password: "b".into(),
            }
        );
    }

    #[test]
    fn rejects_unknown_kind() {
        let json = r#"{"kind":"oauth2","username":"a","accessToken":"t"}"#;
        let parsed: Result<ImapAuth, _> = serde_json::from_str(json);
        assert!(parsed.is_err());
    }
}
