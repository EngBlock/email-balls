# Contributing to Email Balls

Thanks for your interest in contributing. Email Balls is in early development, so workflows are still settling — when in doubt, open an issue and ask before doing significant work.

## Local setup

### Prerequisites

- [Rust toolchain](https://www.rust-lang.org/tools/install) (stable) and the platform-specific [Tauri prerequisites](https://tauri.app/start/prerequisites/)
- [Node.js](https://nodejs.org/) 20+
- [pnpm](https://pnpm.io/installation)

### Install

```sh
git clone https://github.com/engblock/email-balls.git
cd email-balls
pnpm install
cp .env.example .env   # optional; see .env.example for supported variables
```

### Run

```sh
pnpm tauri dev   # full desktop app (Vite + Tauri shell)
pnpm dev         # frontend only — useful when iterating on UI without the Rust backend
```

Production bundle:

```sh
pnpm tauri build
```

Outputs platform-native installers under `src-tauri/target/release/bundle/`.

## Project layout

- `src/` — React 19 + TypeScript frontend (Vite). Bubble layout via `d3-force`, animations via Framer Motion.
- `src-tauri/` — Rust backend (Tauri 2). IMAP, caching (SQLite via `rusqlite`), avatars/BIMI, and Stronghold-backed credential storage live here.
- `public/` — static assets served by Vite.

## Tests and checks

Frontend (Vitest, jsdom):

```sh
pnpm test
```

Type-checking is run as part of the build:

```sh
pnpm build       # runs `tsc` then `vite build`
```

Backend (run from `src-tauri/`):

```sh
cargo test
cargo fmt
cargo clippy
```

There is no `pnpm lint` script configured yet, and the frontend has no ESLint/Prettier config in-tree. If you add one, please open a discussion first so we can agree on the rule set before it lands.

Please make sure the relevant checks pass before opening a PR:

- For frontend changes: `pnpm test` and `pnpm build`.
- For backend changes: `cargo fmt`, `cargo clippy`, and `cargo test` (from `src-tauri/`).
- For changes that touch both: run all of the above.

## Commit messages

We're moving toward [Conventional Commits](https://www.conventionalcommits.org/) for new commits. Earlier commits (e.g. `b8083e4 Implement Email Balls email client`, `a8d1fc5 Add secure HTML and plain-text email rendering`) predate this convention and use plain imperative subjects — please follow the new format going forward rather than mirroring the older style.

Format:

```
<type>(<optional scope>): <short imperative summary>

<optional body explaining the why>
```

Common types: `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `build`, `chore`.

Examples:

```
feat(imap): collapse Outlook-style quoted replies
fix(avatar): fall back to Gravatar when BIMI lookup times out
docs: document local development workflow
```

Keep the subject under ~72 characters and use the body to explain the *why* when it isn't obvious from the diff.

## Pull requests

Before opening a PR:

1. **Open or link an issue.** Larger changes should have an issue describing the problem and proposed approach so we can align before review.
2. **Keep PRs focused.** Smaller, single-purpose PRs are much easier to review and land.
3. **Run tests and checks** listed above for the areas you touched.
4. **Update docs** when behavior, configuration, or developer workflow changes (`README.md`, `.env.example`, this file, etc.).

In the PR description, please include:

- A short summary of the change and the motivation.
- The issue it closes or relates to (`Closes #123` / `Refs #123`).
- **Screenshots or a short screen recording for any UI-visible change** (the bubble view, drawers, email rendering, etc.). Static screenshots are fine; animated GIFs are great for layout/motion changes.
- Notes on anything intentionally out of scope or known follow-ups.

## Reporting bugs and security issues

- **Bugs and feature requests:** open an issue at <https://github.com/engblock/email-balls/issues>. Include OS, app version (or commit SHA), reproduction steps, and any relevant logs.
- **Security issues:** please do *not* file a public issue. Email the maintainer (see `package.json`'s `author` field) with details and we'll coordinate a fix before disclosure.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE) that covers the project.
