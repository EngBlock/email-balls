# Security Policy

Email Balls handles personal mailboxes and account credentials, so security
reports are taken seriously even though the project is in early development
and maintained by a single author.

## Reporting a Vulnerability

**Please do not file public GitHub issues for security problems.**

Report suspected vulnerabilities privately by either:

- Using GitHub's [private vulnerability reporting](https://github.com/engblock/email-balls/security/advisories/new)
  for this repository, or
- Emailing the maintainer at **nbedd2@protonmail.com** with a subject line
  starting with `[email-balls security]`.

> The email address above is the maintainer contact listed in `package.json`
> and `Cargo.toml`. If a dedicated security alias is published in the future
> it should be preferred; until then, this address is the canonical channel.

When reporting, please include as much of the following as you can:

- A description of the issue and the impact you believe it has.
- Steps to reproduce, a proof-of-concept, or a minimal test case.
- The affected version or commit SHA, your OS, and how you built the app.
- Whether the issue is already public or known elsewhere.

You should expect an initial acknowledgement within roughly **7 days**.
Because this is a solo project, deeper investigation and a fix may take
longer; updates will be sent as the issue progresses. Please give a
reasonable window for a fix to ship before any public disclosure, and
coordinate timing if you intend to publish details.

Researchers acting in good faith under this policy will not be pursued
through legal action for their report.

## Supported Versions

Email Balls is pre-1.0 (currently `0.1.0`) and has no formal release
support policy yet. Only the **latest commit on `main`** is actively
maintained for security fixes. Older tags and unreleased branches will
not receive backported patches.

| Version            | Security fixes |
| ------------------ | -------------- |
| `main` (latest)    | Yes            |
| `0.1.x` pre-release| Best-effort    |
| Anything older     | No             |

Once a stable release line exists this table will be updated.

## Scope

The areas below are explicitly in scope. Reports that demonstrate a
realistic attack against any of them are welcome:

- **HTML email rendering.** HTML messages are sanitized with DOMPurify
  and rendered inside a sandboxed iframe. Sandbox escapes, sanitizer
  bypasses, script execution in the message view, exfiltration of
  cookies / local storage / file URLs, or network requests that leak
  the recipient's IP without consent are all in scope.
- **Credential storage.** Account credentials (IMAP username / password,
  any OAuth tokens) are stored via the Tauri Stronghold plugin
  (Argon2-derived key, salt stored alongside the local cache files).
  Issues that allow recovery of stored credentials by another local
  process, by a malicious email, or by a tampered cache are in scope.
- **IMAP transport.** The IMAP client is built on the `imap` crate with
  `native-tls`. Reports of TLS being downgraded, certificate validation
  being skipped, STARTTLS being stripped, or credentials being sent
  over an untrusted channel are in scope.
- **Local caches.** The SQLite envelope cache and BIMI lookup cache
  live under the OS application-data directory. Path traversal, SQL
  injection, or cache-poisoning that influences what the user sees in
  the UI is in scope.
- **Tauri IPC surface.** Any command exposed from the Rust backend to
  the webview that can be abused to read or modify data outside the
  caller's intent.
- **Avatar / BIMI lookups.** Outbound DNS or HTTPS fetches that can be
  used to deanonymize the user, fetch attacker-controlled content into
  a privileged context, or trigger SSRF against local services.

### Out of scope

- Vulnerabilities in upstream dependencies that are already publicly
  tracked (please report those upstream and link the advisory).
- Findings that require an attacker who already has full local user
  access to the machine running the app, or who can already read the
  user's OS keystore.
- Social-engineering, phishing of the maintainer, or physical attacks.
- Denial-of-service achievable only by an authenticated user against
  their own mailbox.
- Missing security headers or TLS configuration on `github.com` or
  other third-party services this project merely links to.

## Disclosure

After a fix is available, the advisory will be published via GitHub
Security Advisories on this repository, and the release notes for the
patched version will reference the advisory ID. Reporters who wish to
be credited will be acknowledged in the advisory; anonymous reports are
also accepted.
