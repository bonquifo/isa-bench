import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeToolchains, validateDisassembly, validateElfHeader } from './toolchains.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('toolchain capability probing', () => {
  it('passes only verified immutable image IDs to the executor', async () => {
    const root = fixtureRoot()
    const execute = vi.fn(async () => ({
      kind: 'exited' as const,
      exitCode: 0,
      signal: null,
      stdout: '',
      stdoutBase64: '',
      stderr: '',
      durationMs: 1,
      truncated: false,
    }))
    const probe = await probeToolchains({ execute } as never, undefined, {
      root,
      inspectImage: () => `sha256:${'1'.repeat(64)}`,
    })
    expect(probe.available).toBe(true)
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      image: `sha256:${'1'.repeat(64)}`,
      jobId: 'capability-probe',
    }))
  })

  it('returns structured unavailable for stale locks without invoking Docker', async () => {
    const root = fixtureRoot()
    const lockPath = join(root, 'toolchains', 'images.lock.json')
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as { sourceManifestSha256: string }
    lock.sourceManifestSha256 = '0'.repeat(64)
    writeFileSync(lockPath, JSON.stringify(lock))
    const execute = vi.fn()
    const probe = await probeToolchains({ execute } as never, undefined, { root })
    expect(probe).toMatchObject({
      available: false,
      reason: expect.stringContaining('stale'),
      images: {},
    })
    expect(execute).not.toHaveBeenCalled()
  })

  it('returns structured unavailable when a local tag resolves to another ID', async () => {
    const root = fixtureRoot()
    const execute = vi.fn()
    const probe = await probeToolchains({ execute } as never, undefined, {
      root,
      inspectImage: () => `sha256:${'2'.repeat(64)}`,
    })
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain('local ID differs from lock')
    expect(execute).not.toHaveBeenCalled()
  })
})

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'isa-sim-toolchain-probe-'))
  roots.push(root)
  const directory = join(root, 'toolchains')
  mkdirSync(directory)
  const manifest = {
    images: { codegen: 'isa-sim/codegen:test' },
    targets: {
      'x86_64-linux': { tier: 'execute', executor: 'native' },
    },
  }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  writeFileSync(join(directory, 'manifest.json'), manifestBytes)
  writeFileSync(join(directory, 'images.lock.json'), JSON.stringify({
    schemaVersion: 1,
    sourceManifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    images: {
      codegen: {
        reference: 'isa-sim/codegen:test',
        imageId: `sha256:${'1'.repeat(64)}`,
      },
    },
  }))
  writeFileSync(join(directory, 'capabilities.lock.json'), JSON.stringify({
    schemaVersion: 1,
    imagesLockSha256: createHash('sha256')
      .update(readFileSync(join(directory, 'images.lock.json')))
      .digest('hex'),
    observations: {
      'x86_64-linux': { tier: 'execute', reason: 'test fixture' },
    },
  }))
  return root
}

function elf(elfClass: 1 | 2, little: boolean, machine: number, flags = 0): Uint8Array {
  const bytes = new Uint8Array(64)
  bytes.set([0x7f, 0x45, 0x4c, 0x46, elfClass, little ? 1 : 2])
  new DataView(bytes.buffer).setUint16(18, machine, little)
  new DataView(bytes.buffer).setUint32(elfClass === 1 ? 36 : 48, flags, little)
  return bytes
}

describe('toolchain artifact validation', () => {
  it('validates ELF class, byte order, and machine', () => {
    expect(() => validateElfHeader(elf(2, true, 62), {
      elfClass: 2, endianness: 'little', machine: 62,
    })).not.toThrow()
    expect(() => validateElfHeader(elf(1, false, 2), {
      elfClass: 1, endianness: 'big', machine: 2,
    })).not.toThrow()
    expect(() => validateElfHeader(elf(1, false, 18), {
      elfClass: 1, endianness: 'big', machine: 2,
    })).toThrow('machine')
  })

  it('validates target ABI flags', () => {
    expect(() => validateElfHeader(elf(1, true, 8, 0x50001000), {
      elfClass: 1, endianness: 'little', machine: 8, flagsMask: 0xf000f000, flagsValue: 0x50001000,
    })).not.toThrow()
    expect(() => validateElfHeader(elf(1, true, 8, 0x60000020), {
      elfClass: 1, endianness: 'little', machine: 8, flagsMask: 0xf000f000, flagsValue: 0x50001000,
    })).toThrow('ABI')
    expect(() => validateElfHeader(elf(2, true, 21, 1), {
      elfClass: 2, endianness: 'little', machine: 21, flagsMask: 0x3, flagsValue: 2,
    })).toThrow('ABI')
  })

  it('rejects unknown decode and post-V8 SPARC instructions', () => {
    expect(() => validateDisassembly('0000: <unknown>', 'x86_64-linux')).toThrow('unknown')
    expect(() => validateDisassembly('0000: casx %g1, %g2, %g3', 'sparc-v8')).toThrow('newer')
    expect(() => validateDisassembly('0000: add %g1, %g2, %g3', 'sparc-v8')).not.toThrow()
  })
})
