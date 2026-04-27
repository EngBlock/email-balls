use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ImapError {
    #[error("connect failed: {0}")]
    Connect(String),
    #[error("authentication failed: {0}")]
    Auth(String),
    #[error("mailbox error: {0}")]
    Mailbox(String),
    #[error("search failed: {0}")]
    Search(String),
    #[error("fetch failed: {0}")]
    Fetch(String),
    #[error("parse failed: {0}")]
    Parse(String),
    #[error("not found: uid {0}")]
    NotFound(u32),
    #[error("internal error: {0}")]
    Internal(String),
}

impl Serialize for ImapError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (kind, message) = match self {
            ImapError::Connect(m) => ("connect", m.clone()),
            ImapError::Auth(m) => ("auth", m.clone()),
            ImapError::Mailbox(m) => ("mailbox", m.clone()),
            ImapError::Search(m) => ("search", m.clone()),
            ImapError::Fetch(m) => ("fetch", m.clone()),
            ImapError::Parse(m) => ("parse", m.clone()),
            ImapError::NotFound(u) => ("notFound", format!("uid {u}")),
            ImapError::Internal(m) => ("internal", m.clone()),
        };
        let mut st = s.serialize_struct("ImapError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &message)?;
        st.end()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_string_variant_as_kind_and_message() {
        let err = ImapError::Auth("bad password".into());
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "auth");
        assert_eq!(json["message"], "bad password");
    }

    #[test]
    fn serializes_not_found_with_uid_in_message() {
        let err = ImapError::NotFound(7);
        let json = serde_json::to_value(&err).unwrap();
        assert_eq!(json["kind"], "notFound");
        assert_eq!(json["message"], "uid 7");
    }

    #[test]
    fn each_variant_has_distinct_kind_string() {
        let kinds: Vec<&str> = [
            ImapError::Connect("".into()),
            ImapError::Auth("".into()),
            ImapError::Mailbox("".into()),
            ImapError::Search("".into()),
            ImapError::Fetch("".into()),
            ImapError::Parse("".into()),
            ImapError::NotFound(0),
            ImapError::Internal("".into()),
        ]
        .iter()
        .map(|e| {
            let v = serde_json::to_value(e).unwrap();
            v["kind"].as_str().unwrap().to_string()
        })
        .collect::<Vec<_>>()
        .iter()
        .map(|s| Box::leak(s.clone().into_boxed_str()) as &str)
        .collect();
        let mut sorted = kinds.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(kinds.len(), sorted.len(), "kinds must be distinct");
    }
}
