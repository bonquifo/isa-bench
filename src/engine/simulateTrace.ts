/**
 * Trace-driven in-order timing model.
 *
 * This is the other half of the split described in src/isa/common/trace.ts.
 * It consumes a `ProgramImage` and a stream of retired instructions and knows
 * nothing about what any instruction means: branch outcomes, indirect targets
 * and effective addresses arrive as facts, so there is no second copy of the
 * semantics here to drift away from the interpreter's.
 *
 * It shares the engine's existing infrastructure rather than reimplementing
 * it — `SetCache`, `DramScheduler`, `BranchPredictor`, `energyOf` and the
 * hardware profile are the same ones `simulate()` uses, so a comparison
 * between a pseudo-backend run and a real-ISA run is a comparison of the
 * programs and not of two different cache models.
 *
 * Scope: one core, one thread. The multi-worker and coherence modelling in
 * `simulate()` is tied to the SPMD workloads the pseudo-backends generate,
 * and the real-ISA path has no SPMD story yet. `simulate()` is untouched and
 * still serves those.
 */
import { DramScheduler, SetCache } from './cache.ts'
import { energyOf } from './energy.ts'
import { isaTiming, normalizeHw } from './hardware.ts'
import { BranchPredictor } from './predictor.ts'
import {
  InstClass,
  type HardwareProfile,
  type InstClass as InstClassT,
  type IsaId,
  type Metrics,
  type OperationOrigin as OperationOriginT,
} from './types.ts'
import {
  ControlKind,
  LatencyClass,
  RunState,
  createRetireChunk,
  type Interpreter,
  type StaticInst,
} from '../isa/common/trace.ts'

export interface TraceTimingOptions {
  /** Retired instructions pulled from the interpreter at a time. */
  chunkSize?: number
  /** Lines of disassembly to keep for the report pane. */
  disasmLimit?: number
}

const DEFAULT_CHUNK = 8192

function emptyMix(): Record<InstClassT, number> {
  return { alu: 0, mul: 0, div: 0, ld: 0, st: 0, br: 0, fp: 0, mov: 0, nop: 0 }
}

function latencyOf(inst: StaticInst, hw: HardwareProfile): number {
  switch (inst.latencyClass) {
    case LatencyClass.MUL:
      return hw.mulLatency
    case LatencyClass.DIV:
      return hw.divLatency
    case LatencyClass.FP_ADD:
      return hw.fpAddLatency
    case LatencyClass.FP_MUL:
      return hw.fpMulLatency
    case LatencyClass.FP_DIV:
      return hw.fpDivLatency
    case LatencyClass.LOAD:
      return hw.loadLatency
    default:
      return 1
  }
}

function portsOf(inst: StaticInst): { alu: number; mem: number } {
  if (inst.readsMem || inst.writesMem) return { alu: 0, mem: 1 }
  if (inst.cls === InstClass.BR || inst.cls === InstClass.NOP) return { alu: 0, mem: 0 }
  return { alu: 1, mem: 0 }
}

/**
 * Runs `interpreter` to completion, timing it against `rawHw`.
 *
 * The interpreter is driven here rather than beforehand so that a long run
 * never materialises its whole trace: chunks are refilled and consumed in
 * place.
 */
