use std::collections::HashMap;
use std::net::TcpStream;
use mail_parser::MimeHeaders;

use imap::types::{Fetch, Flag};
use imap::Session;
use imap_proto::types::Address;
use native_tls::TlsStream;

use std::sync::Mutex;

use crate::imap::auth::ImapAuth;
use crate::imap::error::ImapError;
use crate::imap::state::{run_with_session, HandleSlot};
use crate::imap::types::{
    AttachmentInfo, EmailAddress, EmailBody, EmailEnvelope, SenderEvent, SenderSummary,
};
use tauri::ipc::Channel;

fn lossy_owned(b: &[u8]) -> String {
    String::from_utf8_lossy(b).into_owned()
}

// Decode RFC 2047 encoded-word syntax (`=?charset?q?...?=` / `=?charset?b?...?=`)
// in header values like Subject and display names. The IMAP `ENVELOPE` response
// returns these fields with the encoded-word markers intact, so we pipe them
// through mail-parser by synthesising a one-line message and reading back the
// decoded subject. mail-parser already understands the full RFC 2047 grammar
// (Q-encoding, B-encoding, charset transcoding, whitespace folding between
// adjacent encoded words), which is more than we'd want to re-implement here.
fn decode_header_text(s: String) -> String {
    if !s.contains("=?") {
        return s;
    }
    let raw = format!("Subject: {}\r\n\r\n", s);
    mail_parser::MessageParser::default()
        .parse(raw.as_bytes())
        .and_then(|m| m.subject().map(str::to_owned))
        .unwrap_or(s)
}

fn lossy_decoded(b: &[u8]) -> String {
    decode_header_text(lossy_owned(b))
}

pub(crate) fn imap_quoted(value: &str) -> String {
    let escaped = value.replace('\\', "\\\\").replace('"', "\\\"");
    format!("\"{escaped}\"")
}

fn flag_to_string(f: &Flag) -> String {
    match f {
        Flag::Seen => "\\Seen".into(),
        Flag::Answered => "\\Answered".into(),
        Flag::Flagged => "\\Flagged".into(),
        Flag::Deleted => "\\Deleted".into(),
        Flag::Draft => "\\Draft".into(),
        Flag::Recent => "\\Recent".into(),
        Flag::MayCreate => "\\MayCreate".into(),
        Flag::Custom(s) => s.to_string(),
    }
}

fn convert_imap_address(a: &Address) -> EmailAddress {
    EmailAddress {
        name: a
            .name
            .map(lossy_decoded)
            .filter(|s| !s.is_empty()),
        mailbox: a
            .mailbox
            .map(lossy_owned)
            .filter(|s| !s.is_empty()),
        host: a
            .host
            .map(lossy_owned)
            .filter(|s| !s.is_empty()),
    }
}

fn addresses_from_imap(opt: Option<&Vec<Address>>) -> Vec<EmailAddress> {
    opt.map(|v| v.iter().map(convert_imap_address).collect())
        .unwrap_or_default()
}

/// Hosts where individual mailboxes belong to individual humans, so
/// per-address grouping is what the user actually wants. Everywhere
/// else we collapse to one bubble per host. Match is exact + lowercased
/// — we don't strip subdomains here on purpose: brands routinely send
/// from a sending subdomain (`email.brand.com`), and BIMI lookups are
/// per-host, so subdomain-distinct grouping is a feature, not a bug.
const CONSUMER_DOMAINS: &[&str] = &[
    "gmail.com",
    "googlemail.com",
    "yahoo.com",
    "yahoo.co.uk",
    "yahoo.co.jp",
    "ymail.com",
    "rocketmail.com",
    "hotmail.com",
    "hotmail.co.uk",
    "outlook.com",
    "live.com",
    "msn.com",
    "icloud.com",
    "me.com",
    "mac.com",
    "aol.com",
    "protonmail.com",
    "proton.me",
    "pm.me",
    "fastmail.com",
    "fastmail.fm",
    "gmx.com",
    "gmx.de",
    "gmx.net",
    "gmx.at",
    "mail.com",
    "hey.com",
    "duck.com",
    "tutanota.com",
    "tuta.com",
    "zoho.com",
    "mailbox.org",
    "yandex.com",
    "yandex.ru",
    "qq.com",
    "163.com",
    "126.com",
];

/// Strip subdomains down to the registrable domain (eTLD+1) using the
/// Public Suffix List, so `updates.linear.app` and `linear.app`
/// collapse to the same key — and `members.netflix.com` rolls up
/// under `netflix.com`. PSL handles the awkward TLDs (`.co.uk`,
/// `.com.au`, `*.github.io`, etc.) correctly so we don't have to.
/// Falls back to the original lowercased host when PSL doesn't
/// recognise the input (IP literals, `localhost`, malformed hosts).
fn registrable_domain(host: &str) -> String {
    let h = host.trim().to_ascii_lowercase();
    // PSL doesn't recognise IP literals — it treats `127.0.0.1` as a
    // four-label name and trims to `0.1`. Bypass for any IPv4/IPv6.
    if h.parse::<std::net::IpAddr>().is_ok() {
        return h;
    }
    psl::domain_str(&h).map(str::to_owned).unwrap_or(h)
}

