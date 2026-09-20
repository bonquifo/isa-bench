#!/usr/bin/env bash
set -euo pipefail
export PATH="/home/toby/.local/node-v22.19.0-linux-x64/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
cd /home/toby/isa-sim-linux
npm run contracts:build
npm run desktop:build
npx electron-builder --linux AppImage --publish never
mkdir -p /mnt/c/ISA_SIM/release
copied=0
for artifact in /home/toby/isa-sim-linux/release/*.AppImage /home/toby/isa-sim-linux/release/*.rpm /home/toby/isa-sim-linux/release/*.yml; do
  if [[ -f "$artifact" ]]; then
    cp -f "$artifact" /mnt/c/ISA_SIM/release/
    echo "copied $(basename "$artifact")"
    copied=$((copied + 1))
  fi
done
ls -lh /home/toby/isa-sim-linux/release
if [[ "$copied" -eq 0 ]]; then
  echo "No Linux artifacts copied" >&2
  exit 1
fi
