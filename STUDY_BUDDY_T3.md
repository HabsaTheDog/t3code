# Study Buddy T3 Code Fork

This fork is configured to coexist with an installed T3 Code app.

## Provenance and Licensing

This directory is a modified fork of T3 Code from
`https://github.com/pingdotgg/t3code.git`.

T3 Code is copyright (c) 2026 T3 Tools Inc. and licensed under the MIT
License. Keep `LICENSE` intact when copying, publishing, or redistributing this
fork. Study Buddy-specific changes are tracked in this fork and should remain
small, documented, and easy to rebase onto upstream.

The parent Study Buddy 2.0 repository has its own top-level MIT license and a
`THIRD_PARTY_NOTICES.md` file that records this fork as third-party code.

## Secrets and Local Configuration

Do not commit credentials, tokens, session cookies, Moodle/CIS secrets, API
keys, or local machine paths that are not meant to be shared. Keep real values
in `.env` or `.env.local`; commit only placeholder values in `.env.example`.

The fork's `.gitignore` ignores `.env*` while explicitly allowing
`.env.example`, so local credentials should remain untracked.

## Upstream Tracking

The parent repository records this directory as a Git submodule path. The
current `.gitmodules` entry points at the public upstream repository so a fresh
clone can resolve the source project.

For long-term maintenance, create a personal or organization fork on GitHub,
push this modified `t3code-fork` history there, then update the parent
repository's `.gitmodules` URL to that fork. A useful remote layout is:

```bash
git remote rename origin upstream
git remote add origin git@github.com:<owner>/<study-buddy-t3code-fork>.git
```

After that, push Study Buddy-specific commits to `origin` and pull future T3
updates from `upstream`.

## Identity

- Browser title: `Study Buddy T3 Code`
- Desktop dev app name: `Study Buddy T3 Code (Dev)`
- T3 local data directory: `../output/t3-study-buddy-t3-home/`
- Quick Chat workspace directory: `../output/t3-study-buddy-t3-home/quick-chats/`
- User project/workspace directory: selected explicitly in T3 Code
- Moodle artifact directory: `<selected-workspace>/output/<request-name>/<timestamp>/`

The Study Buddy scripts no longer bootstrap a default project. Regular projects
must be selected explicitly by the user in T3 Code. Quick Chats create
request-local workspaces below the separate T3 local data directory.

Codex runtime sessions receive `STUDY_BUDDY_WORKSPACE` from the selected regular
project or Quick Chat workspace. Direct `bun run moodle:agent` calls require an
explicit `STUDY_BUDDY_WORKSPACE` or `T3CODE_CWD`; the runner does not provide a
default artifact workspace.

## Ports

The dedicated scripts use `T3CODE_PORT_OFFSET=120`.

- Web UI: `http://localhost:5853`
- Server: `http://localhost:13893`
- WebSocket: `ws://localhost:13893`

## Commands

```bash
cd "/home/alvaroschroll/Dokumente/Development/Study Buddy 2.0/t3code-fork"

bun run study-buddy:ports
bun run study-buddy:dev
bun run study-buddy:dev:no-browser
bun run study-buddy:app
```

`study-buddy:dev` runs the browser-based fork. `study-buddy:app` runs the Electron desktop dev app. Both use separate ports and separate local state from the installed T3 Code app.

The Moodle skill can be tested directly with:

```bash
STUDY_BUDDY_WORKSPACE="/path/to/user/project" bun run moodle:agent -- "Erstelle eine DYN2 Formelsammlung als Typst-Dokument." --url "https://moodle.technikum-wien.at/course/view.php?id=32320" --out output/dyn2.typ
```

Set `STUDY_BUDDY_WORKSPACE` or `T3CODE_CWD` for direct CLI tests. Prefer
omitting `--out` unless you need a specific file name. Without `--out`, the
runner creates a timestamped run directory below the active artifact directory.

Add CIS pages when Moodle does not contain the needed timetable, exam, or administrative information:

```bash
STUDY_BUDDY_WORKSPACE="/path/to/user/project" bun run moodle:agent -- "Erstelle eine Übersicht über relevante Termine und Lernprioritäten." --url "https://moodle.technikum-wien.at/my/" --cis-url "https://cis.technikum-wien.at/cis.php/"
```
