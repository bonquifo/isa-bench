/**
 * Versioned contract for deterministic educational measurements.
 *
 * These versions are intentionally independent: consumers can tell whether a
 * result changed because of its shape, model, compiler, profiles, or energy
 * accounting.
 */
export const MEASUREMENT_SCHEMA_VERSION = '3'
export const MEASUREMENT_MODEL_VERSION = '9'
export const FRONTEND_VERSION = '6'
export const BACKEND_VERSION = '5'
export const PROFILE_VERSION = '5'
export const ENERGY_MODEL_VERSION = '2'

export const MEASUREMENT_CLAIM_SCOPE = 'software-model-only' as const
export const MEASUREMENT_MODEL_KIND = 'deterministic-educational-model' as const

export interface MeasurementContract {
  schemaVersion: string
  modelVersion: string
  frontendVersion: string
  backendVersion: string
  profileVersion: string
  energyVersion: string
  claimScope: typeof MEASUREMENT_CLAIM_SCOPE
  modelKind: typeof MEASUREMENT_MODEL_KIND
}

export const MEASUREMENT_CONTRACT: Readonly<MeasurementContract> = Object.freeze({
  schemaVersion: MEASUREMENT_SCHEMA_VERSION,
  modelVersion: MEASUREMENT_MODEL_VERSION,
  frontendVersion: FRONTEND_VERSION,
  backendVersion: BACKEND_VERSION,
  profileVersion: PROFILE_VERSION,
  energyVersion: ENERGY_MODEL_VERSION,
  claimScope: MEASUREMENT_CLAIM_SCOPE,
  modelKind: MEASUREMENT_MODEL_KIND,
})

const IEEE_TAG = '$isaBench.ieee754'
type IeeeTag = 'NaN' | '+Infinity' | '-Infinity' | '-0'

function ieeeTag(value: number): IeeeTag | null {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Infinity) return '+Infinity'
  if (value === -Infinity) return '-Infinity'
  if (Object.is(value, -0)) return '-0'
  return null
}

/** Encodes non-JSON IEEE-754 values as canonical reserved tag objects. */
export function encodeTaggedJson(value: unknown): unknown {
  if (typeof value === 'number') {
    const tag = ieeeTag(value)
    return tag ? { [IEEE_TAG]: tag } : value
  }
  if (Array.isArray(value)) return value.map(encodeTaggedJson)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      if (source[key] !== undefined) out[key] = encodeTaggedJson(source[key])
    }
    return out
  }
  return value
}

/** Decodes canonical IEEE-754 tags while leaving ordinary JSON unchanged. */
export function decodeTaggedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeTaggedJson)
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>
    const keys = Object.keys(source)
    if (keys.length === 1 && keys[0] === IEEE_TAG) {
      switch (source[IEEE_TAG]) {
        case 'NaN': return Number.NaN
        case '+Infinity': return Infinity
        case '-Infinity': return -Infinity
        case '-0': return -0
      }
    }
    return Object.fromEntries(
      keys.map((key) => [key, decodeTaggedJson(source[key])]),
    )
  }
  return value
}

/** Parses tagged or ordinary JSON. */
export function parseTaggedJson(text: string): unknown {
  return decodeTaggedJson(JSON.parse(text) as unknown)
}

/** Deterministic compact tagged serialization with sorted object keys. */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(encodeTaggedJson(value))
}

/** Deterministic pretty tagged serialization with sorted object keys. */
export function stablePrettySerialize(value: unknown): string {
  return JSON.stringify(encodeTaggedJson(value), null, 2)
}

/**
 * Small deterministic, non-cryptographic FNV-1a fingerprint.
 * The name deliberately does not imply cryptographic integrity.
 */
export function fingerprint(value: unknown): string {
  const bytes = new TextEncoder().encode(stableSerialize(value))
  let hash = 0x811c9dc5
  for (const byte of bytes) {
    hash ^= byte
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`
}
