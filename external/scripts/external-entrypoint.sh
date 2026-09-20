#!/bin/sh
set -eu

if [ "${1:-self-test}" != "self-test" ]; then
  exec "$@"
fi

case "${ISA_IMAGE_KIND:-}" in
  gem5)
    build="$(gem5.opt --outdir=/tmp/gem5-self-test --build-info 2>&1)"
    version="$(printf '%s\n' "$build" | sed -n 's/^gem5 version //p')"
    [ "$version" = "25.1.0.0" ]
    printf '%s\n' "$build" | grep -q 'USE_X86_ISA'
    printf '%s\n' "$build" | grep -q 'USE_ARM_ISA'
    printf '%s\n' "$build" | grep -q 'USE_RISCV_ISA'
    printf '{"ok":true,"image":"gem5","version":"%s","binary":"gem5.opt","optimization":"release","buildTarget":"ALL","requiredIsas":["X86","ARM","RISCV"]}\n' "$version"
    ;;
  champsim)
    [ -x /opt/champsim/bin/champsim ]
    printf '{"ok":true,"image":"champsim","version":"2026-04","commit":"8e5f6c114fcbc8fe4f7838d86c3f5881c14077da","traceRecordBytes":64}\n'
    ;;
  *)
    printf '{"ok":false,"reason":"unknown external image kind"}\n' >&2
    exit 2
    ;;
esac
