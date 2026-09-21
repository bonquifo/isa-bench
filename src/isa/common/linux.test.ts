import { describe, expect, it } from 'vitest'
import { UnsupportedSyscall } from './errors.ts'
import { LinuxSyscalls, Sys, buildInitialStack, type ProcessLayout } from './linux.ts'
import { GuestMemory, PAGE_SIZE, Prot } from './memory.ts'

const LAYOUT: ProcessLayout = {
  stackPointer: 0x80000n,
  brkStart: 0x20000n,
  mmapStart: 0x40000n,
}

function fresh(): { memory: GuestMemory; linux: LinuxSyscalls } {
  const memory = new GuestMemory(true)
  memory.map(0x70000n, 0x10000, Prot.READ | Prot.WRITE)
  memory.map(LAYOUT.brkStart, PAGE_SIZE, Prot.READ | Prot.WRITE)
  return { memory, linux: new LinuxSyscalls(memory, LAYOUT) }
}

const call = (linux: LinuxSyscalls, number: number, ...args: bigint[]) =>
  linux.dispatch('test', number, [...args, 0n, 0n, 0n, 0n, 0n, 0n].slice(0, 6))

describe('output', () => {
  it('collects stdout and stderr separately', () => {
    const { memory, linux } = fresh()
    memory.writeBytes(0x70000n, new TextEncoder().encode('hello'))
    expect(call(linux, Sys.WRITE, 1n, 0x70000n, 5n).value).toBe(5n)
    expect(call(linux, Sys.WRITE, 2n, 0x70000n, 4n).value).toBe(4n)
    expect(new TextDecoder().decode(linux.stdout())).toBe('hello')
    expect(new TextDecoder().decode(linux.stderr())).toBe('hell')
  })

  it('gathers a writev across its iovecs', () => {
    const { memory, linux } = fresh()
    memory.writeBytes(0x70100n, new TextEncoder().encode('abcdef'))
    // Two iovecs: {0x70100, 3} and {0x70103, 3}.
    memory.store(0x70200n, 8, 0x70100n)
    memory.store(0x70208n, 8, 3n)
    memory.store(0x70210n, 8, 0x70103n)
    memory.store(0x70218n, 8, 3n)
    expect(call(linux, Sys.WRITEV, 1n, 0x70200n, 2n).value).toBe(6n)
    expect(new TextDecoder().decode(linux.stdout())).toBe('abcdef')
  })

  it('refuses a descriptor it does not model', () => {
    const { linux } = fresh()
    expect(() => call(linux, Sys.WRITE, 7n, 0x70000n, 1n)).toThrow(UnsupportedSyscall)
  })
})

describe('memory syscalls', () => {
  it('reports and moves the program break, mapping as it grows', () => {
    const { memory, linux } = fresh()
    expect(call(linux, Sys.BRK, 0n).value).toBe(LAYOUT.brkStart)
    const grown = LAYOUT.brkStart + 0x9000n
    expect(call(linux, Sys.BRK, grown).value).toBe(grown)
    // Everything below the new break must be addressable.
    memory.store(grown - 8n, 8, 0x1234n)
    expect(memory.load(grown - 8n, 8, false)).toBe(0x1234n)
  })

  it('refuses to move the break past the mapping arena', () => {
    const { linux } = fresh()
    // Out of range requests leave the break where it was, as the kernel does.
    expect(call(linux, Sys.BRK, LAYOUT.mmapStart + 0x1000n).value).toBe(LAYOUT.brkStart)
  })

  it('hands out anonymous mappings from the arena', () => {
    const { memory, linux } = fresh()
    const first = call(linux, Sys.MMAP, 0n, 0x1000n, 3n, 0x22n, -1n, 0n).value
    const second = call(linux, Sys.MMAP, 0n, 0x1000n, 3n, 0x22n, -1n, 0n).value
    expect(first).toBe(LAYOUT.mmapStart)
    expect(second).toBe(first + BigInt(PAGE_SIZE))
    memory.store(first, 8, 7n)
    expect(memory.load(first, 8, false)).toBe(7n)
  })

  it('places a fixed mapping exactly, and clears it', () => {
    const { memory, linux } = fresh()
    const at = 0x70000n
    memory.store(at, 8, 0xdeadbeefn)
    // MAP_FIXED over something already written must read back as zero: a
    // fresh anonymous mapping does not inherit what was there.
    expect(call(linux, Sys.MMAP, at, 0x1000n, 3n, 0x32n, -1n, 0n).value).toBe(at)
    expect(memory.load(at, 8, false)).toBe(0n)
  })

  it('refuses to map a file', () => {
    const { linux } = fresh()
    expect(() => call(linux, Sys.MMAP, 0n, 0x1000n, 3n, 0x2n, 3n, 0n)).toThrow(/of a file/)
  })
})

