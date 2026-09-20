#!/bin/sh
set -eu

if [ "${1:-self-test}" != "self-test" ]; then
  exec "$@"
fi

case "${ISA_IMAGE_KIND:-}" in
  codegen)
    version="$(clang --version | sed -n '1s/.*version \([0-9.]*\).*/\1/p')"
    targets="$(llc --version)"
    [ "$version" = "23.1.0" ]
    for target in x86 aarch64 riscv mips ppc sparc wasm; do
      printf '%s\n' "$targets" | grep -qi "$target"
    done
    printf '{"ok":true,"image":"codegen","llvm":"%s","targets":["X86","AArch64","RISCV","Mips","PowerPC","Sparc","WebAssembly"]}\n' "$version"
    ;;
  wasi)
    clang_version="$(clang --version | sed -n '1s/.*version \([0-9.]*\).*/\1/p')"
    wasmtime_version="$(wasmtime --version | awk '{print $2}')"
    [ "$wasmtime_version" = "48.0.1" ]
    printf '{"ok":true,"image":"wasi","wasiSdk":"33.0","clang":"%s","wasmtime":"%s"}\n' "$clang_version" "$wasmtime_version"
    ;;
  mos)
    version="$(mos-clang --version | sed -n '1s/.*version \([0-9.]*\).*/\1/p')"
    printf '%s' "$version" | grep -q '^23\.'
    command -v mos-sim >/dev/null
    printf '{"ok":true,"image":"mos","llvmMos":"23.0.1","clang":"%s","execution":true,"executor":"mos-sim"}\n' "$version"
    ;;
  qemu)
    for target in aarch64 riscv64 mipsel ppc64le sparc; do
      version="$(qemu-"$target" --version | sed -n '1s/.*version \([0-9.]*\).*/\1/p')"
      [ "$version" = "11.1.0" ]
    done
    printf '{"ok":true,"image":"qemu","version":"11.1.0","targets":["aarch64","riscv64","mipsel","ppc64le","sparc"]}\n'
    ;;
  sparc-linker)
    version="$(sparc64-linux-gnu-ld --version | sed -n '1s/.* \([0-9][0-9.]*\)$/\1/p')"
    [ "$version" = "2.40" ]
    printf '{"ok":true,"image":"sparc-linker","binutils":"2.40-2","emulation":"elf32_sparc"}\n'
    ;;
  *)
    printf '{"ok":false,"reason":"unknown image kind"}\n' >&2
    exit 2
    ;;
esac
