# Study Buddy interface

This repository contains the Study Buddy-owned interface and desktop shell. It
is based on the MIT-licensed [T3 Code](https://github.com/pingdotgg/t3code) and
is maintained as a pinned submodule of the main
[Study Buddy repository](https://github.com/HabsaTheDog/StudyBuddy).

> **Alpha status:** use the main Study Buddy repository for installation,
> releases, issues, security reports, and project documentation. Upstream T3
> Code packages and release links do not install Study Buddy.

## What lives here

- the Electron desktop application for Linux and Windows;
- the local React interface and server process;
- desktop update checks backed by Study Buddy GitHub Releases;
- Study Buddy source, permission, privacy, and workflow integrations;
- the retained upstream coding-agent runtime used by the application.

Study Buddy keeps its application ID, local state, protocol handlers, launchers,
and release artifacts separate from upstream T3 Code.

## Development

Clone the parent repository recursively so it supplies the reviewed root
pipeline and exact interface revision:

```bash
git clone --recurse-submodules https://github.com/HabsaTheDog/StudyBuddy.git
cd StudyBuddy/t3code-fork
corepack enable
corepack prepare pnpm@10.24.0 --activate
pnpm install --frozen-lockfile
pnpm study-buddy:ports
pnpm study-buddy:dev
```

Run the desktop shell with:

```bash
pnpm study-buddy:app
```

Before opening a pull request, run:

```bash
pnpm exec vp check
pnpm exec vp run typecheck
pnpm exec vp run test
node scripts/study-buddy-audit.ts
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for scope and review requirements. The
main project documentation covers [security](https://github.com/HabsaTheDog/StudyBuddy/blob/master/SECURITY.md),
[privacy](https://github.com/HabsaTheDog/StudyBuddy/blob/master/PRIVACY.md), and
[release operations](https://github.com/HabsaTheDog/StudyBuddy/blob/master/docs/releasing.md).

## Releases and updates

The parent repository is the only release authority. Stable users follow full
GitHub releases; Alpha, Beta, and Nightly tracks are explicit opt-ins. Update
metadata and installers are produced together, checksummed, and published from
the same release. macOS packaging is currently deferred.

## License and attribution

The code in this repository remains available under the [MIT License](LICENSE).
The original T3 Code copyright and license are preserved. Study Buddy-specific
changes are maintained by Alvaro Schroll and contributors; see [NOTICE.md](NOTICE.md).