export function simulateTrace(
  interpreter: Interpreter,
  rawHw: HardwareProfile,
  isa: IsaId,
  options: TraceTimingOptions = {},
): Metrics {
  const hw = normalizeHw(rawHw)
  const timing = isaTiming(isa)
  const image = interpreter.image
  const icache = new SetCache(hw.l1i)
  const dcache = new SetCache(hw.l1d)
  const l2 = hw.l2.sizeBytes > 0 ? new SetCache(hw.l2) : null
  const l3 = hw.l3.sizeBytes > 0 ? new SetCache(hw.l3) : null
  const dram = new DramScheduler(hw.memChannels, hw.dramIssueInterval)
  const predictor = new BranchPredictor(hw)
  const mix = emptyMix()
  const origins: Record<OperationOriginT, number> = { semantic: 0, lowering: 0, runtime: 0 }

  // Ready cycle per architectural resource id, in the ISA's own numbering.
  const ready = new Float64Array(image.naming.count)
  const returnStack: bigint[] = []

  let cycle = 0
  let issueLeft = hw.issueWidth
  let aluLeft = hw.aluCount
  let memLeft = hw.memPorts
  let fetchLeft = hw.fetchWidth
  let fetchReady = 0
  let memoryReady = 0

  let instructions = 0
  let uops = 0
  let stalls = 0
  let zeroIssueCycles = 0
  let dependencyStallCycles = 0
  let fetchStallCycles = 0
  let resourceStallCycles = 0
  let memoryOrderStallCycles = 0
  let serializationStallCycles = 0
  let branches = 0
  let mispredicts = 0
  let conditionalBranches = 0
  let directJumps = 0
  let calls = 0
  let returns = 0
  let indirectCalls = 0
  let rasMisses = 0
  let fetchedBytes = 0
  let decodedBytes = 0
  let icLineAccesses = 0
  let dcLineAccesses = 0
  let dramRequests = 0
  let dramQueueCycles = 0
  const seenCode = new Set<number>()
  const disasm: string[] = []
  const disasmLimit = options.disasmLimit ?? 80

  /**
   * Walks one line request down the hierarchy and returns the cycle the data
   * is available. Deliberately the same shape as `simulate()`'s: a hit at any
   * level pays that level's latency, a miss allocates into every level above
   * the one that served it.
   */
  const requestLine = (addr: number, isFetch: boolean, at: number): number => {
    const l1 = isFetch ? icache : dcache
    const line = l1.lineAddress(addr)
    if (isFetch) icLineAccesses += 1
    else dcLineAccesses += 1
    if (l1.lookup(line)) return at
    const fills: SetCache[] = [l1]
    let available: number | undefined
    if (l2) {
      if (l2.lookup(line)) available = at + hw.l2Latency
      else fills.push(l2)
    }
    if (available === undefined && l3) {
      if (l3.lookup(line)) available = at + hw.l3Latency
      else fills.push(l3)
    }
    if (available === undefined) {
      const request = dram.request(at, hw.memLatency)
      dramQueueCycles += request.queueCycles
      dramRequests += 1
      available = request.ready
    }
    for (const cache of fills) cache.fill(line)
    return available
  }

  const advanceTo = (target: number, cause: 'dependency' | 'fetch' | 'resource' | 'memory' | 'serialization'): void => {
    if (target <= cycle) return
    const skipped = target - cycle
    stalls += skipped
    zeroIssueCycles += skipped
    if (cause === 'fetch') fetchStallCycles += skipped
    else if (cause === 'memory') memoryOrderStallCycles += skipped
    else if (cause === 'serialization') serializationStallCycles += skipped
    else if (cause === 'dependency') dependencyStallCycles += skipped
    else resourceStallCycles += skipped
    cycle = target
    issueLeft = hw.issueWidth
    aluLeft = hw.aluCount
    memLeft = hw.memPorts
    fetchLeft = hw.fetchWidth
  }

  const nextCycle = (cause: 'resource' | 'serialization'): void => {
    advanceTo(cycle + 1, cause)
  }

  const chunk = createRetireChunk(options.chunkSize ?? DEFAULT_CHUNK)
  let state: RunState = RunState.MORE
  /** Completion cycle of the last instruction, so the run length is honest. */
  let lastCompletion = 0

  while (state === RunState.MORE) {
    state = interpreter.run(chunk)
    for (let i = 0; i < chunk.count; i++) {
      const pc = chunk.pc[i]!
      const inst = image.at(pc)

      if (!seenCode.has(Number(pc))) {
        seenCode.add(Number(pc))
        if (disasm.length < disasmLimit) {
          disasm.push(`${pc.toString(16).padStart(8, '0')}  ${inst.mnemonic}`)
        }
      }

      // Dependencies: in-order issue waits for every register it touches.
      let dependency = 0
      for (const r of inst.reads) dependency = Math.max(dependency, ready[r]!)
      for (const r of inst.writes) dependency = Math.max(dependency, ready[r]!)
      const usesMemory = inst.readsMem || inst.writesMem
      if (dependency > cycle) advanceTo(dependency, 'dependency')
      if (fetchReady > cycle) advanceTo(fetchReady, 'fetch')
      if (usesMemory && memoryReady > cycle) advanceTo(memoryReady, 'memory')
      if (inst.serializing && lastCompletion > cycle) advanceTo(lastCompletion, 'serialization')

      // Instruction fetch. A line that is not resident delays the whole
      // front end, which is why this happens before the width checks.
      let front = cycle
      for (const line of icache.lineAddresses(Number(pc), inst.bytes)) {
        front = Math.max(front, requestLine(line, true, cycle))
      }
      if (front > cycle) {
        fetchReady = front
        advanceTo(front, 'fetch')
      }

      const ports = portsOf(inst)
      const cost = Math.min(Math.max(1, inst.uops), hw.issueWidth)
      while (
        issueLeft < cost || aluLeft < ports.alu || memLeft < ports.mem ||
        (fetchLeft < inst.bytes && fetchLeft < hw.fetchWidth)
      ) {
        nextCycle('resource')
      }

      issueLeft -= cost
      aluLeft -= ports.alu
      memLeft -= ports.mem
      fetchLeft -= inst.bytes
      fetchedBytes += inst.bytes
      decodedBytes += inst.bytes
      mix[inst.cls] += 1
      origins[inst.origin] += 1
      instructions += 1
      uops += inst.uops

      if (inst.bytes >= hw.complexDecodeBytes && timing.decodeOverhead > 0) {
        fetchReady = Math.max(fetchReady, cycle + 1 + timing.decodeOverhead)
      }

      // Data access.
      let dataReady = cycle
      if (usesMemory && inst.accessWidth > 0) {
        const address = Number(chunk.effAddr[i]!)
        for (const line of dcache.lineAddresses(address, inst.accessWidth)) {
          dataReady = Math.max(dataReady, requestLine(line, false, cycle))
        }
      }

      let latency = latencyOf(inst, hw)
      if (timing.loadDelay > 0 && inst.readsMem) latency += timing.loadDelay
      if (!hw.forwarding) latency += Math.max(0, hw.pipelineStages - 3)
      const completion = Math.max(cycle + latency, dataReady + latency)
      for (const r of inst.writes) ready[r] = completion
      if (usesMemory) memoryReady = completion
      lastCompletion = Math.max(lastCompletion, completion)

      // Control flow. Everything here is read off the trace: whether the
      // branch was taken and where an indirect jump went are facts, not
      // predictions the model has to make.
      const taken = chunk.taken[i] === 1
      const nextPc = chunk.nextPc[i]!
      switch (inst.control) {
        case ControlKind.COND: {
          branches += 1
          conditionalBranches += 1
          const target = Number(inst.staticTarget)
          const predicted = predictor.predict(Number(pc), target)
          predictor.update(Number(pc), taken)
          if (predicted !== taken) {
            mispredicts += 1
            fetchReady = Math.max(fetchReady, cycle + 1 + hw.mispredictPenalty + timing.branchDelay)
          } else if (timing.branchDelay > 0) {
            fetchReady = Math.max(fetchReady, cycle + 1 + timing.branchDelay)
          }
          break
        }
        case ControlKind.JUMP:
          directJumps += 1
          if (timing.branchDelay > 0) {
            fetchReady = Math.max(fetchReady, cycle + 1 + timing.branchDelay)
          }
          break
        case ControlKind.CALL: {
          // A direct call has a known target; an indirect one costs a
          // redirect because the front end cannot follow it speculatively.
          const direct = inst.staticTarget !== -1n
          if (direct) calls += 1
          else {
            indirectCalls += 1
            fetchReady = Math.max(fetchReady, cycle + 1 + hw.indirectCallPenalty)
          }
          if (returnStack.length < hw.rasDepth) returnStack.push(pc + BigInt(inst.bytes))
          else returnStack.push(-1n)
          if (timing.branchDelay > 0) {
            fetchReady = Math.max(fetchReady, cycle + 1 + timing.branchDelay)
          }
          break
        }
        case ControlKind.RET: {
          returns += 1
          const predictedReturn = returnStack.pop()
          if (predictedReturn === undefined || predictedReturn !== nextPc) {
            rasMisses += 1
            fetchReady = Math.max(fetchReady, cycle + 1 + hw.indirectCallPenalty + timing.branchDelay)
          } else if (timing.branchDelay > 0) {
            fetchReady = Math.max(fetchReady, cycle + 1 + timing.branchDelay)
          }
          break
        }
        case ControlKind.INDIRECT:
          indirectCalls += 1
          fetchReady = Math.max(fetchReady, cycle + 1 + hw.indirectCallPenalty + timing.branchDelay)
          break
        default:
          break
      }
    }
  }

  // The run is not over until the last instruction has completed.
  const cycles = Math.max(cycle + 1, lastCompletion)
  const timeUs = cycles / hw.clockMhz
  const opsPerCycle = cycles === 0 ? 0 : instructions / cycles
  const cyclesPerOp = instructions === 0 ? 0 : cycles / instructions

  const energy = energyOf({
    isa,
    mix,
    operationOrigins: origins,
    decodedBytes,
    icLineAccesses,
    dcLineAccesses,
    l2Hits: l2?.hits ?? 0,
    l2Misses: l2?.misses ?? 0,
    l3Hits: l3?.hits ?? 0,
    l3Misses: l3?.misses ?? 0,
    dramRequests,
    coherenceTransfers: 0,
    coherenceInvalidations: 0,
    mispredicts,
    timeUs,
    activeCoreCycles: cycles,
    stalledCoreCycles: 0,
    idleCoreCycles: cycles * (hw.cores - 1),
    clockMhz: hw.clockMhz,
    staticPowerMw: hw.staticPowerMw,
  })

  return {
    isa,
    hardwareId: hw.id,
    hardwareName: hw.name,
    result: interpreter.exitCode,
    matchedGold: false,
    instructions,
    uops,
    cycles,
    cpi: cyclesPerOp,
    ipc: opsPerCycle,
    aggregateModeledOpsPerCycle: opsPerCycle,
    modelCyclesPerAggregateOp: cyclesPerOp,
    codeBytes: image.codeBytes,
    clockMhz: hw.clockMhz,
    timeUs,
    icHits: icache.hits,
    icMisses: icache.misses,
    dcHits: dcache.hits,
    dcMisses: dcache.misses,
    branches,
    mispredicts,
    stalls,
    mix,
    dynamicEnergyNj: energy.dynamicEnergyNj,
    staticEnergyNj: energy.staticEnergyNj,
    totalEnergyNj: energy.totalEnergyNj,
    edp: energy.edp,
    operationDecodeEnergyNj: energy.operationDecodeEnergyNj,
    cacheEnergyNj: energy.cacheEnergyNj,
    memoryCoherenceEnergyNj: energy.memoryCoherenceEnergyNj,
    recoveryEnergyNj: energy.recoveryEnergyNj,
    nominalModelEnergyNj: energy.nominalModelEnergyNj,
    modeledEdpNjUs: energy.modeledEdpNjUs,
    energyModelClass: energy.energyModelClass,
    energyUncertainty: energy.energyUncertainty,
    spillSlots: 0,
    disasm,
    cores: hw.cores,
    threads: hw.threads,
    activeThreads: 1,
    busyCores: 1,
    coresThatIssued: 1,
    l2Hits: l2?.hits ?? 0,
    l2Misses: l2?.misses ?? 0,
    l3Hits: l3?.hits ?? 0,
    l3Misses: l3?.misses ?? 0,
    stdout: new TextDecoder().decode(interpreter.stdout()),
    issuedOperations: instructions,
    completedOperations: instructions,
    issuedUops: uops,
    completedUops: uops,
    operationOrigins: origins,
    zeroIssueCycles,
    dependencyStallCycles,
    fetchStallCycles,
    resourceStallCycles,
    memoryOrderStallCycles,
    serializationStallCycles,
    conditionalBranches,
    directJumps,
    calls,
    returns,
    indirectCalls,
    rasMisses,
    fetchedBytes,
    decodedBytes,
    icLineAccesses,
    dcLineAccesses,
    dramRequests,
    dramQueueCycles,
    coherenceTransfers: 0,
    coherenceInvalidations: 0,
    activeCoreCycles: cycles,
    stalledCoreCycles: 0,
    idleCoreCycles: cycles * (hw.cores - 1),
    averageActiveCores: 1,
    averageStalledCores: 0,
  }
}
