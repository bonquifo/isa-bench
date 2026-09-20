import { cpus, freemem, hostname, platform, release, totalmem, type, version } from 'node:os'
import { readFileSync } from 'node:fs'
import type { Identity } from './identity.js'
import { sha256 } from './identity.js'
import type { Availability, CapabilityManifest, Signed } from './types.js'
import type { HelperClient } from './measurement.js'

const unsupported = <T>(reason: string): Availability<T> => ({ status: 'unsupported', reason })
const failed = <T>(reason: string): Availability<T> => ({ status: 'probe-failed', reason })
const supported = <T>(value: T): Availability<T> => ({ status: 'supported', value })

export function inventoryCapabilities(
  identity: Identity,
  sequence: bigint,
  now = new Date(),
  ttlMs = 24 * 60 * 60_000,
): Signed<CapabilityManifest> {
  const cpuList = cpus()
  const machineMaterial = `${hostname()}\0${platform()}\0${type()}\0${cpuList[0]?.model ?? 'unknown'}`
  const linux = platform() === 'linux'
  const bootId = linux ? textProbe('/proc/sys/kernel/random/boot_id') : unsupported<string>('boot ID probe is Linux-only')
  const cpuInfo = linux ? optionalText('/proc/cpuinfo') : ''
  const memInfo = linux ? optionalText('/proc/meminfo') : ''
  const flags = cpuInfo.match(/^(?:flags|Features)\s*:\s*(.*)$/m)?.[1]?.trim().split(/\s+/) ?? []
  const field = (name: string): string => cpuInfo.match(new RegExp(`^${name}\\s*:\\s*(.*)$`, 'mi'))?.[1]?.trim() ?? 'unknown'
  const manifest: CapabilityManifest = {
    schemaVersion: '1',
    runnerId: identity.value.runnerId,
    sequence: sequence.toString(),
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    host: {
      os: supported({ platform: platform(), release: release(), version: version() }),
      arch: supported(process.arch),
      abi: unsupported('ABI requires helper build-target evidence'),
      kernel: supported(release()),
      bootId,
      machineHash: supported(sha256(machineMaterial)),
    },
    cpu: {
      identity: linux && ['cpu family', 'model', 'stepping', 'microcode'].every((name) => field(name) !== 'unknown') ? supported({
        family: field('cpu family'), model: field('model'), stepping: field('stepping'),
        microcode: field('microcode'),
      }) : unsupported('family/model/stepping/microcode require CPUID helper on Windows'),
      features: linux ? supported(flags) : unsupported('CPUID feature enumeration delegated to helper'),
      topology: unsupported(`package/NUMA/core/SMT/hybrid topology requires validated helper probe; ${cpuList.length} logical CPUs reported by OS`),
    },
    caches: unsupported('validated cache topology probe unavailable'),
    memory: unsupported(`complete memory/page/huge-page evidence unavailable; ${totalmem()} bytes reported by OS and HugePages_Total=${memInfo.match(/^HugePages_Total:\s*(\d+)/m)?.[1] ?? 'unknown'}`),
    firmware: unsupported('firmware type and Secure Boot need a platform-specific privileged probe'),
    frequency: unsupported(`governor/current frequency/turbo evidence requires helper; available governors=${readGlobGovernors().join(',') || 'unknown'}`),
    thermal: unsupported('no validated thermal sensor/throttle counter probe'),
    pmu: unsupported(`perf event groups not proven usable; perf_event_paranoid=${readInteger('/proc/sys/kernel/perf_event_paranoid') ?? 'unknown'}`),
    energy: unsupported('no readable RAPL powercap/perf domain proven'),
    container: containerProbe(),
    clock: unsupported('clock requires validated helper probe'),
  }
  void freemem()
  return identity.sign(manifest, now)
}

