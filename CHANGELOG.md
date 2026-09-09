# Changelog

All notable changes to Frondose.

> **Reading this file:** Frondose v0.5.x ships as a Tauri desktop application
> (`Frondose.app` / `Frondose.exe`). Entries below v0.5.0 describe the
> predecessor CLI product **mai-agent** (the `mai` command, config under
> `~/.mai`); those commands and paths are historical and do not exist in the
> desktop app.

## v0.5.x — Frondose desktop era (summary)

The 0.5 series rebuilt the product as a desktop app around the same agent
core (BYOK single OpenAI-compatible endpoint, CDP-driven real Chrome,
SQLite local-first storage, Manual / Magical / Auto approval modes).
Highlights across the series:

- Tauri desktop shell with a bundled Node sidecar backend, tray, and
  bilingual (en/zh) Settings UI.
- Windows builds alongside macOS; self-updates through the Tauri updater
  channel (ad-hoc codesign + minisign), installers published as GitHub
  Releases.
- Direct Brave Search API integration for `web_search` with in-app key
  management, 3-second request pacing, and graceful `missing_config`
  degradation when unconfigured.
- Telegram channel, cron/passive scheduling, and workflow approval gates
  on top of the sidecar backend.
- Local data lives under `~/.frondose`.
- Per-release details: see the git history and each GitHub Release.

## v0.4.15 (2026-05-14)

- `mai update` CLI subcommand — checks GitHub Releases API for newer mai-agent versions
- Token reuse: reads `GH_TOKEN` from `~/.mai/agent/github.json` with env-var fallback
- `--json` flag for machine-readable output (scripting)
- Error classification: `unauthorized` / `not_found` / `network` / `no_token`
- `compareVersions()` handles v-prefix, multi-digit minor, cross-major, local-ahead-of-latest

## v0.4.14 (2026-05-13)

- Background cron ticker — `setInterval` 60s poll with `unref()` for autonomous scheduling
- Local-time cron matching — `matches()` switched from UTC to local getters
- `[TIME]` human-readable header in cron prompts
- Soul band daily workflow rhythm (Morning / Midday / Afternoon / Evening)

## v0.4.13 (2026-05-13)

- Atomic identity writes via tmp + `renameSync`
- Crash logger with uncaughtException / unhandledRejection / SIGABRT handlers
- CDP heartbeat interval

## v0.4.12 (2026-05-13)

- System prompt English localization (Soul band + methodology distillation)
- Mission directive in Soul band Section 6
- Test fixture hardening

## v0.4.11 (2026-05-13)

- Scenario-driven mock tests with `FakeLinkedInWorld` deterministic state machine
- Search + Feed dual-flow tests with real LLM
- 9 page presets, 8 gates, 11/11 tests

## v0.4.10 (2026-05-13)

- Live test framework — recheck mai-linkedin atomic capabilities
- 4 tool gap fixes: upload scope dispatch, preflight, 50MB ceiling, type enforcement, inspect `--full`, screenshot pageUrl
- 3 scenario live smokes (feed, post, messaging)

## v0.4.9 (2026-05-13)

Live test framework design + LinkedIn tool gap fixes. (Tagged as part of P-14.)

## v0.4.8 (2026-05-12)

- Interactive CLI subcommands via `@inquirer/prompts`
- Dual-mode: positional args (script-friendly) + interactive prompts when args missing + TTY
- New `mai setup` wizard — chains auth → identity → telegram → soul
- Interactive: `mai auth set/remove/default`, `mai sessions continue`, `mai cron remove`, `mai telegram bind`

## v0.4.7 (2026-05-12)

- Telegram session file reference fix for `/new` rotation
- CHECKPOINT band 4th Telegram subsection + budget 1500→1800
- `[telegram]` visibility lines in REPL stdout
- `PollerHandle.lastReceivedAt` persisted to telegram.json
- ASCII `[TG]` indicator in StatusLine

## v0.4.6 (2026-05-11)

- `boundChatId` → `boundUserId` rename in telegram.json schema
- DM-only inbound authorization
- HELP_TEXT alignment and Workflow YAML hardening

## v0.4.5 (2026-05-11)

- Bidirectional Telegram channel — in-process background long-poll
- Agent-turn semaphore, `/telegram on|off|status` REPL slash
- Telegram Bot API media surface (photo/document/audio/video/album)
- undici-based fallback transport with DoH self-discovery, sticky-IP cache, `TELEGRAM_PROXY` env
- CLI subcommands: `mai telegram on|off|status|test|bind`, `mai status`, `mai cron list|remove`
- Technical debt: fixed hung-test LLM calls, biome warnings, removed `MAI_NO_CHROME`

## v0.4.4 (2026-05-10)

- `/cron schedule` REPL slash command with 5-field cron expressions
- Schedule persistence to `~/.mai/agent/schedule.jsonl`
- Boot drain + after-turn poll execution
- Checkpoint band fill (memory discipline, within-cron idempotency, cross-cron resume)
- First phase under outside-in TDD

## v0.4.3 (2026-05-10)

- Tool error recovery / retry-with-context
- Hook system (PreToolUse / PostToolUse / Stop events, `~/.mai/agent/hooks.json`)
- `WebFetch`, `WebSearch`, `analyze_screenshot` tools
- File sandbox tightening
- Boundary band fill (universal no-bash, injection defense, capability escalation contract)

## v0.4.2 (2026-05-10)

- `/compact`, `/new`, `/help` slash commands
- Streaming markdown renderer (code blocks, tables, bold, italic, headers, lists, CJK-safe)
- Status line (ANSI cursor save/restore, color-graded progress bar, SIGWINCH handler)
- Multi-line backslash continuation
- Auto-compaction at 75% threshold

## v0.4.1 (2026-05-09)

- DeepSeek v4-flash thinking-mode disable — injected `thinking: { type: "disabled" }` via modelResolver

## v0.4.0 (2026-05-09)

- Methodology + Soul band — ICP injection, `qualify_profile` tool, identity sentence + methodology distillation
- Operator-output tools — `telegram_notify`, `gh_issue`
- Control tools — `stop`, `sleep`, `escalate_for_capability`
- Audit JSONL writer via `onStepFinish` callback
- CLI subcommands — `mai auth`, `mai identity init/show`, `mai sessions`, `mai version`, `mai soul`
- LLM-led identity bootstrap flow

## v0.3.1 (2026-05-08)

- Lazy Chrome boot on first LinkedIn-tool invocation
- `waitForPageTarget` poll (10×300ms) + `CDP.New` fallback for race resolution

## v0.3.0 (2026-05-08)

- Initial release — LinkedIn-bundled single binary
- Vercel AI SDK agent loop with `streamText`
- Embedded CDP layer with 5-patch stealth init
- 10 LinkedIn primitives: launch, inspect, click, type, press, upload, close, reload, scroll, screenshot
- Memory + Identity: `remember`, `getMemory`, `identity`, `getIdentity` via better-sqlite3
- 3-band system prompt: Boundary + Soul + Checkpoint
- `bin: mai` REPL with readline interface
