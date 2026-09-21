#!/bin/sh
# Builds compiler-rt's builtins for each cross target, without CMake.
#
# The builtins are plain C and assembly with no configuration to speak of, and
# driving CMake to cross-compile them needs more scaffolding than compiling
# them directly does. What is needed here is narrow: musl's printf pulls in
# 128-bit long double support, which no target here has in hardware.
#
# Files that do not apply to a target are expected to fail to compile, so a
# failure is skipped rather than fatal -- but every skip is printed, and the
# real check is the link: a builtin that is genuinely needed and missing
# produces an undefined symbol naming it, which is a loud failure rather than
# a silent wrong answer.
set -eu

SRC=$1
OUT=$2
mkdir -p "$OUT"

for triple in riscv64 aarch64 x86_64; do
  arch_dir=""
  case "$triple" in
    riscv64) arch_dir="riscv" ;;
    aarch64) arch_dir="aarch64" ;;
    x86_64) arch_dir="x86_64" ;;
  esac

  work="/tmp/builtins-$triple"
  rm -rf "$work"
  mkdir -p "$work"
  skipped=0
  built=0

  for source in "$SRC"/*.c "$SRC/$arch_dir"/*.c "$SRC/$arch_dir"/*.S; do
    [ -e "$source" ] || continue
    object="$work/$(basename "$source" | tr '/' '_').o"
    if clang --target="$triple-unknown-linux-musl" -O2 -fno-builtin -ffreestanding \
        -I"$SRC" -c -o "$object" "$source" 2>/dev/null; then
      built=$((built + 1))
    else
      skipped=$((skipped + 1))
      echo "  skipped $(basename "$source")"
    fi
  done

  llvm-ar rcs "$OUT/libclang_rt.builtins-$triple.a" "$work"/*.o
  echo "$triple: $built objects, $skipped skipped -> libclang_rt.builtins-$triple.a"
  rm -rf "$work"
done