export async function inventoryCapabilitiesWithHelper(identity: Identity, sequence: bigint, helper: HelperClient, now = new Date()): Promise<Signed<CapabilityManifest>> {
  const base = inventoryCapabilities(identity, sequence, now).payload
  const probe = async (request: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try { return await helper.request(request) } catch (error) { return { supported: false, reason: error instanceof Error ? error.message : String(error), failed: true } }
  }
  const [inventory, rapl, thermal, clock] = await Promise.all([
    probe({ operation: 'inventory' }), probe({ operation: 'rapl-discover' }),
    probe({ operation: 'thermal-frequency' }), probe({ operation: 'clock' }),
  ])
  base.energy = rapl.supported === true && Array.isArray(rapl.domains) && rapl.domains.length > 0
    ? supported({ raplDomains: rapl.domains, sensors: [] })
    : availabilityFailure(rapl, 'no readable RAPL domains')
  base.thermal = thermal.supported === true && Array.isArray(thermal.temperatureSensors) && thermal.temperatureSensors.length > 0 &&
      thermal.temperatureSensors.every((item) => typeof item === 'string') && typeof thermal.throttleEvidence === 'boolean'
    ? supported({ sensors: thermal.temperatureSensors as string[], throttleEvidence: thermal.throttleEvidence })
    : availabilityFailure(thermal, 'thermal/throttle evidence unavailable')
  base.clock = clock.monotonic === true && typeof clock.source === 'string'
    ? supported({ source: clock.source, synchronized: null, evidence: 'raw monotonic source verified; external synchronization not asserted' })
    : availabilityFailure(clock, 'raw monotonic clock unavailable')
  if (inventory.supported !== true) base.host.os = availabilityFailure(inventory, 'helper inventory unavailable')
  if (inventory.supported === true && typeof inventory.arch === 'string' && typeof inventory.abi === 'string') {
    base.host.arch = supported(inventory.arch)
    base.host.abi = inventory.abi === 'unknown' ? unsupported('helper target ABI unknown') : supported(inventory.abi)
  }
  const cpuIdentity = asObject(inventory.cpuIdentity)
  base.cpu.identity = cpuIdentity.supported === true && ['family','model','stepping'].every((key) => typeof cpuIdentity[key] === 'string')
    ? supported({ family: String(cpuIdentity.family), model: String(cpuIdentity.model), stepping: String(cpuIdentity.stepping), microcode: typeof cpuIdentity.microcode === 'string' ? cpuIdentity.microcode : null })
    : availabilityFailure(cpuIdentity, 'validated CPU identity unavailable')
  const cpuFeatures = asObject(inventory.cpuFeatures)
  base.cpu.features = cpuFeatures.supported === true && Array.isArray(cpuFeatures.values) && cpuFeatures.values.every((value) => typeof value === 'string')
    ? supported(cpuFeatures.values as string[]) : availabilityFailure(cpuFeatures, 'validated CPU features unavailable')
  const topology = asObject(inventory.topology)
  base.cpu.topology = topology.supported === true && ['packages','numaNodes','physicalCores','logicalCpus'].every((key) => Number.isSafeInteger(topology[key])) &&
      typeof topology.smt === 'boolean' && typeof topology.hybrid === 'boolean'
    ? supported({ packages: Number(topology.packages), numaNodes: Number(topology.numaNodes), physicalCores: Number(topology.physicalCores), logicalCpus: Number(topology.logicalCpus), smt: topology.smt, hybrid: topology.hybrid })
    : availabilityFailure(topology, 'validated CPU topology unavailable')
  return identity.sign(base, now)
}

function availabilityFailure<T>(probe: Record<string, unknown>, fallback: string): Availability<T> {
  return { status: probe.failed === true ? 'probe-failed' : 'unsupported', reason: typeof probe.reason === 'string' ? probe.reason : fallback }
}
function asObject(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function textProbe(path: string): Availability<string> {
  try { return supported(readFileSync(path, 'utf8').trim()) } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EACCES' ? { status: 'permission-denied', reason: `${path}: permission denied` } : failed(`${path}: ${code ?? 'read failed'}`)
  }
}
function optionalText(path: string): string {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}
function readInteger(path: string): number | null {
  const value = Number(optionalText(path).trim())
  return Number.isInteger(value) ? value : null
}
function readGlobGovernors(): string[] {
  const value = optionalText('/sys/devices/system/cpu/cpu0/cpufreq/scaling_available_governors')
  return value.trim() ? value.trim().split(/\s+/) : []
}
function containerProbe(): Availability<{ runtime: string; version: string }> {
  if (optionalText('/proc/1/cgroup').match(/docker|containerd|podman|kubepods/)) {
    return supported({ runtime: 'detected-cgroup-container', version: 'unknown' })
  }
  return unsupported('no container runtime detected without executing external commands')
}
