# mai-agent

Single-binary LinkedIn autonomous agent. Vercel AI SDK + embedded CDP + Chrome stealth + SQLite memory. One CLI: `mai`.

## Install

Frondose installs from GitHub Releases via `install.sh` (the package is private —
**not** on npm). Requirements: **macOS · Homebrew · the `gh` CLI (authenticated:
`gh auth login`) · Google Chrome**. `install.sh` provisions Node 20 + Chrome via
Homebrew, downloads the latest Release, builds it, and links `mai` onto your PATH.

```bash
# Latest stable
bash <(gh release download --repo kyoubelyu/mai-agent --pattern install.sh --output - )
# ...or clone + run:
gh repo clone kyoubelyu/mai-agent && bash mai-agent/install.sh

# Latest Frondose alpha (v0.5 prerelease line):
bash install.sh --prerelease

# A specific release:
bash install.sh --version v0.5.0-alpha.26
```

### Opening the unsigned Frondose app (Gatekeeper)

The `.app`/`.dmg` is **unsigned** (signing/notarization arrive in a later release).
Installs via `install.sh` / `gh` are **not quarantined** and launch normally. If you
download the `.app` or `.dmg` with a **browser**, macOS quarantines it; on Sequoia
(15.x) the old right-click -> Open is gone — instead:

- **System Settings -> Privacy & Security ->** scroll to Security -> **"Open Anyway"** -> authenticate. One-time per app. **or**
- Terminal: `xattr -cr /Applications/Frondose.app` (or `xattr -dr com.apple.quarantine /Applications/Frondose.app`), then open normally.

## Quick start

```bash
# Set your LLM provider
mai auth set

# Initialize agent identity (interactive)
mai identity init

# Launch the agent REPL
mai
```

In the REPL, type a goal and the agent operates LinkedIn through Chrome to achieve it.

## Configuration

```bash
mai auth set              # LLM provider credentials (Anthropic / OpenAI / DeepSeek)
mai identity init         # Agent name, role, company, ICP
mai soul show             # View the agent's system prompt
mai telegram on           # Enable Telegram notifications
mai telegram bind         # Link your Telegram account
mai cron schedule "..." --cron "0 9 * * *"  # Schedule recurring tasks
mai gh set                # GitHub credentials for issue reporting
mai search set            # Web search API keys
```

## Subcommands

```
mai auth          LLM provider credentials
mai identity      Agent identity management
mai soul          System prompt view/edit
mai sessions      Agent session management
mai telegram      Telegram notification channel
mai cron          Scheduled task management
mai gh            GitHub integration
mai search        Web search integration
mai status        Agent runtime status
mai version       Print version
```

## REPL slash commands

```
/help             Show available commands
/compact          Compact conversation context
/new              Start a new session
/cron schedule    Schedule a recurring task
/cron list        List scheduled tasks
/cron remove      Remove a scheduled task
/telegram on      Enable Telegram channel
/telegram off     Disable Telegram channel
/telegram status  Show Telegram channel state
```

## Architecture

```
mai (CLI/REPL)
  └── Vercel AI SDK agent loop (streamText)
        └── 24 in-process tools
              ├── 10 LinkedIn primitives (launch, inspect, click, type, ...)
              ├── 4 memory/identity (remember, getMemory, identity, getIdentity)
              ├── 1 methodology (qualify_profile)
              ├── 2 operator output (telegram_notify, gh_issue)
              ├── 4 web (webSearch, webFetch, analyze_screenshot, upload)
              └── 3 control (stop, sleep, escalate_for_capability)
        └── Embedded CDP + Chrome Stealth
        └── SQLite memory + JSONL audit + JSON identity
```

## Server deployment (`mai server`)

`mai server` serves its management web UI (fleet dashboard, provision form, per-worker
SSH terminal + VNC viewer) as plain HTTP on `bind_address` (default port 8090). It ships
**zero TLS code**. For public exposure, front it with a reverse proxy that terminates TLS
and forwards both HTTP and WebSocket upgrades to `localhost:8090`:

- **Caddy** — `reverse_proxy localhost:8090` (handles WebSocket upgrades automatically).
- **nginx** — `proxy_pass http://localhost:8090;` plus `proxy_set_header Upgrade $http_upgrade;`
  and `proxy_set_header Connection "upgrade";`.
- **Tailscale** — `tailscale serve 8090`.

The reverse proxy should not log the `Authorization` request header — the web UI's
Basic-Auth credential (`mai server web-token`) rides in it, and credentials do not belong
in access logs.

## License

UNLICENSED — proprietary. © Kyoube. Not for redistribution.
