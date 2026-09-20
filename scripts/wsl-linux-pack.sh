#!/usr/bin/env bash
set -euo pipefail

export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
umask 022

WIN_ROOT="${ISA_SIM_WIN_ROOT:-/mnt/c/ISA_SIM}"
LINUX_ROOT="${ISA_SIM_LINUX_ROOT:-$HOME/isa-sim-linux}"
NODE_VERSION="22.19.0"
NODE_HOME="$HOME/.local/node-v${NODE_VERSION}-linux-x64"

log() { printf '\n==> %s\n' "$*"; }

if [[ ! -f "$WIN_ROOT/package.json" ]]; then
  echo "Windows project not found at $WIN_ROOT" >&2
  exit 1
fi

if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  log "Installing Node ${NODE_VERSION} for Linux"
  mkdir -p "$HOME/.local"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C "$HOME/.local"
fi
export PATH="${NODE_HOME}/bin:${PATH}"
node -v
npm -v
case "$(node -v)" in
  v22.*|v23.*|v24.*) ;;
  *) echo "Need Node 22 or newer; got $(node -v)" >&2; exit 1 ;;
esac

log "Syncing project to ${LINUX_ROOT}"
mkdir -p "$LINUX_ROOT"
rsync -a --delete \
  --exclude node_modules \
  --exclude '**/node_modules' \
  --exclude /release \
  --exclude /dist \
  --exclude /desktop/dist \
  --exclude /.isa-bench-data \
  --exclude /.git \
  --exclude /node_modules/.tmp \
  "${WIN_ROOT}/" "${LINUX_ROOT}/"

cd "$LINUX_ROOT"
# rsync deliberately does not sync build output, so it also never deletes it.
# tsc and vite only overwrite what they emit, which leaves renamed or removed
# files (a preload that changed extension, an old asset hash) to be packaged.
# The tsbuildinfo files must go too: `tsc -b` treats a project whose output was
# deleted as still up to date and then emits nothing at all.
log "Clearing stale build output"
rm -rf "${LINUX_ROOT}/dist" "${LINUX_ROOT}/desktop/dist" "${LINUX_ROOT}/node_modules/.tmp"

log "Installing npm workspaces"
npm install --no-audit --no-fund

# electron-builder's fpm targets (rpm, deb) refuse to build without a project
# homepage and an author email, so they are only attempted once that metadata
# exists. Adding them unconditionally fails the whole Linux build.
linux_targets="AppImage tar.gz"
homepage="$(node -p "require('./package.json').homepage || ''" 2>/dev/null || true)"
if [[ -z "$homepage" ]]; then
  echo "package.json has no homepage; electron-builder cannot build rpm or deb. Building AppImage and tar.gz only."
else
  if command -v rpmbuild >/dev/null; then linux_targets="${linux_targets} rpm"; else echo "rpmbuild is not installed; skipping rpm."; fi
  if command -v fakeroot >/dev/null; then linux_targets="${linux_targets} deb"; else echo "fakeroot is not installed; skipping deb."; fi
fi

log "Building Linux targets: ${linux_targets}"
npm run contracts:build
npm run desktop:build
# The copy step below globs this directory, so anything left from an earlier or
# partly failed build would be published as if it came from this one.
rm -rf "${LINUX_ROOT}/release"
# electron-builder publish mode is disabled
npx electron-builder --linux ${linux_targets} --publish never

log "Copying artifacts to Windows release/"
mkdir -p "${WIN_ROOT}/release"
shopt -s nullglob
copied=0
for artifact in \
  "${LINUX_ROOT}"/release/*.AppImage \
  "${LINUX_ROOT}"/release/*.rpm \
  "${LINUX_ROOT}"/release/*.tar.* \
  "${LINUX_ROOT}"/release/*.yml
do
  cp -f "$artifact" "${WIN_ROOT}/release/"
  copied=$((copied + 1))
  echo "copied $(basename "$artifact")"
done
if [[ "$copied" -eq 0 ]]; then
  echo "No Linux artifacts were produced" >&2
  ls -la "${LINUX_ROOT}/release" || true
  exit 1
fi

log "Linux packages are in ${WIN_ROOT}/release"
ls -lh "${WIN_ROOT}/release"
