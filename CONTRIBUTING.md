# Contributing to the Study Buddy interface

Contributions are welcome, especially focused bug fixes, reliability and
accessibility improvements, tests, documentation, and security hardening.

Use the main [Study Buddy issue tracker](https://github.com/HabsaTheDog/StudyBuddy/issues)
for proposals and user-facing bugs. Open an issue before substantial UI,
architecture, authentication, privacy, permission, network, or release changes.
Security vulnerabilities must be reported privately as described in
[SECURITY.md](SECURITY.md).

## Pull requests

Keep each change reviewable and include:

- a linked issue or concise problem statement;
- tests for changed behavior;
- commands run and their results;
- a security, privacy, and data-flow assessment;
- before/after screenshots for visual changes and a short recording for motion;
- provenance and compatible licensing for new assets or dependencies.

Do not commit credentials, cookies, storage state, private URLs, authenticated
captures, student records, real course material, or generated user artifacts.
Use synthetic fixtures and reserved example domains.

## Local gates

```bash
corepack enable
corepack prepare pnpm@10.24.0 --activate
pnpm install --frozen-lockfile
pnpm exec vp check
pnpm exec vp run typecheck
pnpm exec vp run test
node scripts/study-buddy-audit.ts
```

Desktop behavior must also be checked in the real Electron shell with
`pnpm study-buddy:app`. Changes are merged here first; the resulting public
commit is then pinned and tested by the parent repository.

Contributions are accepted under the repository's MIT License (inbound equals
outbound) and must follow the main project's
[Code of Conduct](https://github.com/HabsaTheDog/StudyBuddy/blob/master/CODE_OF_CONDUCT.md).
