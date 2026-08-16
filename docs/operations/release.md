# Study Buddy interface releases

The parent [Study Buddy repository](https://github.com/HabsaTheDog/StudyBuddy)
is the only release authority. The inherited upstream T3 Code release workflow
is disabled for this fork and must not publish Study Buddy artifacts, packages,
hosted applications, mobile builds, or relay infrastructure.

## Source freeze

1. Merge and publish the reviewed interface commit in this repository.
2. Pin that exact public commit in the parent repository.
3. Verify a fresh recursive parent clone resolves the commit.
4. Run the parent release gates and build from that clean checkout.

Do not publish from an uncommitted working tree or install artifacts into an
upstream T3 Code application/state path.

## Desktop update contract

- Provider: public GitHub Releases in `HabsaTheDog/StudyBuddy`.
- Platforms: Linux x64 AppImage and Windows x64 NSIS; macOS is deferred.
- Tracks: Stable (`latest`) by default, with Alpha, Beta, and Nightly opt-in.
- Checks: shortly after startup, every six hours, and manually from Settings.
- Consent: updates are announced first; download and restart/install are always
  initiated by the user and are never forced.
- Integrity: installers and their electron-builder YAML metadata are published
  together. The metadata SHA-512 is verified by `electron-updater`; the parent
  release also publishes `SHA256SUMS`, an SBOM, and immutable commit metadata.

Required release assets include the installer/AppImage, channel YAML files
(`latest*.yml`, `alpha*.yml`, `beta*.yml`, or `nightly*.yml`), and available
`*.blockmap` files. The project website and in-app updater consume the same
GitHub Release assets.

`STUDY_BUDDY_DESKTOP_UPDATE_REPOSITORY=owner/repo` may override the build-time
feed for controlled testing. `STUDY_BUDDY_DISABLE_AUTO_UPDATE=true` disables
runtime update checks. Legacy `T3CODE_*` update variables remain accepted only
for migration and local upstream compatibility.

## Signing boundary

Unsigned Linux and Windows artifacts may be produced for internal alpha review.
Windows release publication remains blocked until the reviewed SignPath
Foundation integration signs the exact assembled artifact. Apple signing and
notarization are outside the current product scope.

For the complete tag, approval, checksumming, SBOM, and draft-publication
procedure, follow the parent
[release guide](https://github.com/HabsaTheDog/StudyBuddy/blob/master/docs/releasing.md).
