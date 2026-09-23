# Cross-compiling LLVM itself to WASI, after YoWASP's build script.
set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)

# The WASI SDK's platform file defines WASI, which LLVM's configuration
# checks; a CMake that predates WASI support does not know the platform.
list(APPEND CMAKE_MODULE_PATH /opt/wasi-sdk/share/cmake)

set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

set(WASI_SDK /opt/wasi-sdk)
set(CMAKE_C_COMPILER ${WASI_SDK}/bin/clang)
set(CMAKE_C_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_CXX_COMPILER ${WASI_SDK}/bin/clang++)
set(CMAKE_CXX_COMPILER_TARGET wasm32-wasip1)
set(CMAKE_LINKER ${WASI_SDK}/bin/wasm-ld)
set(CMAKE_AR ${WASI_SDK}/bin/llvm-ar)
set(CMAKE_RANLIB ${WASI_SDK}/bin/llvm-ranlib)

# LLVM has some mmap calls that are unreachable in this configuration.
set(WASI_FLAGS "--sysroot ${WASI_SDK}/share/wasi-sysroot -D_WASI_EMULATED_MMAN")
set(CMAKE_C_FLAGS "${WASI_FLAGS}")
set(CMAKE_CXX_FLAGS "${WASI_FLAGS}")
# Compiling can take a lot of memory and a deep stack; the stack goes first
# so an overflow traps rather than corrupting the heap.
set(CMAKE_EXE_LINKER_FLAGS "--sysroot ${WASI_SDK}/share/wasi-sysroot -lwasi-emulated-mman -Wl,--max-memory=4294967296 -Wl,-z,stack-size=8388608,--stack-first -Wl,--strip-all")
