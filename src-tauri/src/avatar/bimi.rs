//! BIMI lookup: DNS TXT at `default._bimi.<domain>` → parse the `l=`
//! field → HTTPS GET the SVG.
//!
//! Deliberately skips VMC (Verified Mark Certificate) chain validation
//! and DMARC alignment checks — both are heavy and require PKI/DNS
//! plumbing that we don't need for a personal mail client. We trust the
//! domain's own claim and render whatever SVG it points at, capped at a
//! sensible size.

use std::sync::OnceLock;
use std::time::Duration;

use base64::Engine;
use hickory_resolver::{
    config::{ResolverConfig, ResolverOpts},
    name_server::TokioConnectionProvider,
    system_conf, AsyncResolver,
};

const FETCH_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SVG_BYTES: usize = 256 * 1024;

type Resolver = AsyncResolver<TokioConnectionProvider>;

fn http_client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(FETCH_TIMEOUT)
            .user_agent("email-balls/0.1 (bimi-fetch)")
            .build()
            .expect("reqwest client build")
    })
}

fn resolver() -> &'static Resolver {
    static RESOLVER: OnceLock<Resolver> = OnceLock::new();
    RESOLVER.get_or_init(|| {
        // Prefer the user's system DNS (so e.g. Pi-hole / corporate DNS
        // resolvers are honoured, and Cloudflare doesn't see every BIMI
        // probe); fall back to the bundled defaults if reading the system
        // config fails — this is common in sandboxed builds on macOS.
        let (config, opts) = system_conf::read_system_conf()
            .unwrap_or_else(|_| (ResolverConfig::default(), ResolverOpts::default()));
        AsyncResolver::tokio(config, opts)
    })
}

/// Returns Ok(Some(svg_bytes)) if the domain publishes a fetchable
/// BIMI logo, Ok(None) if there's no record / no `l=` / fetch failed
/// in a way that indicates "no logo here", or Err(...) for transient
/// errors the caller should treat as missing too.
pub async fn lookup(domain: &str) -> Result<Option<Vec<u8>>, BimiError> {
    let qname = format!("default._bimi.{domain}.");

    // Hickory returns NoRecordsFound as an Err — collapse that into
    // Ok(None) so we cache it as a clean negative.
    let txt = match resolver().txt_lookup(&qname).await {
        Ok(t) => t,
        Err(e) if is_no_records(&e) => return Ok(None),
        Err(e) => return Err(BimiError::Dns(e.to_string())),
    };

    let record = txt
        .iter()
        .map(|t| flatten_txt_chunks(t.txt_data()))
        .find_map(|s| if looks_like_bimi(&s) { Some(s) } else { None });

    let Some(record) = record else {
        return Ok(None);
    };

    let Some(svg_url) = parse_l_tag(&record) else {
        return Ok(None);
    };

    // Only fetch over HTTPS — `http://` BIMI URLs are spec violations
    // and we don't want to mix-content load them.
    if !svg_url.starts_with("https://") {
        return Ok(None);
    }

    let resp = match http_client().get(&svg_url).send().await {
        Ok(r) => r,
        Err(_) => return Ok(None),
    };

    if !resp.status().is_success() {
        return Ok(None);
    }

    // Content-Length pre-check: bail before pulling the body if the
    // server announces something larger than our cap. Cheap defence
    // against a domain pointing `l=` at an arbitrary large file.
    if let Some(len) = resp.content_length() {
        if len > MAX_SVG_BYTES as u64 {
            return Ok(None);
        }
    }

    let bytes = match resp.bytes().await {
        Ok(b) => b,
        Err(_) => return Ok(None),
    };

    if bytes.len() > MAX_SVG_BYTES {
        return Ok(None);
    }

    if !looks_like_svg(&bytes) {
        return Ok(None);
    }

    Ok(Some(bytes.to_vec()))
}

pub fn svg_data_url(bytes: &[u8]) -> String {
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("data:image/svg+xml;base64,{b64}")
}

fn is_no_records(err: &hickory_resolver::error::ResolveError) -> bool {
    use hickory_resolver::error::ResolveErrorKind;
    matches!(err.kind(), ResolveErrorKind::NoRecordsFound { .. })
}

/// TXT records arrive as a list of <=255 byte chunks per RFC 1035.
/// BIMI joins them with no separator.
fn flatten_txt_chunks(chunks: &[Box<[u8]>]) -> String {
    let total: usize = chunks.iter().map(|c| c.len()).sum();
    let mut buf = String::with_capacity(total);
    for c in chunks {
        buf.push_str(&String::from_utf8_lossy(c));
    }
    buf
}

