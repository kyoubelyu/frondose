# Contributing to Frondose

Thank you for contributing. Frondose is an autonomous web-automation desktop
agent. Its agent tool layer is intentionally minimal and fail-closed: the
runtime never shells out, and every external capability is explicitly
allowlisted.

## Ground rules

- **No arbitrary shell execution at the agent tool layer.** Tools call
  approved primitives (CDP browser control, persistence, operator-output
  surfaces) only.
- **Tool names and parameter schemas are contract.** Renaming or tightening a
  tool's schema requires a major version bump.
- **Credentials never enter the repository.** Treat any leaked credential as
  an incident: rotate it and report it.
- Keep files under 800 lines, match existing style, and ship tests with every
  behavior change.

## Development flow

1. Open an issue describing the problem and the expected behavior.
2. Branch from `main`, keep changes surgical.
3. Run `npm run check`, `npm run lint`, `npm run build:tauri`, and
   `npm run test:fast` before submitting (`test:fast` expects the built
   `dist/` tree).
4. Open a pull request; maintainers review and merge.

## Security

See `SECURITY.md` for vulnerability reporting.
