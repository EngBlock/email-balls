use serde::Serialize;

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmailAddress {
    pub name: Option<String>,
    pub mailbox: Option<String>,
    pub host: Option<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SenderSummary {
    pub address: EmailAddress,
    pub display_name: Option<String>,
    pub message_count: u32,
    /// Subset of `message_count` whose IMAP flags lacked `\Seen` at the
    /// time of the scan. Drives the unread-badge on bubbles.
    pub unread_count: u32,
    pub latest_uid: u32,
    pub latest_subject: Option<String>,
    pub latest_date: Option<String>,
    /// UIDs of messages from this sender we observed during the scan, newest
    /// first. Lets the frontend hand these straight back to a UID-fetch
    /// command and skip a slow server-side `SEARCH FROM`.
    pub uids: Vec<u32>,
    /// All distinct sending hosts that fed this bubble. For
    /// domain-grouped bubbles this carries the original subdomains so
    /// the frontend can fall back to a sending subdomain when the
    /// registrable domain itself has no BIMI record (e.g. Netflix
    /// publishes BIMI on `members.netflix.com`, not `netflix.com`).
    /// For consumer-mail bubbles it's a single-element list with the
    /// host of that mailbox.
    pub hosts: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SenderEvent {
    #[serde(rename_all = "camelCase")]
    Started { total: u32, scan: u32 },
    #[serde(rename_all = "camelCase")]
    Chunk { senders: Vec<SenderSummary> },
    Done,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmailEnvelope {
    pub uid: u32,
    pub subject: Option<String>,
    pub from: Vec<EmailAddress>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub date: Option<String>,
    pub message_id: Option<String>,
    pub in_reply_to: Option<String>,
    pub flags: Vec<String>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentInfo {
    pub filename: Option<String>,
    pub content_type: String,
    pub size: u32,
}

/// An inline MIME part (Content-ID-bearing image or other resource referenced
/// by the HTML body via `<img src="cid:…">`). Renderer rewrites `cid:` URLs
/// to `data:` URLs at sanitize time using `data_base64` so the iframe
/// resolves them without a network request.
#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InlinePart {
    pub content_id: String,
    pub content_type: String,
    pub data_base64: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EmailBody {
    pub uid: u32,
    pub subject: Option<String>,
    pub from: Vec<EmailAddress>,
    pub to: Vec<EmailAddress>,
    pub cc: Vec<EmailAddress>,
    pub date: Option<String>,
    pub text_body: Option<String>,
    pub html_body: Option<String>,
    pub attachments: Vec<AttachmentInfo>,
    pub inline_parts: Vec<InlinePart>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_address_serializes_camel_case_with_optional_fields() {
        let addr = EmailAddress {
            name: Some("Ada".into()),
            mailbox: Some("ada".into()),
            host: Some("example.com".into()),
        };
        let json = serde_json::to_value(&addr).unwrap();
        assert_eq!(json["name"], "Ada");
        assert_eq!(json["mailbox"], "ada");
        assert_eq!(json["host"], "example.com");
    }

    #[test]
    fn sender_summary_uses_camel_case_keys() {
        let s = SenderSummary {
            address: EmailAddress {
                name: None,
                mailbox: Some("a".into()),
                host: Some("b.com".into()),
            },
            display_name: Some("A".into()),
            message_count: 3,
            unread_count: 1,
            latest_uid: 42,
            latest_subject: Some("hi".into()),
            latest_date: None,
            uids: vec![42, 41, 40],
            hosts: vec!["b.com".into()],
        };
        let json = serde_json::to_value(&s).unwrap();
        assert!(json.get("displayName").is_some());
        assert!(json.get("messageCount").is_some());
        assert!(json.get("unreadCount").is_some());
        assert!(json.get("latestUid").is_some());
        assert!(json.get("latestSubject").is_some());
        assert!(json.get("latestDate").is_some());
        assert_eq!(json.get("uids"), Some(&serde_json::json!([42, 41, 40])));
        assert_eq!(json.get("hosts"), Some(&serde_json::json!(["b.com"])));
        // Make sure snake_case did not leak through.
        assert!(json.get("display_name").is_none());
    }
}
