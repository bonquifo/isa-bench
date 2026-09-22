/**
 * The 6502's address space: sixty-four kilobytes, flat, and entirely real.
 *
 * Every other target here uses `GuestMemory`, which keeps a page table and
 * faults on an unmapped access. That is the right model for a machine with
 * an MMU and a kernel that maps things. This one has neither. All sixteen
 * address bits reach the bus, every address responds, and there is no such
 * thing as a segmentation fault -- so modelling one would be inventing a
 * behaviour the hardware does not have, and the conformance vectors, which
 * poke at arbitrary addresses and expect an answer, would fail against it.
 *
 * What *is* real is that some addresses are not memory. On a real machine
 * they are hardware; under the llvm-mos simulator they are the two
 * addresses that reach the outside world. A device may claim an address,
 * and everything else is RAM.
 */

export const ADDRESS_SPACE = 0x10000

/** Where the processor looks for the address to run on reset or a trap. */
export const Vector = {
  NMI: 0xfffa,
  RESET: 0xfffc,
  IRQ: 0xfffe,
} as const

/**
 * An address that is not memory.
 *
 * Returning `null` from `read` means "not mine, read the RAM underneath",
 * which keeps a device from having to model storage it does not have.
 */
export interface MosDevice {
  readonly first: number
  readonly last: number
  read(address: number): number | null
  write(address: number, value: number): void
}

export class MosBus {
  readonly ram = new Uint8Array(ADDRESS_SPACE)
  private readonly devices: MosDevice[] = []
  /**
   * Set when any device occupies an address, so the common case -- no
   * devices at all, which is what the per-opcode vectors run against --
   * costs one boolean test rather than a scan.
   */
  private hasDevices = false

  attach(device: MosDevice): void {
    this.devices.push(device)
    this.hasDevices = true
  }

  read(address: number): number {
    const a = address & 0xffff
    if (this.hasDevices) {
      for (const device of this.devices) {
        if (a >= device.first && a <= device.last) {
          const value = device.read(a)
          if (value !== null) return value & 0xff
        }
      }
    }
    return this.ram[a]!
  }

  write(address: number, value: number): void {
    const a = address & 0xffff
    const v = value & 0xff
    if (this.hasDevices) {
      for (const device of this.devices) {
        if (a >= device.first && a <= device.last) {
          device.write(a, v)
          return
        }
      }
    }
    this.ram[a] = v
  }

  /** A word, low byte first, with the high byte one address along. */
  readWord(address: number): number {
    return this.read(address) | (this.read((address + 1) & 0xffff) << 8)
  }

  loadBytes(address: number, data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) {
      this.ram[(address + i) & 0xffff] = data[i]!
    }
  }
}
