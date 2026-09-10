# Frondose

Frondose is a desktop app that runs a sales agent against your own LinkedIn
account. You bring an LLM API key and a description of how you sell. The agent
reads pages through a real Chrome browser, remembers people and companies in a
local database, and asks for approval before it sends anything on your behalf.

The compiled app is the product. This repository holds its source.

## What it does

- Watches the LinkedIn pages you browse and extracts people into a local
  SQLite database.
- Scores people against your positioning, drafts outreach, and keeps a ledger
  of every action it took.
- Runs on a schedule if you allow it, with rate caps and an approval gate
  before any outbound action.
- Works on macOS and Windows.

## Install

Download an installer from
[GitHub Releases](https://github.com/kyoubelyu/frondose/releases/latest):

- macOS: `Frondose-universal.dmg`
- Windows: `Frondose-windows-x86_64-setup.exe`

The app updates itself through a signed update channel. macOS builds are
ad-hoc codesigned, so Gatekeeper will ask you to approve the first launch
(System Settings, Privacy & Security, Open Anyway, or `xattr -cr` on the
downloaded file).

## Configuration

On first launch, Settings asks for:

1. An OpenAI-compatible endpoint URL, model name, and API key. Frondose talks
   to exactly one custom endpoint, such as a DeepSeek-compatible service. It
   does not call Anthropic, OpenAI, or any other vendor directly.
2. Your identity and sales context. The agent sells as you, so it needs to
   know how you position yourself.
3. Optional: a Brave Search API key, a Telegram bot token, and a GitHub token
   for issue output.

Anything unconfigured degrades gracefully. Web search reports
`missing_config`, output tools stay quiet, and the core agent keeps working.
Your data lives under `~/.frondose` on your machine.

## Usage modes

- **Manual** approves every outbound action before it happens. Drafts wait,
  you confirm, then it sends.
- **Magical** only watches. It reads pages you visit and writes to its own
  local database. No messages, no clicks that leave your machine.
- **Auto** runs on a schedule within bounds you set: an approval gate for
  outbound actions, per-run caps, and a persisted ledger of everything it
  did.

## Building from source

Requirements: Node 20 or newer, the Rust toolchain, Tauri v2 prerequisites
(https://tauri.app), and a local Chrome for a handful of tests.

```bash
npm ci
npm run check          # typecheck
npm run lint           # biome
npm run build:tauri    # compile TS + Tauri UI assets
npm run test:fast      # mock test suite
cd src/tauri && npx tauri build
```

`test:fast` expects the built `dist/` tree, and a few of its tests need
Chrome and cargo. The native hardware-input addon (`native/`) is optional;
without its toolchain the build falls back to CDP-only input.

## Repository layout

```
src/                    agent, tools, persistence, sidecar backend (TypeScript)
src/tauri/src-tauri/    Tauri backend (Rust)
src/tauri/ui/           app UI (React/TypeScript)
projects/web/           landing page (standalone static site)
scripts/                build, test, and release tooling
tests/                  mock and contract test suites
native/                 optional hardware-input addon (C)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Tool names and parameter schemas are
product contract. The security boundaries are not negotiable: the agent layer
runs no shell commands and does no arbitrary file I/O. Report vulnerabilities
privately per [SECURITY.md](SECURITY.md). Community expectations live in
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and [GOVERNANCE.md](GOVERNANCE.md);
release history in [CHANGELOG.md](CHANGELOG.md).

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Use, study, change, and share this
software for noncommercial purposes; commercial use requires the author's
permission. Third-party packages keep their own licenses, listed in
[NOTICE](NOTICE).
