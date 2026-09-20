export const RESULT_FRAME_MAGIC = 0x46415349
export const RESULT_FRAME_VERSION = 1
export const RESULT_FRAME_HEADER_BYTES = 24

export type ResultKind = 'i32' | 'binary64'
export type FrameStatus = 'ok' | 'fault'

export interface ResultFrame {
  version: 1
  status: FrameStatus
  resultKind: ResultKind
  rawBits: bigint
  stdout: Uint8Array
  fault: string
}

const decoder = new TextDecoder('utf-8', { fatal: true })
const encoder = new TextEncoder()

export function parseResultFrame(bytes: Uint8Array, maxPayloadBytes = 4 * 1024 * 1024): ResultFrame {
  if (bytes.byteLength < RESULT_FRAME_HEADER_BYTES) throw new Error('result frame is truncated')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0, true) !== RESULT_FRAME_MAGIC) throw new Error('invalid result frame magic')
  if (view.getUint16(4, true) !== RESULT_FRAME_VERSION) throw new Error('unsupported result frame version')
  const statusByte = view.getUint8(6)
  const kindByte = view.getUint8(7)
  if (statusByte > 1) throw new Error('invalid result frame status')
  if (kindByte > 1) throw new Error('invalid result frame result kind')
  const stdoutLength = view.getUint32(16, true)
  const faultLength = view.getUint32(20, true)
  const payloadLength = stdoutLength + faultLength
  if (!Number.isSafeInteger(payloadLength) || payloadLength > maxPayloadBytes) {
    throw new Error('result frame payload exceeds limit')
  }
  if (bytes.byteLength !== RESULT_FRAME_HEADER_BYTES + payloadLength) {
    throw new Error('result frame length mismatch')
  }
  const stdout = bytes.slice(RESULT_FRAME_HEADER_BYTES, RESULT_FRAME_HEADER_BYTES + stdoutLength)
  const faultBytes = bytes.slice(RESULT_FRAME_HEADER_BYTES + stdoutLength)
  const fault = decoder.decode(faultBytes)
  if (statusByte === 0 && faultLength !== 0) throw new Error('successful result frame contains a fault')
  if (statusByte === 1 && faultLength === 0) throw new Error('fault result frame has no diagnostic')
  return {
    version: 1,
    status: statusByte === 0 ? 'ok' : 'fault',
    resultKind: kindByte === 0 ? 'i32' : 'binary64',
    rawBits: view.getBigUint64(8, true),
    stdout,
    fault,
  }
}

export function encodeResultFrame(frame: ResultFrame): Uint8Array {
  const fault = encoder.encode(frame.fault)
  const bytes = new Uint8Array(RESULT_FRAME_HEADER_BYTES + frame.stdout.byteLength + fault.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, RESULT_FRAME_MAGIC, true)
  view.setUint16(4, RESULT_FRAME_VERSION, true)
  view.setUint8(6, frame.status === 'ok' ? 0 : 1)
  view.setUint8(7, frame.resultKind === 'i32' ? 0 : 1)
  view.setBigUint64(8, frame.rawBits, true)
  view.setUint32(16, frame.stdout.byteLength, true)
  view.setUint32(20, fault.byteLength, true)
  bytes.set(frame.stdout, RESULT_FRAME_HEADER_BYTES)
  bytes.set(fault, RESULT_FRAME_HEADER_BYTES + frame.stdout.byteLength)
  return bytes
}

export function frameValue(frame: ResultFrame): number {
  if (frame.resultKind === 'i32') return Number(BigInt.asIntN(32, frame.rawBits))
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, frame.rawBits, true)
  return new DataView(bytes.buffer).getFloat64(0, true)
}

export function compareResultFrame(
  frame: ResultFrame,
  reference: { value: number; stdout: string },
): { equal: boolean; reason: string } {
  if (frame.status !== 'ok') return { equal: false, reason: `target fault: ${frame.fault}` }
  const actual = frameValue(frame)
  const valueEqual = frame.resultKind === 'i32'
    ? Number.isInteger(reference.value) && actual === reference.value
    : (Number.isNaN(actual) && Number.isNaN(reference.value)) || Object.is(actual, reference.value)
  if (!valueEqual) return { equal: false, reason: 'result bits differ from independent reference' }
  const referenceStdout = Uint8Array.from(reference.stdout, (character) => character.charCodeAt(0) & 0xff)
  if (!bytesEqual(frame.stdout, referenceStdout)) {
    return { equal: false, reason: 'stdout bytes differ from independent reference' }
  }
  return { equal: true, reason: 'result and stdout match independent reference' }
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index])
}
