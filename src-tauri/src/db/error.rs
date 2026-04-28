use serde::{Serialize, Serializer};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CacheError {
    #[error("cache open failed: {0}")]
    Open(String),
    #[error("cache schema failed: {0}")]
    Schema(String),
    #[error("cache read failed: {0}")]
    Read(String),
    #[error("cache write failed: {0}")]
    Write(String),
    #[error("cache encode failed: {0}")]
    Encode(String),
}

impl Serialize for CacheError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let (kind, message) = match self {
            CacheError::Open(m) => ("open", m.clone()),
            CacheError::Schema(m) => ("schema", m.clone()),
            CacheError::Read(m) => ("read", m.clone()),
            CacheError::Write(m) => ("write", m.clone()),
            CacheError::Encode(m) => ("encode", m.clone()),
        };
        let mut st = s.serialize_struct("CacheError", 2)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &message)?;
        st.end()
    }
}

impl From<rusqlite::Error> for CacheError {
    fn from(e: rusqlite::Error) -> Self {
        CacheError::Read(e.to_string())
    }
}

impl From<serde_json::Error> for CacheError {
    fn from(e: serde_json::Error) -> Self {
        CacheError::Encode(e.to_string())
    }
}
