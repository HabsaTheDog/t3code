# AGENTS.md

## Study Buddy Fork Boundary

- This repository is the Study Buddy-owned fork of T3 Code, not the upstream T3 Code installation.
- Keep fork changes, build outputs, launchers, URL schemes, app IDs, desktop entries, user-data directories, and backend state separate from upstream T3 Code.
- Upstream T3 Code lives outside this repo and should not be modified here. Do not copy Study Buddy artifacts into `~/Applications/t3code`, do not use `T3-Code-*` artifact names for Study Buddy builds, and do not default Study Buddy runtime state to `~/.t3` or Electron user data to `~/.config/t3code`.

## Task Completion Requirements

- `vp check` and `vp run typecheck` must pass before considering tasks completed.
  - If changing native mobile code, `vp run lint:mobile` must also pass.
- Use `vp test` for the built-in Vite+ test command and `vp run test` when you specifically need the `test` package script.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## External Reference Repositories

External repositories are not vendored into this project. Use the installed dependency source or the
official upstream repository when implementation details are needed. Optional local clones belong under
the ignored `.repos/` directory and must never be imported by application code or committed.

- Effect: https://github.com/Effect-TS/effect-smol
- Alchemy: https://github.com/alchemy-run/alchemy-effect
