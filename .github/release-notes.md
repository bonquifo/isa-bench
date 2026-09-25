## Which file do I download?

| Your computer | Download | Then |
| --- | --- | --- |
| **Windows** (64-bit) | `…Setup…win-x64.exe` to install, or `…Portable…win-x64.exe` to run without installing | If SmartScreen warns, choose **More info → Run anyway** (the app is not code-signed) |
| **Linux** (64-bit x86) | `…linux-x86_64.AppImage` | `chmod +x` the file, then run it. Ubuntu 22.04 and later need `sudo apt install libfuse2` |
| **Linux**, without FUSE | `…linux-x64.tar.gz` | Extract it and run `isa-bench` inside |
| **macOS** (Apple Silicon: M1 and later) | `…mac-arm64.dmg` | Open it, drag ISA Bench to Applications, then right-click the app and choose **Open** the first time |
| **macOS** (Intel) | build from source: `npm ci`, `node scripts/fetch-toolchain.mjs`, `npm run desktop:pack:mac` | |

Nothing else to install: the compilers for all eight instruction sets are built in and work offline.
More about the app: https://bonquifo.github.io/isa-bench/
