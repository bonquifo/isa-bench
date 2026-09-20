ARG BASE=debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
FROM ${BASE}
ARG SOURCE_DATE_EPOCH=1787616000
ARG LLVM_URL=https://github.com/llvm/llvm-project/releases/download/llvmorg-23.1.0/llvm-project-23.1.0.src.tar.xz
ARG LLVM_SHA256=ab1f0e3ec52448c33e8782eaf0422504b87c7b016b22514653ee0d8fcee479ff
ARG QEMU_URL=https://download.qemu.org/qemu-11.1.0.tar.xz
ARG QEMU_SHA256=6ee1d1a61f68212476b27108c26da5f449dc09b626d42f8279ba0dc2e08fa858
ENV SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH} TZ=UTC LC_ALL=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
  ca-certificates curl xz-utils cmake ninja-build python3 build-essential pkg-config \
  libglib2.0-dev libpixman-1-dev zlib1g-dev \
 && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --proto '=https' --tlsv1.2 "${LLVM_URL}" -o /tmp/llvm.tar.xz \
 && echo "${LLVM_SHA256}  /tmp/llvm.tar.xz" | sha256sum --check --strict \
 && mkdir /src/llvm && tar -xJf /tmp/llvm.tar.xz -C /src/llvm --strip-components=1 \
 && cmake -S /src/llvm/llvm -B /build/llvm -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/out/llvm \
    -DLLVM_ENABLE_PROJECTS='clang;lld' \
    -DLLVM_TARGETS_TO_BUILD='X86;AArch64;RISCV;Mips;PowerPC;Sparc;WebAssembly' \
    -DLLVM_ENABLE_TERMINFO=OFF -DLLVM_ENABLE_ZSTD=OFF -DLLVM_INCLUDE_TESTS=OFF \
 && cmake --build /build/llvm --target install --parallel 32 \
 && find /out/llvm -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +
RUN curl --fail --location --proto '=https' --tlsv1.2 "${QEMU_URL}" -o /tmp/qemu.tar.xz \
 && echo "${QEMU_SHA256}  /tmp/qemu.tar.xz" | sha256sum --check --strict \
 && mkdir /src/qemu && tar -xJf /tmp/qemu.tar.xz -C /src/qemu --strip-components=1 \
 && cd /src/qemu \
 && ./configure --prefix=/out/qemu --static --disable-system \
    --target-list=aarch64-linux-user,riscv64-linux-user,mipsel-linux-user,ppc64le-linux-user,sparc-linux-user \
 && ninja -C build -j32 install \
 && find /out/qemu -exec touch -h -d "@${SOURCE_DATE_EPOCH}" {} +