describe('the rest of the surface', () => {
  it('answers the calls a libc makes at startup', () => {
    const { linux } = fresh()
    expect(call(linux, Sys.SET_TID_ADDRESS, 0n).value).toBe(1n)
    expect(call(linux, Sys.GETUID).value).toBe(0n)
    expect(call(linux, Sys.PRLIMIT64).value).toBe(0n)
    expect(call(linux, Sys.MUNMAP, 0n, 0n).value).toBe(0n)
    // Not a terminal, which is the true answer rather than a stub.
    expect(call(linux, Sys.IOCTL, 1n, 0n, 0n).value).toBe(-25n)
  })

  it('reports a frozen clock, so two runs agree', () => {
    const { memory, linux } = fresh()
    expect(call(linux, Sys.CLOCK_GETTIME, 0n, 0x70000n).value).toBe(0n)
    const first = memory.load(0x70000n, 8, false)
    expect(call(linux, Sys.CLOCK_GETTIME, 0n, 0x70008n).value).toBe(0n)
    expect(memory.load(0x70008n, 8, false)).toBe(first)
  })

  it('produces the same random bytes every run, for the same reason', () => {
    const a = fresh()
    const b = fresh()
    call(a.linux, Sys.GETRANDOM, 0x70000n, 16n)
    call(b.linux, Sys.GETRANDOM, 0x70000n, 16n)
    expect([...a.memory.readBytes(0x70000n, 16)])
      .toEqual([...b.memory.readBytes(0x70000n, 16)])
    // And not merely constant.
    expect(new Set(a.memory.readBytes(0x70000n, 16)).size).toBeGreaterThan(4)
  })

  it('exits with the code the guest asked for', () => {
    const { linux } = fresh()
    const result = call(linux, Sys.EXIT_GROUP, 3n)
    expect(result.exited).toBe(true)
    expect(linux.exitCode).toBe(3)
  })

  it('says there is no file system rather than failing later', () => {
    const { linux } = fresh()
    for (const number of [Sys.OPENAT, Sys.READ, Sys.CLOSE, Sys.LSEEK, Sys.FACCESSAT]) {
      expect(() => call(linux, number)).toThrow(/no file system/)
    }
  })

  it('refuses an unknown syscall instead of returning an error code', () => {
    const { linux } = fresh()
    expect(() => call(linux, 1234)).toThrow(UnsupportedSyscall)
  })
})

describe('the initial process stack', () => {
  it('lays out argc, argv, envp and the auxiliary vector', () => {
    const memory = new GuestMemory(true)
    memory.map(0x70000n, 0x10000, Prot.READ | Prot.WRITE)
    const sp = buildInitialStack(
      memory,
      LAYOUT,
      { entry: 0x11000n, phdr: 0x10040n, phent: 56, phnum: 4 },
      { argv: ['prog', 'one'], envp: ['A=1'] },
    )
    expect(sp % 16n).toBe(0n)
    expect(memory.load(sp, 8, false)).toBe(2n)

    const argv0 = memory.load(sp + 8n, 8, false)
    const argv1 = memory.load(sp + 16n, 8, false)
    expect(memory.load(sp + 24n, 8, false)).toBe(0n)
    const decoder = new TextDecoder()
    expect(decoder.decode(memory.readBytes(argv0, 5))).toBe('prog\0')
    expect(decoder.decode(memory.readBytes(argv1, 4))).toBe('one\0')

    const env0 = memory.load(sp + 32n, 8, false)
    expect(decoder.decode(memory.readBytes(env0, 4))).toBe('A=1\0')
    expect(memory.load(sp + 40n, 8, false)).toBe(0n)

    // The aux vector follows, and must carry a usable page size: a libc that
    // reads zero there computes nonsense in its allocator and fails far away.
    const aux = new Map<bigint, bigint>()
    for (let at = sp + 48n; ; at += 16n) {
      const key = memory.load(at, 8, false)
      aux.set(key, memory.load(at + 8n, 8, false))
      if (key === 0n) break
    }
    expect(aux.get(6n)).toBe(BigInt(PAGE_SIZE))
    expect(aux.get(3n)).toBe(0x10040n)
    expect(aux.get(4n)).toBe(56n)
    expect(aux.get(5n)).toBe(4n)
    expect(aux.get(9n)).toBe(0x11000n)
    // AT_RANDOM must point at sixteen readable bytes.
    expect(memory.readBytes(aux.get(25n)!, 16)).toHaveLength(16)
  })

  it('defaults to one argument and no environment', () => {
    const memory = new GuestMemory(true)
    memory.map(0x70000n, 0x10000, Prot.READ | Prot.WRITE)
    const sp = buildInitialStack(memory, LAYOUT, {
      entry: 0x11000n, phdr: 0n, phent: 0, phnum: 0,
    })
    expect(memory.load(sp, 8, false)).toBe(1n)
    expect(memory.load(sp + 16n, 8, false)).toBe(0n)
  })
})
