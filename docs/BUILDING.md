# Building EditAWr

EditAWr is packaged with [electron-builder](https://www.electron.build/). The
same source builds for Windows, macOS and Linux, but native dependencies and
OS signing rules mean each installer should be built on its target OS.

## Target matrix

| Target | Architecture | Output | Build host |
|---|---|---|---|
| Windows | x64 | NSIS installer + portable `.exe` | Windows |
| Windows | arm64 | NSIS installer + portable `.exe` | Windows arm64 |
| macOS | x64 or arm64 | Local `.app` / optional `.dmg` | macOS of the same architecture (no CI artifact) |
| Linux | x64 or arm64 | `.AppImage` + `.deb` | Linux of the same architecture |

CI publishes **Windows and Linux** artifacts. macOS is built locally from
source with `install.sh` or the electron-builder commands below; there are no
prebuilt macOS releases.

`macOS` packages **must** be produced on macOS: DMG creation, code signing and
notarization need Apple tooling. Do not try to build a macOS DMG on Windows or
Linux.

Cross-building Windows installers on Linux is possible with Wine, and some
Linux targets can be produced in containers, but neither is recommended here
because `sharp` embeds a host-specific native binary. The CI workflow builds
Windows and Linux on their native runners.

## Prerequisites

### All platforms

- Node.js **22.12 or newer** (see `engines` in `package.json`)
- npm
- Git

### Windows

- Windows 10 or 11, x64 (or an arm64 runner for arm64 builds)
- No Visual Studio install is required: `sharp` uses prebuilt binaries
- NSIS is downloaded automatically by electron-builder

### macOS

- macOS with Xcode Command Line Tools:
  ```bash
  xcode-select --install
  ```
- Build on the architecture you are targeting. An Intel Mac builds x64; an
  Apple Silicon Mac builds arm64 by default.

### Linux

A Debian/Ubuntu-style host is easiest for `.deb`; AppImage tools are downloaded
by electron-builder. Typical dependencies:

```bash
sudo apt-get update
sudo apt-get install -y \
  libgtk-3-0 libnss3 libasound2 libxss1 libxtst6 \
  fakeroot dpkg rpm
```

`rpm` is only needed if you add an RPM target. Running an AppImage may require
FUSE 2 on some distributions; see Troubleshooting.

## Install dependencies

```bash
npm ci
```

`npm ci` runs the `postinstall` hook, which is `node scripts/vendor.js`. That
script copies the LibRaw WASM files into `src/renderer/vendor/libraw`.

Do **not** use `npm ci --omit=optional`: `sharp` installs its native binary
through optional `@img/sharp-*` packages.

## Build commands

```bash
# Unpacked app for the current OS, useful for smoke testing
npm run pack

# Installers for the current OS, using the targets in electron-builder.yml
npm run dist
```

To select a target explicitly, run the vendor step first and then
electron-builder:

```bash
node scripts/vendor.js

# Windows
npx electron-builder --win --x64 --publish never
npx electron-builder --win --arm64 --publish never

# macOS (run on a Mac of the target architecture)
npx electron-builder --mac --x64 --publish never
npx electron-builder --mac --arm64 --publish never
npx electron-builder --mac --universal --publish never

# Linux
npx electron-builder --linux --x64 --publish never
npx electron-builder --linux --arm64 --publish never
```

`--publish never` prevents an accidental upload if a `publish` configuration is
added later.

Running an `--arm64` command on an x64 machine packages the arm64 Electron
binary, but `sharp` will still be the x64 native module installed by `npm ci`.
Build arm64 packages on an arm64 runner (or install the matching
`@img/sharp-*` package explicitly).

Artifacts are written to `dist/`.

### Unpacked output locations

| Platform | Path |
|---|---|
| Windows | `dist/win-unpacked/EditAWr.exe` |
| macOS | `dist/mac*/EditAWr.app` |
| Linux | `dist/linux-unpacked/editawr` |

### Artifact names

Windows has two targets, so they intentionally have different names:

- `EditAWr-<version>-setup-x64.exe` — NSIS installer
- `EditAWr-<version>-portable-x64.exe` — portable executable

macOS:

- `EditAWr-<version>-arm64.dmg`
- `EditAWr-<version>-x64.dmg`

Linux uses the Debian/AppImage architecture names for `${arch}`:

- `EditAWr-<version>-x86_64.AppImage`
- `EditAWr-<version>-amd64.deb`

If you change `artifactName`, keep the Windows names distinct. A single name for
both Windows targets makes one overwrite the other.

## Native dependencies

### sharp

`sharp` ships native binaries through optional packages such as:

```text
@img/sharp-win32-x64
@img/sharp-darwin-arm64
@img/sharp-linux-x64
```

The correct package is installed by `npm ci` on the target OS/architecture.
This is why the recommended path is to build on the target platform.

`electron-builder.yml` already unpacks sharp's native files:

```yaml
asarUnpack:
  - node_modules/sharp/**/*
  - node_modules/@img/**/*
```

Verify after packaging:

```bash
# Windows
ls dist/win-unpacked/resources/app.asar.unpacked/node_modules/@img

# macOS
ls "dist/mac-arm64/EditAWr.app/Contents/Resources/app.asar.unpacked/node_modules/@img"

# Linux
ls dist/linux-unpacked/resources/app.asar.unpacked/node_modules/@img
```

### LibRaw WASM

`scripts/vendor.js` copies the `libraw-wasm` runtime into
`src/renderer/vendor/libraw`. That directory is gitignored and must be
regenerated before packaging. `npm run pack` and `npm run dist` already run the
vendor step; the CI workflow also runs it explicitly.

The WASM payload is platform-independent, so the same files work on every OS.
Check that it made it into the package:

```bash
npx @electron/asar list dist/win-unpacked/resources/app.asar | grep vendor/libraw
```

## Icons and build resources

`electron-builder.yml` points at `build/`:

```yaml
directories:
  buildResources: build
```

Add these files before producing a release:

```text
build/icon.ico    Windows, 256x256
build/icon.icns   macOS, 1024x1024 source
build/icon.png    Linux, 512x512 or 1024x1024
```

Without them, electron-builder falls back to the default Electron icon.
Optional Windows installer art: `build/installerIcon.ico` and
`build/installerHeaderIcon.ico`.

## Code signing

CI builds **unsigned Windows and Linux** packages by default. Release builds should
be signed.

### Windows

Set:

```bash
CSC_LINK=/path/to/certificate.pfx
CSC_KEY_PASSWORD=certificate-password
```

`WIN_CSC_LINK` / `WIN_CSC_KEY_PASSWORD` are the Windows-specific aliases.
electron-builder signs the app and NSIS installer with `signtool`.

Notes:

- Unsigned installers work but trigger SmartScreen warnings.
- EV certificates are often hardware-token based and cannot be exported as a
  PFX. Use a cloud-signing service or sign on a machine with the token.
- For Microsoft Trusted Signing / Azure, configure electron-builder's
  `signtoolOptions` rather than a PFX.

### macOS

Sign with a Developer ID Application certificate. You can install it in the
login keychain or pass it to electron-builder:

```bash
CSC_LINK=/path/to/DeveloperID.p12
CSC_KEY_PASSWORD=...
```

For notarization, set either the Apple ID or App Store Connect API key
credentials:

```bash
APPLE_ID=you@example.com
APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
APPLE_TEAM_ID=XXXXXXXXXX
```

or:

```bash
APPLE_API_KEY=/path/to/AuthKey_XXXXXXXXXX.p8
APPLE_API_KEY_ID=XXXXXXXXXX
APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Enable hardened runtime and notarization in `electron-builder.yml` for release
builds, for example:

```yaml
mac:
  hardenedRuntime: true
  gatekeeperAssess: false
  notarize: true
```

If Electron or a native module needs additional entitlements, add an
entitlements plist and reference it with `mac.entitlements` /
`mac.entitlementsInherit`. Keep the entitlements minimal; add
`com.apple.security.cs.disable-library-validation` only if a native module
actually requires it.

For a local unsigned test build:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64
```

Unsigned macOS apps need a right-click **Open** on first launch, or:

```bash
xattr -dr com.apple.quarantine /Applications/EditAWr.app
```

### Universal macOS builds

`--mac --universal` merges x64 and arm64. `sharp` contains architecture-specific
native binaries, so test the universal app on both architectures. Building two
separate DMGs — one on an Intel runner and one on Apple Silicon — is usually
more reliable.

### Linux

AppImage and deb do not require code signing. Users may need:

```bash
chmod +x EditAWr-*.AppImage
./EditAWr-*.AppImage
```

or:

```bash
sudo dpkg -i EditAWr-*.deb
sudo apt-get -f install
```

## GitHub Actions

`.github/workflows/ci.yml` contains three jobs:

1. **Unit tests** — Ubuntu and Windows, on every push to `main`, every PR,
   and every release tag.
2. **Package** — Windows x64 and Linux x64, after the unit tests pass.
   Packaging runs only for `v*` tags and manual workflow runs. Pushes to
   `main` and pull requests run the unit tests only.

The package job:

- runs `npm ci` on the native runner so `sharp` gets the right binary
- runs `node scripts/vendor.js`
- runs electron-builder with `--publish never`
- uploads the installer(s) as a workflow artifact for 14 days

Trigger a packaging run:

1. Open **Actions → CI → Run workflow** on the branch you want to build.
2. Or push a version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

Main pushes and pull requests intentionally skip packaging to save runner
minutes.

Download the result from the workflow run's **Artifacts** section:
`editawr-windows-x64` and `editawr-linux-x64`.

### GitHub Releases

For a `v*` tag, the `release` job runs after all package jobs, downloads the
two artifact bundles, and attaches the installers to the GitHub Release for
that tag. If the release already exists, assets are added to it; if it does not,
the job creates the release with generated notes.

This does not run for a release created before the job existed, and re-running
an old workflow run uses the old workflow file. In that case, download the
artifacts from the workflow run and attach them manually:

```bash
gh release upload v0.1.0 /path/to/EditAWr-* --clobber
```

Or use the GitHub UI: **Releases → the release → Edit → Attach binaries**.

### Adding signing to CI

CI currently publishes only Windows and Linux, and those builds are unsigned by
default. For Windows, set `CSC_LINK` and `CSC_KEY_PASSWORD` as repository
secrets and pass them to the electron-builder step.

macOS signing/notarization is handled in local builds; see **Code signing**
above. If macOS CI is re-added later, configure `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID` (or the API-key equivalents), enable `mac.notarize` and
hardened runtime, and remove `CSC_IDENTITY_AUTO_DISCOVERY=false`.

Keep signing secrets out of pull-request workflows. The package and release
jobs never run on pull requests, which is the safer pattern.

### macOS builds

There are no macOS artifacts in CI or on new Releases. Build locally on a Mac:

```bash
npm ci
npm run pack
```

On Apple Silicon, ad-hoc sign the local app before launching:

```bash
codesign --force --deep --sign - dist/mac-arm64/EditAWr.app
open dist/mac-arm64/EditAWr.app
```

Do not force `--arm64` on an x64 Mac: electron-builder will package the arm64
Electron binary, but `sharp` will still be the x64 native module installed by
`npm ci`. Build on the matching architecture.

The repository's `install.sh` automates the local macOS build, ad-hoc signing,
and installation to `~/Applications` (or `/Applications` with `--system`).

Older releases may still have `.dmg` assets. Delete them from the release page
with the GitHub UI or:

```bash
gh release delete-asset <tag> <asset-name> --yes
```

### Adding another architecture

Add a matrix entry that runs on a runner of that architecture. For example,
for Windows arm64:

```yaml
- name: windows-arm64
  os: windows-11-arm
  args: --win --arm64
  artifacts: |
    dist/*.exe
    dist/*.blockmap
```

## Verification checklist

Before publishing a build:

1. Install/launch the packaged app, not just the dev build.
2. Open a JPEG and a NEF.
3. Confirm thumbnails generate.
4. Open an HE/HE\* NEF and confirm the `HE/HE* preview` badge appears.
5. Open a decodable RAW and confirm the 16-bit path still works.
6. Export a JPEG and a full-resolution file.
7. Check `app.asar.unpacked` contains the correct `@img/sharp-*` binary.
8. Check `app.asar` contains `src/renderer/vendor/libraw`.
9. On macOS, test the local build on the architecture you are using.
10. On Linux, test both the AppImage and the deb on a clean VM/container.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `Could not load the "sharp" module` / wrong ELF or Mach-O | Package was cross-built; wrong `@img` binary | Build on the target OS/arch, or install the matching `@img/sharp-*` package |
| LibRaw/WASM 404 in the packaged app | Vendor step not run; vendor dir deleted | Run `node scripts/vendor.js` before `electron-builder` |
| macOS: “app is damaged” | Unsigned, not notarized, or quarantined build | `xattr -dr com.apple.quarantine /Applications/EditAWr.app`; if still blocked, ad-hoc sign with `codesign --force --deep --sign -`; real fix is Developer ID + notarization |
| macOS notarization fails | Missing credentials, hardened runtime or entitlement | Check Apple ID/API key, `mac.notarize`, and codesign output |
| Windows SmartScreen warning | Installer is unsigned | Sign with an Authenticode certificate |
| Linux AppImage will not start | FUSE missing | Install FUSE 2, or run `./EditAWr-*.AppImage --appimage-extract-and-run` |
| `.deb` missing dependencies | Base image is too minimal | `sudo apt-get -f install`; list required libs in the package metadata |
| Only one Windows `.exe` appears | Both targets share `artifactName` | Use distinct `nsis.artifactName` and `portable.artifactName` |
| electron-builder tries to publish | Publish configuration present | Add `--publish never` |
| `npm ci` cannot find sharp binaries | Optional dependencies were omitted | Re-run without `--omit=optional` |
| Build is huge | Tests/docs or unpacked output included | Keep the `files`/`asarUnpack` config tight; delete `dist/` before a clean build |

## Release checklist

Tag builds inherit their version from the tag. Pushing `v0.1.3` produces
`EditAWr-0.1.3-*` even if `package.json` still says `0.1.2`: CI writes the tag
version into `package.json` inside the runner before electron-builder runs.

For local builds, where there is no release tag, update the version yourself:

```bash
# Creates a commit and tag as well
npm version patch

git push origin main
git push origin --tags
```

Or update the version without creating a tag/commit:

```bash
npm version patch --no-git-tag-version
```

Or create the tag manually:

```bash
git tag v0.1.3
git push origin v0.1.3
```

The tag triggers the package jobs, and the release job attaches the installers
to the matching GitHub Release. Review them, sign them if the release requires
it, then publish. The repository does not configure `electron-updater`; add it
only after signing is in place.