fn looks_like_bimi(s: &str) -> bool {
    // Per spec the version tag must be first and case-insensitive.
    let trimmed = s.trim_start();
    trimmed.to_ascii_lowercase().starts_with("v=bimi1")
}

/// Extract the `l=` value (logo URL) from a BIMI record. Tags are
/// `;`-separated key=value pairs; whitespace around `=` is allowed.
pub fn parse_l_tag(record: &str) -> Option<String> {
    for part in record.split(';') {
        let part = part.trim();
        let Some(eq) = part.find('=') else { continue };
        let (k, v) = part.split_at(eq);
        if k.trim().eq_ignore_ascii_case("l") {
            let v = v[1..].trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn looks_like_svg(bytes: &[u8]) -> bool {
    // Strip leading whitespace + an optional UTF-8 BOM, then look for
    // either an XML prolog or a bare `<svg` opening tag. This is enough
    // to reject obvious non-SVG payloads (HTML 404 pages, etc.) without
    // pulling in a real XML parser.
    let mut start = 0;
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        start = 3;
    }
    let rest = &bytes[start..];
    let trimmed = match rest.iter().position(|b| !b.is_ascii_whitespace()) {
        Some(i) => &rest[i..],
        None => return false,
    };
    let head = &trimmed[..trimmed.len().min(64)];
    let head_lower: Vec<u8> = head.iter().map(u8::to_ascii_lowercase).collect();
    head_lower.starts_with(b"<?xml") || head_lower.starts_with(b"<svg")
}

#[derive(Debug, thiserror::Error)]
pub enum BimiError {
    #[error("dns: {0}")]
    Dns(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_l_tag_extracts_logo_url() {
        let r = "v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/cert.pem";
        assert_eq!(
            parse_l_tag(r).as_deref(),
            Some("https://example.com/logo.svg"),
        );
    }

    #[test]
    fn parse_l_tag_handles_extra_whitespace_and_no_a_tag() {
        let r = "  v=BIMI1 ;   l =  https://example.com/logo.svg  ;";
        assert_eq!(
            parse_l_tag(r).as_deref(),
            Some("https://example.com/logo.svg"),
        );
    }

    #[test]
    fn parse_l_tag_returns_none_when_logo_missing_or_empty() {
        assert_eq!(parse_l_tag("v=BIMI1; a=https://example.com/cert.pem"), None);
        assert_eq!(parse_l_tag("v=BIMI1; l=; a=x"), None);
        assert_eq!(parse_l_tag(""), None);
    }

    #[test]
    fn looks_like_bimi_is_case_insensitive_and_ignores_leading_space() {
        assert!(looks_like_bimi("v=BIMI1; l=x"));
        assert!(looks_like_bimi("  V=bimi1; l=x"));
        assert!(!looks_like_bimi("spf1 v=BIMI1"));
        assert!(!looks_like_bimi("v=spf1"));
    }

    #[test]
    fn looks_like_svg_accepts_xml_prolog_and_bare_svg_tag() {
        assert!(looks_like_svg(b"<?xml version=\"1.0\"?><svg/>"));
        assert!(looks_like_svg(b"<svg xmlns=\"http://www.w3.org/2000/svg\"/>"));
        assert!(looks_like_svg(b"   \n<SVG/>"));
        assert!(looks_like_svg(b"\xEF\xBB\xBF<svg/>"));
    }

    #[test]
    fn looks_like_svg_rejects_html_and_empty() {
        assert!(!looks_like_svg(b"<!doctype html><html>404</html>"));
        assert!(!looks_like_svg(b"random binary data"));
        assert!(!looks_like_svg(b""));
    }

    #[test]
    fn svg_data_url_uses_base64_image_svg() {
        let url = svg_data_url(b"<svg/>");
        assert!(url.starts_with("data:image/svg+xml;base64,"));
        let b64 = url.trim_start_matches("data:image/svg+xml;base64,");
        let decoded = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        assert_eq!(decoded, b"<svg/>");
    }

    #[test]
    fn flatten_txt_chunks_concatenates_in_order() {
        let chunks: Vec<Box<[u8]>> = vec![
            b"v=BIMI1; l=https://exa".to_vec().into_boxed_slice(),
            b"mple.com/logo.svg".to_vec().into_boxed_slice(),
        ];
        let joined = flatten_txt_chunks(&chunks);
        assert_eq!(joined, "v=BIMI1; l=https://example.com/logo.svg");
    }
}
