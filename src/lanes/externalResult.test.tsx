import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BackendClient } from '../ui/backendClient.ts'
import { ExternalReport } from './ExternalLane.tsx'
import { externalClaim, parseExternalResult } from './externalResult.ts'

const H = 'a'.repeat(64)
const envelope = {
  schemaVersion: '1.0.0', modelVersion: 'gem5-25.1.0.0', adapterVersion: '1.0.0',
  experimentKind: 'gem5', claimClass: 'external-simulation', evidenceClass: 'external-simulator-output',
  inputIdentity: H, artifactIdentities: [H], comparisonGroupKey: H,
  comparison: {
    experimentKind: 'gem5', modelVersion: 'gem5-25.1.0.0', workloadSemanticHash: H,
    artifactPipelineHash: H, roiDefinitionHash: H, profileConfigFingerprint: H,
    metricDomain: 'external-simulator-cycles', unit: 'sim-cycle',
  },
  createdAt: '2026-08-27T00:00:00.000Z',
  simulator: { name: 'gem5', version: '25.1.0.0', invocation: ['gem5.opt'] },
  metrics: [{ name: 'simulated_cycles', domain: 'external-simulator-cycles', unit: 'sim-cycle', value: '42' }],
  rawOutputArtifact: { id: H, sha256: H, byteSize: '20', mimeType: 'application/json', role: 'result', filename: 'gem5-raw.json' },
  target: { triple: 'x86_64-unknown-linux-gnu', abi: 'SysV AMD64', endianness: 'little', addressWidth: 64 },
  configuration: { cpu: 'O3' }, diagnostics: ['host duration excluded'],
} as const

describe('external direct result envelope', () => {
  it('accepts the direct worker result and rejects obsolete wrappers', () => {
    expect(parseExternalResult(envelope).metrics[0]?.value).toBe('42')
    expect(() => parseExternalResult({ envelope })).toThrow()
    expect(externalClaim(parseExternalResult(envelope))).toContain('external simulation')
  })
  it('renders metrics, provenance, diagnostics, raw download, and evidence badge', () => {
    const html = renderToStaticMarkup(<ExternalReport client={new BackendClient('http://127.0.0.1:4317')} value={envelope} />)
    for (const text of ['42', 'sim-cycle', 'gem5', 'ROI', 'host duration excluded', 'DOWNLOAD RAW OUTPUT', 'EXTERNAL SIMULATOR']) expect(html).toContain(text)
  })
  it('renders proof badges only for strict verified proof fields', () => {
    const hash = 'b'.repeat(64)
    const proven = {
      ...envelope,
      proof: {
        signatureVerified: true,
        signatureVerifier: 'ed25519-verifier-v1',
        signatureIdentityHash: hash,
        attestationVerified: true,
        attestationType: 'runner-manifest',
        attestationVerifier: 'runner-policy-v1',
        attestationEvidenceHash: hash,
      },
    }
    const html = renderToStaticMarkup(<ExternalReport client={new BackendClient()} value={proven} />)
    expect(html).toContain('SIGNED')
    expect(html).toContain('ATTESTED')
    const forged = renderToStaticMarkup(<ExternalReport client={new BackendClient()} value={{
      ...envelope,
      proof: { signatureVerified: true, signatureVerifier: 'verifier', signatureIdentityHash: 'forged' },
    }} />)
    expect(forged).toContain('INVALID EXTERNAL RESULT ENVELOPE')
    expect(forged).not.toContain('>SIGNED<')
  })
})
