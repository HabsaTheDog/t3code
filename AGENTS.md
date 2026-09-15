# Study Buddy T3 Fork

- This is the Study Buddy-owned T3 Code fork. Preserve complete separation from independently installed T3 Code instances.
- Keep changes scoped and merge-friendly; generated Study Buddy artifacts do not belong here.
- Keep `packages/contracts` schema-only and use explicit subpath exports from shared packages.
- Before completion, run `vp check` and `vp run typecheck`; use `vp test` for tests and add `vp run lint:mobile` when changing native mobile code.
