# Frondose

Frondose is an app-only, LinkedIn-primary autonomous sales agent delivered as a
Tauri desktop application (`Frondose.app` / `Frondose.exe`). It drives a real
Chrome browser through an in-process CDP layer, uses the Vercel AI SDK for its
agent loop, and keeps memory in SQLite — with an approval-gated safety model
(Manual / Magical / Auto modes).

- **Bring your own LLM.** Frondose speaks to exactly one custom
  OpenAI-compatible endpoint (e.g. a DeepSeek-style custom URL). No official
  vendor SDK or direct Anthropic/OpenAI call exists in the runtime.
- **Real browser, real pages.** An embedded CDP + Chrome stealth layer drives
  your own Chrome profile against your own account. Browser tools work on any
  HTTPS page.
- **Fail-closed tool layer.** The agent tool surface performs no shell
  execution and no arbitrary file I/O; every external capability is explicitly
  allowlisted.
- **Local data.** Identity, memory, audit trail, and configuration live in
  your own user directory (`~/.frondose`), never in a cloud.

## Install

Download the latest installer from
[GitHub Releases](https://github.com/kyoubelyu/frondose/releases/latest):

- macOS: `Frondose-universal.dmg`
- Windows: `Frondose-windows-x86_64-setup.exe`

The app updates itself through the built-in updater, signed with the Tauri
updater's minisign key. macOS binaries are ad-hoc codesigned; on first launch,
Gatekeeper or SmartScreen may ask you to allow the app explicitly
(System Settings → Privacy & Security → Open Anyway, or `xattr -cr` on the
downloaded bundle).

## Configuration

On first launch, configure in the app's Settings:

1. The custom LLM provider URL, model, and API key (BYOK).
2. Your identity and soul context (the agent's sales worldview).
3. Optional extras: Brave Search API key (web search), Telegram channel
   (`telegram_notify`), and GitHub issue output (`gh_issue`).

Unconfigured capabilities degrade gracefully — web search returns
`missing_config`, output tools stay silent — and never block the core agent.

## Usage modes

- **Manual** — you approve every outbound action.
- **Magical** — read-only observation with durable local state, no outbound.
- **Auto** — bounded autonomous runs with per-run outbound approval gates and
  a persisted ledger of every action.

## Building from source

Requirements: Node ≥ 20, Rust toolchain, Tauri v2 prerequisites
(https://tauri.app), and the pinned npm dependencies.

```bash
npm ci
npm run check          # typecheck
npm run lint           # biome
npm run test:fast      # mock test suite
npm run build:tauri    # compile TS + Tauri UI assets
cd src/tauri && npx tauri build
```

The native hardware-input addon (`native/`) is optional; the build falls back
to CDP-only input when the toolchain is unavailable.

## Repository layout

```
src/                    app-owned backend + agent/tools/persistence (TypeScript)
src/tauri/src-tauri/    Tauri backend (Rust)
src/tauri/ui/           app UI (React/TS)
projects/web/           public landing/download site (standalone static page)
scripts/                build, test, and public-release verification tooling
tests/                  mock/contract test suites (BDD-light)
native/                 optional hardware-input native addon (C source)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Tool names and parameter schemas are
product contract; security boundaries (no shell at the tool layer, allowlisted
capabilities) are non-negotiable. Report vulnerabilities privately per
[SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
