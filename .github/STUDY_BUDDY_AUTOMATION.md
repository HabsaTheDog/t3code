# Study Buddy fork automation

This repository is the pinned Study Buddy interface fork of T3 Code. Pull
requests, security reports, release coordination, and contributor intake are
managed in the parent Study Buddy repository.

The inherited T3 Code release, relay deployment, mobile preview, label, and PR
vouch workflows are intentionally inert. They target upstream infrastructure
and must not be re-enabled in this fork. Fork CI uses GitHub-hosted runners and
the secret scan covers the fork's complete reachable history. The default pnpm
workspace and frozen lockfile contain only shipped Study Buddy packages; the
disabled upstream mobile, marketing, and relay directories are not installed.
The `study-buddy:audit` gate blocks every high/critical advisory in that shipped
dependency graph without exceptions.

A future desktop release must use a dedicated Study Buddy workflow, app
identity, artifact names, update endpoint, signing credentials, release notes,
checksums, and SBOM. It must not publish an upstream T3 Code artifact.