fn is_consumer_domain(host: &str) -> bool {
    let h = host.trim().to_ascii_lowercase();
    if CONSUMER_DOMAINS.iter().any(|d| *d == h) {
        return true;
    }
    // A subdomain of a consumer provider is still consumer-mail —
    // `m.gmail.com` shouldn't accidentally domain-aggregate.
    if let Some(reg) = psl::domain_str(&h) {
        return CONSUMER_DOMAINS.iter().any(|d| *d == reg);
    }
    false
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvelopeRecord {
    pub uid: u32,
    pub from_mailbox: Option<String>,
    pub from_host: Option<String>,
    pub from_name: Option<String>,
    pub subject: Option<String>,
    pub date: Option<String>,
    /// True if the message lacked the `\Seen` flag in the scan response.
    /// Caller must have requested FLAGS in the FETCH or this is meaningless.
    pub is_unread: bool,
}

/// Merge envelope records into a running accumulator and return the senders
/// that changed in this pass. Used by both the one-shot `aggregate_senders`
/// and the streaming `stream_senders` so the grouping rules stay identical.
pub fn merge_into(
    by_key: &mut HashMap<String, SenderSummary>,
    records: impl IntoIterator<Item = EnvelopeRecord>,
) -> Vec<SenderSummary> {
    let mut touched: Vec<String> = Vec::new();
    for r in records {
        let mailbox = r.from_mailbox.unwrap_or_default().to_lowercase();
        let host = r.from_host.unwrap_or_default().to_lowercase();
        if mailbox.is_empty() || host.is_empty() {
            continue;
        }
        // Brand domains collapse to one bubble per registrable domain
        // (eTLD+1) so `updates.linear.app` and `linear.app` merge.
        // Consumer-mail providers (gmail, icloud, outlook, …) keep
        // per-mailbox keys so individual people stay separable. The
        // address mailbox is dropped for domain-grouped bubbles — the
        // frontend keys off `mailbox == None` to render "linear.app"
        // instead of "@linear.app".
        let consumer = is_consumer_domain(&host);
        let group_host = if consumer {
            host.clone()
        } else {
            registrable_domain(&host)
        };
        let key = if consumer {
            format!("{mailbox}@{host}")
        } else {
            group_host.clone()
        };
        let entry = by_key.entry(key.clone()).or_insert_with(|| SenderSummary {
            address: EmailAddress {
                name: None,
                mailbox: if consumer { Some(mailbox.clone()) } else { None },
                host: Some(group_host.clone()),
            },
            display_name: None,
            message_count: 0,
            unread_count: 0,
            latest_uid: 0,
            latest_subject: None,
            latest_date: None,
            uids: Vec::new(),
            hosts: Vec::new(),
        });
        // Track every distinct sending host so the frontend can try a
        // subdomain when the apex has no BIMI. Tiny memory footprint
        // (typically 1–3 hosts per bubble) and the dedup is O(n²) only
        // in the contributing-host count, not the message count.
        if !entry.hosts.contains(&host) {
            entry.hosts.push(host.clone());
        }
        entry.message_count += 1;
        if r.is_unread {
            entry.unread_count += 1;
        }
        // Keep `uids` sorted newest-first so the frontend can hand them
        // straight to a UID-fetch and the user sees recent messages first.
        let pos = entry
            .uids
            .binary_search_by(|probe| r.uid.cmp(probe))
            .unwrap_or_else(|p| p);
        entry.uids.insert(pos, r.uid);
        if r.uid > entry.latest_uid {
            entry.latest_uid = r.uid;
            entry.latest_subject = r.subject;
            entry.latest_date = r.date;
            let name = r.from_name.filter(|s| !s.is_empty());
            if name.is_some() {
                entry.display_name = name;
            }
        }
        if !touched.contains(&key) {
            touched.push(key);
        }
    }
    touched
        .into_iter()
        .filter_map(|k| by_key.get(&k).cloned())
        .collect()
}

pub fn aggregate_senders(records: impl IntoIterator<Item = EnvelopeRecord>) -> Vec<SenderSummary> {
    let mut by_key: HashMap<String, SenderSummary> = HashMap::new();
    let _ = merge_into(&mut by_key, records);
    let mut out: Vec<SenderSummary> = by_key.into_values().collect();
    out.sort_by_key(|s| std::cmp::Reverse(s.latest_uid));
    out
}

fn record_from_fetch(f: &Fetch) -> Option<EnvelopeRecord> {
    let uid = f.uid?;
    let env = f.envelope()?;
    let from = env.from.as_ref().and_then(|v| v.first())?;
    let is_unread = !f.flags().iter().any(|fl| matches!(fl, Flag::Seen));
    Some(EnvelopeRecord {
        uid,
        from_mailbox: from.mailbox.map(lossy_owned),
        from_host: from.host.map(lossy_owned),
        from_name: from.name.map(lossy_decoded),
        subject: env.subject.map(lossy_decoded),
        date: env.date.map(lossy_owned),
        is_unread,
    })
}

fn envelope_from_fetch(uid: u32, f: &Fetch) -> EmailEnvelope {
    let env = f.envelope();
    EmailEnvelope {
        uid,
        subject: env.and_then(|e| e.subject).map(lossy_decoded),
        from: env
            .map(|e| addresses_from_imap(e.from.as_ref()))
            .unwrap_or_default(),
        to: env
            .map(|e| addresses_from_imap(e.to.as_ref()))
            .unwrap_or_default(),
        cc: env
            .map(|e| addresses_from_imap(e.cc.as_ref()))
            .unwrap_or_default(),
        date: env.and_then(|e| e.date).map(lossy_owned),
        message_id: env
            .and_then(|e| e.message_id)
            .map(lossy_owned),
        in_reply_to: env
            .and_then(|e| e.in_reply_to)
            .map(lossy_owned),
        flags: f.flags().iter().map(flag_to_string).collect(),
    }
}

pub(crate) fn split_email(full: &str) -> (Option<String>, Option<String>) {
    if full.is_empty() {
        return (None, None);
    }
    match full.rfind('@') {
        Some(i) => {
            let mb = &full[..i];
            let h = &full[i + 1..];
            let mb_o = (!mb.is_empty()).then(|| mb.to_string());
            let h_o = (!h.is_empty()).then(|| h.to_string());
            (mb_o, h_o)
        }
        None => (Some(full.to_string()), None),
    }
}

fn addr_from_parser(a: &mail_parser::Addr) -> EmailAddress {
    let (mailbox, host) = a
        .address
        .as_deref()
        .map(split_email)
        .unwrap_or((None, None));
    EmailAddress {
        name: a
            .name
            .as_deref()
            .map(str::to_owned)
            .filter(|s| !s.is_empty()),
        mailbox,
        host,
    }
}

fn addresses_from_parser(opt: Option<&mail_parser::Address>) -> Vec<EmailAddress> {
    let Some(a) = opt else { return Vec::new() };
    a.iter().map(addr_from_parser).collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ConnectStrategy {
    /// Implicit TLS — wrap the socket in TLS immediately.
    Tls,
    /// Cleartext connect, then issue STARTTLS to upgrade.
    Starttls,
}

/// Heuristic: 993 is the universally-assigned implicit-TLS IMAP port.
/// Anything else (143 = stock cleartext IMAP, 1143 = ProtonMail Bridge,
/// 1144 = Bridge alt, etc.) needs STARTTLS.
pub(crate) fn select_connect_strategy(port: u16) -> ConnectStrategy {
    match port {
        993 => ConnectStrategy::Tls,
        _ => ConnectStrategy::Starttls,
    }
}

/// Bridge-style local IMAP relays (ProtonMail Bridge, Hydroxide, etc.)
/// use self-signed certs by default. Trusting localhost is the pragmatic
/// default — MITM there requires local code execution, which already
/// owns the user. Real-host connections still require valid certs.
pub(crate) fn is_local_host(host: &str) -> bool {
    matches!(host, "localhost" | "127.0.0.1" | "::1")
}

fn build_tls_connector(host: &str) -> Result<native_tls::TlsConnector, ImapError> {
    let mut builder = native_tls::TlsConnector::builder();
    if is_local_host(host) {
        builder
            .danger_accept_invalid_certs(true)
            .danger_accept_invalid_hostnames(true);
    }
    builder
        .build()
        .map_err(|e| ImapError::Connect(e.to_string()))
}

pub(crate) fn connect_and_auth(
    host: &str,
    port: u16,
    auth: ImapAuth,
) -> Result<Session<TlsStream<TcpStream>>, ImapError> {
    let tls = build_tls_connector(host)?;
    let client = match select_connect_strategy(port) {
        ConnectStrategy::Tls => imap::connect((host, port), host, &tls)
            .map_err(|e| ImapError::Connect(e.to_string()))?,
        ConnectStrategy::Starttls => imap::connect_starttls((host, port), host, &tls)
            .map_err(|e| ImapError::Connect(e.to_string()))?,
    };
    auth.authenticate(client)
}

pub fn list_senders(
    slot: &Mutex<HandleSlot>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    scan_limit: Option<u32>,
) -> Result<Vec<SenderSummary>, ImapError> {
    let total = {
        let mut g = slot.lock().expect("imap state poisoned");
        match g.refresh_mailbox(&host, port, auth.clone(), &mailbox) {
            Ok(m) => m.exists,
            Err(e) => {
                g.invalidate();
                return Err(e);
            }
        }
    };
    if total == 0 {
        return Ok(Vec::new());
    }
    let n = scan_limit.unwrap_or(500).min(total);
    let seq_start = total - n + 1;
    let range = format!("{seq_start}:*");

    run_with_session(slot, &host, port, auth, &mailbox, |session| {
        let fetches = session
            .fetch(&range, "(ENVELOPE FLAGS UID)")
            .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;
        let records = fetches.iter().filter_map(record_from_fetch);
        Ok(aggregate_senders(records))
    })
}

/// Page size for the streaming sender scan. Small enough that the first
/// chunk lands within ~1s on a typical IMAP RTT, large enough that the
/// per-page round-trip overhead doesn't dominate a 500-message scan.
const STREAM_PAGE: u32 = 50;

pub fn stream_senders(
    slot: &Mutex<HandleSlot>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    scan_limit: Option<u32>,
    on_event: Channel<SenderEvent>,
) -> Result<(), ImapError> {
    let total = {
        let mut g = slot.lock().expect("imap state poisoned");
        match g.refresh_mailbox(&host, port, auth.clone(), &mailbox) {
            Ok(m) => m.exists,
            Err(e) => {
                g.invalidate();
                return Err(e);
            }
        }
    };
    if total == 0 {
        let _ = on_event.send(SenderEvent::Started { total: 0, scan: 0 });
        let _ = on_event.send(SenderEvent::Done);
        return Ok(());
    }

    let n = scan_limit.unwrap_or(500).min(total);
    let _ = on_event.send(SenderEvent::Started { total, scan: n });

    let seq_start = total - n + 1;
    let mut acc: HashMap<String, SenderSummary> = HashMap::new();

    // Walk newest → oldest so the first paint shows the most recent senders.
    // Lock the session once per page and release between pages, so a
    // foreground click during streaming waits at most one page.
    let mut hi = total;
    loop {
        let lo = hi.saturating_sub(STREAM_PAGE - 1).max(seq_start);
        let range = format!("{lo}:{hi}");

        let delta = run_with_session(slot, &host, port, auth.clone(), &mailbox, |session| {
            let fetches = session
                .fetch(&range, "(ENVELOPE FLAGS UID)")
                .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;
            let records = fetches.iter().filter_map(record_from_fetch);
            Ok(merge_into(&mut acc, records))
        })?;

        if !delta.is_empty() {
            let _ = on_event.send(SenderEvent::Chunk { senders: delta });
        }

        if lo == seq_start {
            break;
        }
        hi = lo - 1;
    }

    let _ = on_event.send(SenderEvent::Done);
    Ok(())
}

pub fn fetch_from_sender(
    slot: &Mutex<HandleSlot>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    from_address: String,
    limit: Option<u32>,
) -> Result<Vec<EmailEnvelope>, ImapError> {
    // Try server-side SEARCH first; fall back to a client-side scan if the
    // server's SEARCH response fails to parse (e.g. ProtonMail Bridge).
    let search_outcome = run_with_session(slot, &host, port, auth.clone(), &mailbox, |session| {
        let query = format!("FROM {}", imap_quoted(&from_address));
        match session.uid_search(&query) {
            Ok(set) => Ok(SearchOutcome::Uids(set.into_iter().collect())),
            Err(imap::Error::Parse(pe)) => {
                eprintln!("uid_search parse error, falling back to client-side filter: {pe:?}");
                Ok(SearchOutcome::FallbackNeeded)
            }
            Err(e) => Err(ImapError::Search(format!("{e}: {e:?}"))),
        }
    })?;

    let mut uids: Vec<u32> = match search_outcome {
        SearchOutcome::Uids(u) => u,
        SearchOutcome::FallbackNeeded => {
            let total = {
                let mut g = slot.lock().expect("imap state poisoned");
                match g.refresh_mailbox(&host, port, auth.clone(), &mailbox) {
                    Ok(m) => m.exists,
                    Err(e) => {
                        g.invalidate();
                        return Err(e);
                    }
                }
            };
            return run_with_session(slot, &host, port, auth, &mailbox, |session| {
                fallback_client_side_filter(session, total, &from_address, limit)
            });
        }
    };

    if uids.is_empty() {
        return Ok(Vec::new());
    }

    uids.sort_unstable_by(|a, b| b.cmp(a));
    if let Some(n) = limit {
        uids.truncate(n as usize);
    }

    fetch_envelopes_by_uids(slot, host, port, auth, mailbox, uids)
}

enum SearchOutcome {
    Uids(Vec<u32>),
    FallbackNeeded,
}

pub fn fetch_envelopes_by_uids(
    slot: &Mutex<HandleSlot>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    uids: Vec<u32>,
) -> Result<Vec<EmailEnvelope>, ImapError> {
    if uids.is_empty() {
        return Ok(Vec::new());
    }

    let uid_set = uids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");

    run_with_session(slot, &host, port, auth, &mailbox, |session| {
        let fetches = session
            .uid_fetch(&uid_set, "(ENVELOPE FLAGS UID)")
            .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;

        let by_uid: HashMap<u32, &Fetch> = fetches
            .iter()
            .filter_map(|f| f.uid.map(|u| (u, f)))
            .collect();

        Ok(uids
            .iter()
            .filter_map(|u| by_uid.get(u).map(|f| envelope_from_fetch(*u, f)))
            .collect())
    })
}

/// Lower-cased `mailbox@host` extracted from an envelope's first From
/// address — the comparison key for `envelope_matches_from`.
pub(crate) fn envelope_from_key(env: &EmailEnvelope) -> Option<String> {
    let addr = env.from.first()?;
    let m = addr.mailbox.as_deref().unwrap_or("").to_lowercase();
    let h = addr.host.as_deref().unwrap_or("").to_lowercase();
    if m.is_empty() || h.is_empty() {
        return None;
    }
    Some(format!("{m}@{h}"))
}

pub(crate) fn envelope_matches_from(env: &EmailEnvelope, target_lower: &str) -> bool {
    envelope_from_key(env)
        .map(|k| k == target_lower)
        .unwrap_or(false)
}

fn fallback_client_side_filter(
    session: &mut Session<TlsStream<TcpStream>>,
    total: u32,
    from_address: &str,
    limit: Option<u32>,
) -> Result<Vec<EmailEnvelope>, ImapError> {
    if total == 0 {
        return Ok(Vec::new());
    }
    // Cap how much we scan; large mailboxes would be slow otherwise.
    // 5000 envelopes is plenty for a Bridge-typical use case.
    let scan = limit.unwrap_or(100).clamp(100, 5000).min(total);
    let seq_start = total - scan + 1;
    let range = format!("{seq_start}:*");

    let fetches = session
        .fetch(&range, "(ENVELOPE FLAGS UID)")
        .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;

    let target = from_address.to_lowercase();
    let mut envelopes: Vec<EmailEnvelope> = fetches
        .iter()
        .filter_map(|f| f.uid.map(|u| envelope_from_fetch(u, f)))
        .filter(|env| envelope_matches_from(env, &target))
        .collect();

    envelopes.sort_by_key(|e| std::cmp::Reverse(e.uid));
    if let Some(n) = limit {
        envelopes.truncate(n as usize);
    }
    Ok(envelopes)
}

pub fn fetch_body(
    slot: &Mutex<HandleSlot>,
    host: String,
    port: u16,
    auth: ImapAuth,
    mailbox: String,
    uid: u32,
) -> Result<EmailBody, ImapError> {
    run_with_session(slot, &host, port, auth, &mailbox, |session| {
        // BODY[] (without .PEEK) atomically sets the \Seen flag on the
        // server as part of the same round trip — that's the standard
        // "open mail = mark read" behaviour every regular mail client
        // does. We mirror the flag change in local state on the JS side.
        let fetches = session
            .uid_fetch(uid.to_string(), "(BODY[] UID)")
            .map_err(|e| ImapError::Fetch(format!("{e}: {e:?}")))?;
        let f = fetches.iter().next().ok_or(ImapError::NotFound(uid))?;
        let raw = f
            .body()
            .ok_or_else(|| ImapError::Fetch("no body part returned".into()))?;
        build_email_body(uid, raw)
    })
}

pub(crate) fn build_email_body(uid: u32, raw: &[u8]) -> Result<EmailBody, ImapError> {
    let msg = mail_parser::MessageParser::default()
        .parse(raw)
        .ok_or_else(|| ImapError::Parse("mail-parser returned None".into()))?;

    Ok(EmailBody {
        uid,
        subject: msg.subject().map(str::to_owned),
        from: addresses_from_parser(msg.from()),
        to: addresses_from_parser(msg.to()),
        cc: addresses_from_parser(msg.cc()),
        date: msg.date().map(|d| d.to_rfc822()),
        text_body: msg.body_text(0).map(|c| c.into_owned()),
        html_body: msg.body_html(0).map(|c| c.into_owned()),
        attachments: msg
            .attachments()
            .map(|p| {
                let content_type = p
                    .content_type()
                    .map(|ct| {
                        let sub = ct.subtype().unwrap_or("octet-stream");
                        format!("{}/{}", ct.ctype(), sub)
                    })
                    .unwrap_or_else(|| "application/octet-stream".into());
                AttachmentInfo {
                    filename: p.attachment_name().map(str::to_owned),
                    content_type,
                    size: p.contents().len() as u32,
                }
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(
        uid: u32,
        mailbox: &str,
        host: &str,
        name: Option<&str>,
        subject: Option<&str>,
    ) -> EnvelopeRecord {
        EnvelopeRecord {
            uid,
            from_mailbox: Some(mailbox.into()),
            from_host: Some(host.into()),
            from_name: name.map(Into::into),
            subject: subject.map(Into::into),
            date: None,
            is_unread: false,
        }
    }

    fn rec_unread(uid: u32, mailbox: &str, host: &str) -> EnvelopeRecord {
        EnvelopeRecord {
            uid,
            from_mailbox: Some(mailbox.into()),
            from_host: Some(host.into()),
            from_name: None,
            subject: None,
            date: None,
            is_unread: true,
        }
    }

    #[test]
    fn decode_header_text_decodes_q_and_b_encoded_words() {
        assert_eq!(
            decode_header_text("=?utf-8?q?Keep_the_adventure_rolling=F0=9F=8C=8D?=".into()),
            "Keep the adventure rolling🌍",
        );
        assert_eq!(
            decode_header_text("=?utf-8?B?SGVsbG8sIHdvcmxkIQ==?=".into()),
            "Hello, world!",
        );
    }

    #[test]
    fn decode_header_text_passes_plain_ascii_through_unchanged() {
        assert_eq!(decode_header_text("Done with winter?".into()), "Done with winter?");
        assert_eq!(decode_header_text("".into()), "");
    }

    #[test]
    fn imap_quoted_wraps_and_escapes_control_chars() {
        assert_eq!(imap_quoted("simple@example.com"), "\"simple@example.com\"");
        assert_eq!(imap_quoted("a\"b"), "\"a\\\"b\"");
        assert_eq!(imap_quoted("a\\b"), "\"a\\\\b\"");
        assert_eq!(imap_quoted(""), "\"\"");
    }

    #[test]
    fn merge_into_records_uids_newest_first_across_chunks() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();

        // First chunk: oldest two messages.
        let _ = merge_into(
            &mut acc,
            vec![
                rec(10, "a", "b.com", None, None),
                rec(12, "a", "b.com", None, None),
            ],
        );
        let s = acc.get("b.com").unwrap();
        assert_eq!(s.uids, vec![12, 10]);

        // Second chunk: a newer one and an even older one — interleave correctly.
        let _ = merge_into(
            &mut acc,
            vec![
                rec(20, "a", "b.com", None, None),
                rec(5, "a", "b.com", None, None),
            ],
        );
        let s = acc.get("b.com").unwrap();
        assert_eq!(s.uids, vec![20, 12, 10, 5]);
        assert_eq!(s.message_count, 4);
        assert_eq!(s.latest_uid, 20);
    }

    #[test]
    fn merge_into_counts_unread_records_only() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();
        let _ = merge_into(
            &mut acc,
            vec![
                rec(1, "a", "b.com", None, None),       // read
                rec_unread(2, "a", "b.com"),
                rec_unread(3, "a", "b.com"),
                rec(4, "a", "b.com", None, None),       // read
            ],
        );
        let s = acc.get("b.com").unwrap();
        assert_eq!(s.message_count, 4);
        assert_eq!(s.unread_count, 2);
    }

    #[test]
    fn aggregate_groups_case_insensitively() {
        let recs = vec![
            rec(1, "Ada", "Example.com", Some("Ada L."), Some("hi")),
            rec(2, "ada", "example.com", Some("Ada"), Some("hello")),
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message_count, 2);
        // example.com is a non-consumer host → domain-grouped, mailbox dropped.
        assert!(out[0].address.mailbox.is_none());
        assert_eq!(out[0].address.host.as_deref(), Some("example.com"));
    }

    #[test]
    fn aggregate_picks_latest_uid_subject_date_and_name() {
        let recs = vec![
            EnvelopeRecord {
                uid: 5,
                from_mailbox: Some("a".into()),
                from_host: Some("b.com".into()),
                from_name: Some("Older".into()),
                subject: Some("old".into()),
                date: Some("Mon, 01 Jan 2024 00:00:00 +0000".into()),
                is_unread: false,
            },
            EnvelopeRecord {
                uid: 10,
                from_mailbox: Some("a".into()),
                from_host: Some("b.com".into()),
                from_name: Some("Newer".into()),
                subject: Some("new".into()),
                date: Some("Tue, 02 Jan 2024 00:00:00 +0000".into()),
                is_unread: false,
            },
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].latest_uid, 10);
        assert_eq!(out[0].latest_subject.as_deref(), Some("new"));
        assert_eq!(out[0].display_name.as_deref(), Some("Newer"));
    }

    #[test]
    fn aggregate_keeps_existing_display_name_when_newer_record_has_none() {
        let recs = vec![
            rec(1, "a", "b.com", Some("Real Name"), None),
            rec(2, "a", "b.com", None, None),
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out[0].display_name.as_deref(), Some("Real Name"));
        assert_eq!(out[0].latest_uid, 2);
    }

    #[test]
    fn aggregate_drops_records_missing_mailbox_or_host() {
        let recs = vec![
            rec(1, "", "b.com", None, None),
            rec(2, "a", "", None, None),
            rec(3, "a", "b.com", None, None),
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].message_count, 1);
    }

    #[test]
    fn aggregate_sorts_descending_by_latest_uid() {
        // Three distinct brand hosts so domain-grouping doesn't fold
        // them into one entry; we're verifying sort by latest_uid.
        let recs = vec![
            rec(5, "x", "older.com", None, None),
            rec(99, "x", "newer.com", None, None),
            rec(50, "x", "middle.com", None, None),
        ];
        let out = aggregate_senders(recs);
        assert_eq!(out[0].address.host.as_deref(), Some("newer.com"));
        assert_eq!(out[1].address.host.as_deref(), Some("middle.com"));
        assert_eq!(out[2].address.host.as_deref(), Some("older.com"));
    }

    #[test]
    fn is_consumer_domain_recognises_known_providers() {
        assert!(is_consumer_domain("gmail.com"));
        assert!(is_consumer_domain("googlemail.com"));
        assert!(is_consumer_domain("icloud.com"));
        assert!(is_consumer_domain("proton.me"));
        assert!(is_consumer_domain("GMAIL.COM"));
        assert!(is_consumer_domain("  gmail.com  "));

        assert!(!is_consumer_domain("vercel.com"));
        assert!(!is_consumer_domain("cnn.com"));
        // Subdomains of consumer providers stay consumer (so a stray
        // `m.gmail.com` correspondent doesn't get domain-aggregated).
        assert!(is_consumer_domain("mail.gmail.com"));
        assert!(!is_consumer_domain("email.brand.com"));
        assert!(!is_consumer_domain(""));
    }

    #[test]
    fn merge_into_groups_brand_records_by_host_only() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();
        let _ = merge_into(
            &mut acc,
            vec![
                rec(10, "noreply", "vercel.com", Some("Vercel"), Some("welcome")),
                rec(20, "support", "vercel.com", Some("Vercel Support"), Some("re: ticket")),
                rec(15, "welcome", "vercel.com", None, Some("hi")),
            ],
        );
        assert_eq!(acc.len(), 1);
        let s = acc.get("vercel.com").expect("domain-keyed entry");
        assert!(s.address.mailbox.is_none());
        assert_eq!(s.address.host.as_deref(), Some("vercel.com"));
        assert_eq!(s.message_count, 3);
        assert_eq!(s.uids, vec![20, 15, 10]);
        // display_name follows the latest UID across all mailboxes.
        assert_eq!(s.display_name.as_deref(), Some("Vercel Support"));
        assert_eq!(s.latest_uid, 20);
        assert_eq!(s.hosts, vec!["vercel.com".to_string()]);
    }

    #[test]
    fn registrable_domain_strips_subdomains_via_psl() {
        // Plain eTLD+1 → unchanged.
        assert_eq!(registrable_domain("linear.app"), "linear.app");
        assert_eq!(registrable_domain("netflix.com"), "netflix.com");
        // Subdomains collapse.
        assert_eq!(registrable_domain("updates.linear.app"), "linear.app");
        assert_eq!(registrable_domain("members.netflix.com"), "netflix.com");
        assert_eq!(registrable_domain("a.b.c.example.com"), "example.com");
        // Multi-part TLDs handled correctly by the PSL.
        assert_eq!(registrable_domain("foo.bbc.co.uk"), "bbc.co.uk");
        // Case-insensitive input → lowercased output.
        assert_eq!(registrable_domain("Updates.Linear.APP"), "linear.app");
        // Unrecognised hosts fall back unchanged (lowercased).
        assert_eq!(registrable_domain("localhost"), "localhost");
        assert_eq!(registrable_domain("127.0.0.1"), "127.0.0.1");
    }

    #[test]
    fn merge_into_collapses_subdomains_to_registrable_domain() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();
        let _ = merge_into(
            &mut acc,
            vec![
                rec(10, "noreply", "linear.app", Some("Linear"), Some("welcome")),
                rec(20, "alerts", "updates.linear.app", Some("Linear Updates"), Some("digest")),
                rec(15, "team", "linear.app", None, Some("hi")),
            ],
        );
        assert_eq!(acc.len(), 1);
        let s = acc.get("linear.app").expect("registrable-domain key");
        assert!(s.address.mailbox.is_none());
        assert_eq!(s.address.host.as_deref(), Some("linear.app"));
        assert_eq!(s.message_count, 3);
        assert_eq!(s.uids, vec![20, 15, 10]);
        assert_eq!(s.display_name.as_deref(), Some("Linear Updates"));
        // Both the apex and the subdomain are retained as BIMI-lookup
        // candidates so the frontend can fall back when the apex misses.
        assert_eq!(
            s.hosts,
            vec!["linear.app".to_string(), "updates.linear.app".to_string()],
        );
    }

    #[test]
    fn is_consumer_domain_treats_subdomains_of_known_providers_as_consumer() {
        assert!(is_consumer_domain("m.gmail.com"));
        assert!(is_consumer_domain("mail.proton.me"));
        // Brand subdomains stay non-consumer.
        assert!(!is_consumer_domain("updates.linear.app"));
        assert!(!is_consumer_domain("members.netflix.com"));
    }

    #[test]
    fn merge_into_keeps_consumer_records_per_mailbox() {
        let mut acc: HashMap<String, SenderSummary> = HashMap::new();
        let _ = merge_into(
            &mut acc,
            vec![
                rec(10, "alice", "gmail.com", Some("Alice"), None),
                rec(11, "bob", "gmail.com", Some("Bob"), None),
                rec(12, "alice", "gmail.com", Some("Alice"), None),
            ],
        );
        assert_eq!(acc.len(), 2);
        let alice = acc.get("alice@gmail.com").expect("alice keyed per-mailbox");
        assert_eq!(alice.address.mailbox.as_deref(), Some("alice"));
        assert_eq!(alice.address.host.as_deref(), Some("gmail.com"));
        assert_eq!(alice.message_count, 2);
        assert_eq!(alice.uids, vec![12, 10]);
        assert_eq!(alice.hosts, vec!["gmail.com".to_string()]);
        let bob = acc.get("bob@gmail.com").expect("bob keyed per-mailbox");
        assert_eq!(bob.message_count, 1);
        assert_eq!(bob.address.mailbox.as_deref(), Some("bob"));
        assert_eq!(bob.hosts, vec!["gmail.com".to_string()]);
    }

    #[test]
    fn split_email_separates_at_last_at_sign() {
        assert_eq!(
            split_email("ada@example.com"),
            (Some("ada".into()), Some("example.com".into()))
        );
        assert_eq!(
            split_email("first+tag@sub.example.com"),
            (
                Some("first+tag".into()),
                Some("sub.example.com".into())
            )
        );
        assert_eq!(split_email(""), (None, None));
        assert_eq!(split_email("nohost"), (Some("nohost".into()), None));
    }

    #[test]
    fn select_connect_strategy_uses_implicit_tls_only_for_993() {
        assert_eq!(select_connect_strategy(993), ConnectStrategy::Tls);
        assert_eq!(select_connect_strategy(143), ConnectStrategy::Starttls);
        assert_eq!(select_connect_strategy(1143), ConnectStrategy::Starttls);
        assert_eq!(select_connect_strategy(1144), ConnectStrategy::Starttls);
        assert_eq!(select_connect_strategy(2143), ConnectStrategy::Starttls);
    }

    #[test]
    fn is_local_host_recognises_loopback_names_only() {
        assert!(is_local_host("localhost"));
        assert!(is_local_host("127.0.0.1"));
        assert!(is_local_host("::1"));
        assert!(!is_local_host("example.com"));
        assert!(!is_local_host("imap.fastmail.com"));
        assert!(!is_local_host("192.168.1.1"));
    }

    #[test]
    fn flag_to_string_uses_backslash_prefixed_keywords() {
        assert_eq!(flag_to_string(&Flag::Seen), "\\Seen");
        assert_eq!(flag_to_string(&Flag::Answered), "\\Answered");
        assert_eq!(
            flag_to_string(&Flag::Custom("$Important".into())),
            "$Important"
        );
    }

    fn env_with_from(uid: u32, mailbox: &str, host: &str) -> EmailEnvelope {
        EmailEnvelope {
            uid,
            subject: None,
            from: vec![EmailAddress {
                name: None,
                mailbox: Some(mailbox.into()),
                host: Some(host.into()),
            }],
            to: vec![],
            cc: vec![],
            date: None,
            message_id: None,
            in_reply_to: None,
            flags: vec![],
        }
    }

    #[test]
    fn envelope_from_key_is_lowercase_mailbox_at_host() {
        let e = env_with_from(1, "Ada", "Example.COM");
        assert_eq!(envelope_from_key(&e).as_deref(), Some("ada@example.com"));
    }

    #[test]
    fn envelope_from_key_returns_none_when_either_part_empty() {
        let mut e = env_with_from(1, "ada", "");
        assert!(envelope_from_key(&e).is_none());
        e = env_with_from(1, "", "example.com");
        assert!(envelope_from_key(&e).is_none());
    }

    #[test]
    fn envelope_from_key_returns_none_when_from_list_empty() {
        let e = EmailEnvelope {
            uid: 1,
            subject: None,
            from: vec![],
            to: vec![],
            cc: vec![],
            date: None,
            message_id: None,
            in_reply_to: None,
            flags: vec![],
        };
        assert!(envelope_from_key(&e).is_none());
    }

    #[test]
    fn envelope_matches_from_compares_case_insensitively_against_lowercase_target() {
        let e = env_with_from(1, "Ada", "Example.com");
        assert!(envelope_matches_from(&e, "ada@example.com"));
        assert!(!envelope_matches_from(&e, "bob@example.com"));
    }

    #[test]
    fn build_email_body_parses_minimal_text_message() {
        let raw = b"From: Ada <ada@example.com>\r\n\
            To: Bob <bob@example.com>\r\n\
            Subject: Hello\r\n\
            Date: Mon, 01 Jan 2024 12:00:00 +0000\r\n\
            Content-Type: text/plain; charset=utf-8\r\n\
            \r\n\
            This is the body.\r\n";
        let body = build_email_body(42, raw).expect("parse");
        assert_eq!(body.uid, 42);
        assert_eq!(body.subject.as_deref(), Some("Hello"));
        assert_eq!(body.from.len(), 1);
        assert_eq!(body.from[0].mailbox.as_deref(), Some("ada"));
        assert_eq!(body.from[0].host.as_deref(), Some("example.com"));
        assert_eq!(body.from[0].name.as_deref(), Some("Ada"));
        assert_eq!(body.to.len(), 1);
        assert!(body
            .text_body
            .as_deref()
            .unwrap_or("")
            .contains("This is the body."));
        assert!(body.attachments.is_empty());
    }

    #[test]
    fn build_email_body_extracts_attachment_metadata() {
        let raw = b"From: a@b.com\r\n\
            To: c@d.com\r\n\
            Subject: with attach\r\n\
            MIME-Version: 1.0\r\n\
            Content-Type: multipart/mixed; boundary=\"BOUND\"\r\n\
            \r\n\
            --BOUND\r\n\
            Content-Type: text/plain\r\n\
            \r\n\
            hi\r\n\
            --BOUND\r\n\
            Content-Type: text/plain; name=\"note.txt\"\r\n\
            Content-Disposition: attachment; filename=\"note.txt\"\r\n\
            \r\n\
            attached\r\n\
            --BOUND--\r\n";
        let body = build_email_body(1, raw).expect("parse");
        assert_eq!(body.attachments.len(), 1);
        assert_eq!(body.attachments[0].filename.as_deref(), Some("note.txt"));
        assert!(body.attachments[0].content_type.starts_with("text/plain"));
        assert!(body.attachments[0].size > 0);
    }
}
