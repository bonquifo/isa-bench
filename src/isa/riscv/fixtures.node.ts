/**
 * RV64 binding for the shared fixture reader: the directory the fixtures live
 * in, and the layout of the architectural state dump the RV64 guest harness
 * writes. Everything ISA-independent is in ../common/fixtures.node.ts.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDumpBytes } from '../common/fixtures.node.ts'
import { RV64_DUMP_BYTES } from './backend.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
export const RV64_FIXTURE_DIR = join(HERE, 'fixtures')

const SCRATCH_OFFSET = 528
export const RV64_SCRATCH_BYTES = RV64_DUMP_BYTES - SCRATCH_OFFSET

/** Mirrors struct IsaDump in tools/isa/rv64/harness.h. */
export interface GuestDump {
  x: bigint[]
  f: bigint[]
  fcsr: bigint
  scratch: Uint8Array
}

export function decodeDump(bytes: Uint8Array): GuestDump {
  if (bytes.length !== RV64_DUMP_BYTES) {
    throw new Error(`guest dump is ${bytes.length} bytes, expected ${RV64_DUMP_BYTES}`)
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const x: bigint[] = []
  const f: bigint[] = []
  for (let i = 0; i < 32; i++) x.push(view.getBigUint64(i * 8, true))
  for (let i = 0; i < 32; i++) f.push(view.getBigUint64(256 + i * 8, true))
  return {
    x,
    f,
    fcsr: view.getBigUint64(512, true),
    scratch: bytes.slice(SCRATCH_OFFSET, SCRATCH_OFFSET + RV64_SCRATCH_BYTES),
  }
}

export function readDump(name: string): GuestDump {
  return decodeDump(readDumpBytes(RV64_FIXTURE_DIR, name))
}

/**
 * Names every 64-bit field of the dump, so a byte mismatch in the shared
 * conformance suite can be reported as `f12` rather than as an offset.
 */
export function labelRv64Dump(bytes: Uint8Array): Map<number, string> {
  const labels = new Map<number, string>()
  for (let i = 0; i < 32; i++) labels.set(i * 8, `x${i}`)
  for (let i = 0; i < 32; i++) labels.set(256 + i * 8, `f${i}`)
  labels.set(512, 'fcsr')
  labels.set(520, 'pad')
  for (let i = SCRATCH_OFFSET; i < bytes.length; i += 8) {
    labels.set(i, `scratch[${(i - SCRATCH_OFFSET) / 8}]`)
  }
  return labels
}
