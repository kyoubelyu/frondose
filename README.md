# Frondose

App-only LinkedIn-primary autonomous agent. Frondose uses the Vercel AI SDK, embedded CDP, Chrome stealth, and SQLite memory, delivered through the compiled Tauri app bundle (`Frondose.app`).

> Migration note (2026-05-27): the product contract is now the app. Historical `mai` CLI entrypoints, `dist/cli/main.js`, and package exports are transitional internal/dev/sidecar surfaces scheduled for staged retirement; new product behavior should land in the app.

## Install

Frondose currently installs from GitHub Releases via `install.sh` while the app-native installer/update path is being completed. The package is private and **not** on npm. Requirements: **macOS · Homebrew · the `gh` CLI authenticated with `gh auth login` · Google Chrome**.

`install.sh` is transitional release infrastructure: it provisions the runtime needed by the current app sidecar, downloads the selected Release, builds it, and installs the app assets. The operator-facing product runtime is `Frondose.app`, not the CLI it may still install internally.

```bash
# Latest stable
bash <(gh release download --repo kyoubelyu/frondose --pattern install.sh --output - )
# ...or clone + run:
gh repo clone kyoubelyu/frondose && bash frondose/install.sh

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

1. Install the selected release with `install.sh`.
2. Open `Frondose.app`.
3. Configure the model, API key, identity, and soul context in the app settings.
4. Use the app's Manual, Magical, and Auto modes as the daily runtime.

Do not treat `mai`, `dist/cli/main.js`, or `./dist/index.js` as user-facing product entrypoints. They remain only as temporary implementation and build surfaces while P-APP migration removes or internalizes them.

## Architecture

```
Frondose.app (Tauri)
  ├── app UI: chat, settings, diagnostics, Manual/Magical/Auto controls
  ├── app-owned sidecar protocol (temporary Node/CLI-backed implementation)
  │     └── Vercel AI SDK agent loop (streamText)
  │           └── tiered in-process tools
  │           └── Embedded CDP + Chrome Stealth
  │           └── SQLite memory + JSONL audit + JSON config/secrets
  └── in-page Frondose overlay on LinkedIn via CDP injection
```

## Internal Transitional Surfaces

Some internal/admin commands still exist during the migration, including the app sidecar path, update-server tooling, and historical server/fleet commands. They are not app product UX and should not receive new user-facing features. P-APP-11 removes or internalizes the remaining public CLI/package promises after app-owned replacements are validated.

The historical `mai server` web UI, when used internally, serves plain HTTP on `bind_address` and ships **zero TLS code**. For any exposed internal deployment, front it with a reverse proxy that terminates TLS and forwards both HTTP and WebSocket upgrades to `localhost:8090`:

- **Caddy** — `reverse_proxy localhost:8090` (handles WebSocket upgrades automatically).
- **nginx** — `proxy_pass http://localhost:8090;` plus `proxy_set_header Upgrade $http_upgrade;`
  and `proxy_set_header Connection "upgrade";`.
- **Tailscale** — `tailscale serve 8090`.

The reverse proxy should not log the `Authorization` request header — the web UI's
Basic-Auth credential (`mai server web-token`) rides in it, and credentials do not belong
in access logs.

## License

UNLICENSED — proprietary. © Kyoube. Not for redistribution.
