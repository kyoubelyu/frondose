# mai-agent

Single-binary LinkedIn autonomous agent. Vercel AI SDK + embedded CDP + Chrome stealth + SQLite memory. One CLI: `mai`.

## Install

```bash
npm install -g @kyoube/mai-agent
```

Requirements: Node >= 20, macOS with Chrome installed.

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

## License

MIT
