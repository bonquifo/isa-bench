import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MeasurementHelperClient, parseHelperRunResponse, sha256 } from '../src/index.js'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

describe('built helper test-only roundtrip', () => {
  it('consumes iterations and validates the nonce/corpus oracle frame', async () => {
    const suffix = process.platform === 'win32' ? '.exe' : ''
    const helper = resolve(import.meta.dirname, `../../crates/measurement-helper/target/debug/measurement-helper${suffix}`)
    const fixtureSource = resolve(import.meta.dirname, `../../crates/measurement-helper/target/debug/measurement-test-fixture${suffix}`)
    expect(statSync(helper).isFile()).toBe(true)
    expect(statSync(fixtureSource).isFile()).toBe(true)
    const root = mkdtempSync(join(tmpdir(), 'measurement-fixture-'))
    roots.push(root)
    const fixture = join(root, basename(fixtureSource))
    cpSync(fixtureSource, fixture)
    const corpusId = 'testOnly:busy-oracle-v1'
    const client = new MeasurementHelperClient(helper, sha256(readFileSync(helper)), 10_000, root)
    const response = parseHelperRunResponse(await client.request({
      operation: 'run',
      binary: { path: fixture, sha256: sha256(readFileSync(fixture)), size: statSync(fixture).size.toString(), corpusId },
      argv: [], iterations: '700', cpus: [0], timeoutMs: 5_000,
      jobNonce: Buffer.alloc(32, 7).toString('base64'), corpusIdentity: sha256(corpusId), adapters: ['optional:rapl-powercap'],
    }))
    expect(BigInt(response.monotonicStartedNs)).toBeGreaterThan(0n)
    expect(BigInt(response.monotonicDurationNs)).toBeGreaterThan(0n)
    expect(response.oraclePassed).toBe(true)
    expect(response.oracleDetail).toContain('iterations=700')
    expect(BigInt(response.userCpuNs) + BigInt(response.systemCpuNs)).toBeGreaterThan(0n)
    expect(response.affinity.effective).toEqual([0])
    expect(response.valid).toBe(true)
    expect(response.validityReasons).toEqual([])
    expect(response.adapterStatus).toContainEqual(expect.objectContaining({adapter:'rapl-powercap',required:false}))
    expect(response.energy).toContainEqual(expect.objectContaining({adapter:'rapl-powercap'}))
    const idle=parseHelperRunResponse(await client.request({operation:'idle',durationNs:'1000000',cpus:[0],adapters:['optional:rapl-powercap']}))
    expect(idle.affinity).toEqual({requested:[0],effective:[0]})
    expect(idle.valid).toBe(true)
    expect(idle.energy).toContainEqual(expect.objectContaining({adapter:'rapl-powercap',supported:false}))
    expect(idle.adapterStatus).toContainEqual(expect.objectContaining({adapter:'rapl-powercap',required:false,supported:false}))
  })

  it('distinguishes ignored iterations, malformed output, signal, timeout, and output cap', async () => {
    const suffix = process.platform === 'win32' ? '.exe' : ''
    const helper = resolve(import.meta.dirname, `../../crates/measurement-helper/target/debug/measurement-helper${suffix}`)
    const fixtureSource = resolve(import.meta.dirname, `../../crates/measurement-helper/target/debug/measurement-test-fixture${suffix}`)
    const root = mkdtempSync(join(tmpdir(), 'measurement-failures-')); roots.push(root)
    const fixture = join(root, basename(fixtureSource)); cpSync(fixtureSource, fixture)
    const corpusId = 'testOnly:failure-modes-v1'
    const client = new MeasurementHelperClient(helper, sha256(readFileSync(helper)), 15_000, root)
    const run = async (mode: string, timeoutMs = 5_000, rest: string[] = []) => parseHelperRunResponse(await client.request({
      operation: 'run', binary: { path: fixture, sha256: sha256(readFileSync(fixture)), size: statSync(fixture).size.toString(), corpusId },
      argv: [mode,...rest], iterations: '3', cpus: [0], timeoutMs,
      jobNonce: Buffer.alloc(32, 3).toString('base64'), corpusIdentity: sha256(corpusId), adapters: [],
    }))
    expect((await run('ignore')).validityReasons).toContain('oracle-frame-invalid')
    expect((await run('malformed')).validityReasons).toContain('oracle-frame-invalid')
    expect((await run('signal')).signal ?? (await run('signal')).exitCode).not.toBeNull()
    expect((await run('timeout', 10)).timedOut).toBe(true)
    expect((await run('output')).validityReasons).toContain('output-cap-exceeded')
    const marker=join(root,'grandchild-marker')
    expect((await run('grandchild',5_000,[marker])).timedOut).toBe(false)
    await new Promise(resolveDelay=>setTimeout(resolveDelay,2_300))
    expect(()=>statSync(marker)).toThrow()
    const detachedMarker=join(root,'detached-grandchild-marker')
    await run('detached-grandchild',5_000,[detachedMarker])
    await new Promise(resolveDelay=>setTimeout(resolveDelay,2_300))
    expect(()=>statSync(detachedMarker)).toThrow()
    await expect(client.request({
      operation: 'run', binary: { path: fixture, sha256: sha256(readFileSync(fixture)), size: statSync(fixture).size.toString(), corpusId },
      argv: [], iterations: '1', cpus: [0], timeoutMs: 100, jobNonce: 'bad', corpusIdentity: sha256(corpusId), adapters: [],
    })).rejects.toThrow('nonce')
  },10_000)
})
