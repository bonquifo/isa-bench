import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..').replaceAll('\\', '/')
const mapped = root.replace(/^([A-Za-z]):/, (_, drive) => `/mnt/${drive.toLowerCase()}`)
const script = `${mapped}/scripts/wsl-linux-pack.sh`
const distribution = process.env.ISA_SIM_WSL_DISTRO ?? 'Ubuntu'

// Tell the Linux side where this checkout actually is; without it the packaging
// script falls back to a hardcoded /mnt/c/ISA_SIM and silently packages the
// wrong tree (or fails) for any other checkout location.
execFileSync('wsl', ['-d', distribution, '--', 'bash', script], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ISA_SIM_WIN_ROOT: mapped,
    WSLENV: `${process.env.WSLENV ? `${process.env.WSLENV}:` : ''}ISA_SIM_WIN_ROOT`,
  },
})
