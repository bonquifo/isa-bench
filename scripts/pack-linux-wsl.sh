#!/usr/bin/env bash
# Build the Linux installers from a Windows checkout, inside WSL.
#
# electron-builder cannot produce correct Linux artifacts on Windows: NTFS has
# no executable bit, so a tar.gz built there unpacks without +x on `isa-bench`
# and `chrome-sandbox` and will not start, and AppImage needs symlinks that
# Windows withholds without Developer Mode. Building inside a Linux filesystem
# avoids both. Run from the repository root:
#
#   wsl -d <distro> -- bash scripts/pack-linux-wsl.sh
#
# Artifacts are copied back into ./release on the Windows side.
set -euo pipefail

if [ ! -f package.json ] || [ ! -d src/engine ]; then
  echo "run this from the repository root" >&2
  exit 1
fi

SOURCE="$(pwd)"
WORK="${ISA_BENCH_WSL_WORKDIR:-$HOME/.cache/isa-bench-linux-build}"

# A Node that can run Vite and electron-builder. Prefer whatever is on PATH,
# then any unpacked official tarball under ~/.local, newest first.
find_node() {
  if command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ]; then
    command -v node | xargs dirname
    return 0
  fi
  local candidate
  candidate="$(ls -d "$HOME"/.local/node-v* 2>/dev/null | sort -V | tail -1 || true)"
  if [ -n "$candidate" ] && [ -x "$candidate/bin/node" ]; then
    echo "$candidate/bin"
    return 0
  fi
  return 1
}

if ! NODE_BIN="$(find_node)"; then
  cat >&2 <<'MESSAGE'
No Node 22+ found inside this distro.

Install one without root, for example:
  V=v22.23.2
  mkdir -p ~/.local && cd ~/.local
  curl -fsSLO "https://nodejs.org/dist/$V/node-$V-linux-x64.tar.xz"
  tar xf "node-$V-linux-x64.tar.xz"

then run this script again.
MESSAGE
  exit 1
fi
export PATH="$NODE_BIN:$PATH"
echo "node $(node -v) / npm $(npm -v)"

# Copy the sources into the Linux filesystem. Building over /mnt/c is slow and
# reintroduces the permission problems this script exists to avoid.
echo "syncing sources to $WORK"
mkdir -p "$WORK"
rsync -a --delete \
  --exclude node_modules --exclude release --exclude dist \
  --exclude desktop/dist --exclude .git --exclude .wsltmp \
  "$SOURCE"/ "$WORK"/

cd "$WORK"
echo "installing dependencies"
npm install --no-audit --no-fund

echo "building Linux packages"
npm run desktop:pack:linux

echo "copying artifacts back"
mkdir -p "$SOURCE/release"
find release -maxdepth 1 -type f \( -name '*.AppImage' -o -name '*.tar.gz' -o -name '*.yml' \) \
  -exec cp -f {} "$SOURCE/release/" \;

echo
echo "built:"
find release -maxdepth 1 -type f \( -name '*.AppImage' -o -name '*.tar.gz' \) -printf '  %f (%s bytes)\n'
echo
echo "executable bits inside the tarball:"
for archive in release/*.tar.gz; do
  [ -e "$archive" ] || continue
  tar tvzf "$archive" | grep -E 'isa-bench$|chrome-sandbox$' || true
done
