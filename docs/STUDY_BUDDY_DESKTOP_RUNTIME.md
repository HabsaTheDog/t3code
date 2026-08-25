# Study Buddy desktop runtime contract

Release artifacts are self-contained for the Study Buddy workflow: the canonical
`src/custom-skills/` tree, its locked JavaScript dependencies, and the task
wrapper are staged below the installed application's `study-buddy-runtime/`
resource directory. The desktop backend exports the packaged
`STUDY_BUDDY_ROOT`, task-wrapper path, release version, and Electron-backed Node
shim to agent sessions. A developer checkout or globally installed Study Buddy
skill is not a production dependency.

The canonical `package.json` and `package-lock.json` are staged byte-for-byte.
Release assembly installs them with `npm ci --omit=dev --ignore-scripts`;
`tsx` and its platform-specific optional `esbuild` binary must be production
runtime dependencies. This makes transitive
workflow dependency resolution lockfile-bound and fails closed on package/lock
drift.

The one external dependency required for browser-backed sources is a
Chromium-compatible system browser. Study Buddy resolves, in order, an explicit
`STUDY_BUDDY_BROWSER_EXECUTABLE`, Microsoft Edge, Google Chrome, or Chromium.
Windows 11 normally provides Edge; Fedora users can install Chromium or Chrome.
If no supported executable exists, source checks fail with
`browser-runtime-missing` instead of falling back to a developer Playwright
cache. Bundling Playwright Chromium would add a large duplicate browser and is
therefore not the default distribution model.

Some document capabilities intentionally integrate with separately installed
desktop tools: Typst is required only when generating a PDF, Poppler is required
for complete PDF text/page extraction, and LibreOffice is optional for Office
document conversion. Their absence must be reported as an unavailable
capability with platform-specific remediation; it must not be mistaken for a
missing Study Buddy JavaScript runtime. Offline HTML generation does not depend
on these tools.

Packaged workflow commands use a standalone cross-platform JavaScript adapter
executed by Electron in Node mode. Windows does not require Git Bash, WSL, a
system Node installation, or a developer checkout. Linux uses a minimal POSIX
launcher to enter the same adapter; the workflow implementation and process
management remain platform-neutral. Electron-backed `node` and restricted
`npm run` command shims are included for both platforms.

Production builds fail closed unless all of these are explicit:

- semantic build version;
- canonical workflow root;
- Study Buddy GitHub updater repository and matching `latest`, `alpha`, `beta`,
  or `nightly` channel;
- public PostHog project token (`phc_...`).

PostHog personal/admin API keys are removed from child build environments and
the compiled release code is rejected if a `phx_...` token is detected. Every
successful build emits `study-buddy-desktop.cdx.json`, a deterministic
CycloneDX SBOM for staged JavaScript packages and bundled Study Buddy runtime
components.
