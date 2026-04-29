# Email Balls

Email Balls is a desktop email client that turns your inbox into a force-directed graph of sender bubbles, sized by how often they email you. Click a bubble to read that sender's recent messages. It connects to any IMAP mailbox, stores credentials in the OS keystore via Tauri Stronghold, and runs as a native app on macOS, Linux, and Windows.

> **Status:** early development. The app works end-to-end against a real IMAP server but is not yet packaged for distribution. Expect rough edges.

## Screenshot

![Screenshot of the app once fully loaded](docs/README_SCREENSHOT.png "Screenshot of Email Balls once fully loaded")
---

## Features

- **Sender-bubble visualization.** Force-directed layout (d3-force + Framer Motion) where bubble size reflects message volume from each sender.
- **IMAP over TLS.** Connect to any IMAP server with username/password auth.
- **Live updates via IDLE.** New mail is reflected without manual refresh while the app is open.
- **HTML and plain-text rendering.** HTML is sanitized with DOMPurify and rendered in a sandboxed iframe; a plain-text fallback is also available.
- **Avatars.** BIMI logos when available, falling back to Gravatar.
- **Local caches.** SQLite envelope cache and a BIMI lookup cache keep the UI responsive across restarts.
- **Encrypted credential storage.** Account credentials are stored via the Tauri Stronghold plugin.

## Install

No prebuilt binaries are published yet. To run Email Balls today, build it from source — see **Develop** below.

## Develop

### Prerequisites

- [Rust toolchain](https://www.rust-lang.org/tools/install) (stable) and the platform-specific [Tauri prerequisites](https://tauri.app/start/prerequisites/)
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/installation)

### Setup

```sh
pnpm install
cp .env.example .env   # optional; see .env.example for the supported variables
```

### Run the desktop app

```sh
pnpm tauri dev
```

This starts the Vite dev server and launches the Tauri shell.

### Run the frontend only

```sh
pnpm dev
```

Useful for UI work that does not require the Rust backend.

### Tests

```sh
pnpm test          # frontend (Vitest)
cargo test         # backend (run from src-tauri/)
```

### Build a production bundle

```sh
pnpm tauri build
```

Outputs platform-native installers under `src-tauri/target/release/bundle/`.

## Architecture at a glance

- **Frontend:** React 19 + TypeScript + Vite. The bubble layout is driven by `d3-force`; animations use Framer Motion.
- **Backend:** Rust via Tauri 2. IMAP traffic uses the `imap` + `mail-parser` crates over native TLS. Caches live in `app_local_data` (SQLite envelope cache, BIMI JSON cache).
- **Credentials:** managed by the Tauri Stronghold plugin (Argon2-derived key, salt stored alongside the cache files).

For a deeper walkthrough see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Contributing

Contributions are welcome. Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) for development workflow, coding conventions, and how to file issues or pull requests.

## License

Released under the [MIT License](LICENSE). © 2026 Nathan Beddoe.
