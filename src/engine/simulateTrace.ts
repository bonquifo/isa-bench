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
 * **One microarchitecture for every instruction set.** The lowering path
 * adds per-ISA timing adjustments -- a load delay for MIPS, a branch bubble
 * for SPARC, a decode penalty for long x86 encodings -- because its invented
 * instruction streams have no other way to carry those traits. A real
 * stream carries them itself: a delay slot is an instruction that retires,
 * and a long encoding costs fetch bandwidth. So none of those adjustments
 * applies here, and every target is timed on exactly the pipeline the
 * profile describes. Energy likewise uses no per-ISA factor.
 *
 * Scope: one core, one thread. The multi-worker and coherence modelling in
 * `simulate()` is tied to the SPMD workloads the pseudo-backends generate,
 * and the real-ISA path has no SPMD story yet. `simulate()` is untouched and
 * still serves those.
 */
import { DramScheduler, SetCache } from './cache.ts'
import { energyOf } from './energy.ts'
import { normalizeHw } from './hardware.ts'
import { BranchPredictor } from './predictor.ts'
import {
  InstClass,
  type ExecutionCounts,
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

/**
 * Version of this model's rules, recorded with every real-ISA result so a
 * saved one says which rules produced it.
 *
 * 2: delay slots, conditional returns, host calls and window traps are
 * timed as what they are, and the lowering's per-ISA adjustments no longer
 * apply. Results made before carry no version.
 */
export const TRACE_TIMING_MODEL_VERSION = '2'

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
  const image = interpreter.image
  const delaySlotBytes = image.delaySlotBytes ?? 0
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
  let takenConditionalBranches = 0
  let directJumps = 0
  let calls = 0
  let returns = 0
  let indirectCalls = 0
  let indirectJumps = 0
  let rasMisses = 0
  let fetchedBytes = 0
  let decodedBytes = 0
  let icLineAccesses = 0
  let dcLineAccesses = 0
  let dramRequests = 0
  let dramQueueCycles = 0
  let loads = 0
  let stores = 0
  let memoryInstructions = 0
  let platformTraps = 0
  let codeFootprintBytes = 0
  const seenCode = new Set<number>()
  const disasm: string[] = []
  const disasmLimit = options.disasmLimit ?? 80

  /**
   * On a machine with delay slots, a return's own `nextPc` is its slot; the
   * return's real destination is the slot's `nextPc`, one entry later. The
   * prediction waits here until then. (The cast is because `popReturn`
   * sets it, and flow analysis does not follow a closure.)
   */
  let pendingReturn = null as { predicted: bigint | undefined } | null

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

  /** Requests every data line of a byte range; returns when all are in. */
  const requestRange = (address: number, bytes: number, at: number): { ready: number; lines: number } => {
    let latest = at
    const lines = dcache.lineAddresses(address, bytes)
    for (const line of lines) latest = Math.max(latest, requestLine(line, false, at))
    return { ready: latest, lines: lines.length }
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

  /** A redirect the front end could not have followed: refill the pipeline. */
  const redirect = (penalty: number): void => {
    fetchReady = Math.max(fetchReady, cycle + 1 + penalty)
  }

  /** Compares a predicted return address with where control really went. */
  const settleReturn = (predicted: bigint | undefined, actual: bigint): void => {
    if (predicted === undefined || predicted !== actual) {
      rasMisses += 1
      redirect(hw.indirectCallPenalty)
    }
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

      // A delayed return's destination is this instruction's successor.
      if (pendingReturn !== null) {
        settleReturn(pendingReturn.predicted, chunk.nextPc[i]!)
        pendingReturn = null
      }

      if (!seenCode.has(Number(pc))) {
        seenCode.add(Number(pc))
        codeFootprintBytes += inst.bytes
        if (disasm.length < disasmLimit) {
          disasm.push(`${pc.toString(16).padStart(8, '0')}  ${inst.mnemonic}`)
        }
      }

      const trapped = chunk.trapped[i] === 1
      // Dependencies: in-order issue waits for every register it touches.
      let dependency = 0
      for (const r of inst.reads) dependency = Math.max(dependency, ready[r]!)
      for (const r of inst.writes) dependency = Math.max(dependency, ready[r]!)
      const usesMemory = inst.readsMem || inst.writesMem
      if (dependency > cycle) advanceTo(dependency, 'dependency')
      if (fetchReady > cycle) advanceTo(fetchReady, 'fetch')
      if (usesMemory && memoryReady > cycle) advanceTo(memoryReady, 'memory')
      // A trap, like a serializing instruction, waits for everything older.
      if ((inst.serializing || trapped) && lastCompletion > cycle) {
        advanceTo(lastCompletion, 'serialization')
      }

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
      if (inst.readsMem) loads += 1
      if (inst.writesMem) stores += 1
      if (usesMemory) memoryInstructions += 1

      // Data access, at the width this execution reported: a push of two
      // return-address bytes is two bytes, whatever the opcode's usual one.
      let dataReady = cycle
      const width = chunk.accessWidth[i]!
      if (usesMemory && width > 0) {
        const address = Number(chunk.effAddr[i]!)
        for (const line of dcache.lineAddresses(address, width)) {
          dataReady = Math.max(dataReady, requestLine(line, false, cycle))
        }
      }
      // Memory the platform moved for this instruction: a whole repeated
      // string operation, or a window trap's save area. The ports move one
      // line each per cycle, so a long range occupies them accordingly.
      let bulkLines = 0
      const readBytes = chunk.bulkReadBytes[i]!
      if (readBytes > 0) {
        const range = requestRange(Number(chunk.bulkReadAddr[i]!), readBytes, cycle)
        dataReady = Math.max(dataReady, range.ready)
        bulkLines += range.lines
      }
      const writeBytes = chunk.bulkWriteBytes[i]!
      if (writeBytes > 0) {
        const range = requestRange(Number(chunk.bulkWriteAddr[i]!), writeBytes, cycle)
        dataReady = Math.max(dataReady, range.ready)
        bulkLines += range.lines
      }
      if (bulkLines > 0) {
        dataReady = Math.max(dataReady, cycle + Math.ceil(bulkLines / Math.max(1, hw.memPorts)))
      }

      const latency = latencyOf(inst, hw) + (hw.forwarding ? 0 : Math.max(0, hw.pipelineStages - 3))
      const completion = Math.max(cycle + latency, dataReady + latency)
      for (const r of inst.writes) ready[r] = completion
      if (usesMemory || bulkLines > 0) memoryReady = completion
      lastCompletion = Math.max(lastCompletion, completion)

      // A trap goes to a handler and comes back: two redirects the front
      // end cannot predict. The handler's own instructions are not
      // counted, because the reference does not execute them either.
      if (trapped) {
        platformTraps += 1
        redirect(2 * (1 + hw.mispredictPenalty))
      }

      // Control flow. Everything here is read off the trace: whether the
      // branch was taken and where an indirect jump went are facts, not
      // predictions the model has to make.
      const taken = chunk.taken[i] === 1
      const nextPc = chunk.nextPc[i]!
      const returnAddress = pc + BigInt(inst.bytes + delaySlotBytes)
      const pushReturn = (): void => {
        returnStack.push(returnStack.length < hw.rasDepth ? returnAddress : -1n)
      }
      const popReturn = (): void => {
        const predicted = returnStack.pop()
        if (delaySlotBytes > 0) pendingReturn = { predicted }
        else settleReturn(predicted, nextPc)
      }
      switch (inst.control) {
        case ControlKind.COND: {
          branches += 1
          conditionalBranches += 1
          if (taken) takenConditionalBranches += 1
          const target = Number(inst.staticTarget)
          const predicted = predictor.predict(Number(pc), target)
          predictor.update(Number(pc), taken)
          if (predicted !== taken) {
            mispredicts += 1
            redirect(hw.mispredictPenalty)
          }
          break
        }
        case ControlKind.COND_RET: {
          // Direction first, as for any conditional branch; its target is
          // not known in advance, so a static predictor guesses untaken.
          branches += 1
          conditionalBranches += 1
          const predicted = predictor.predict(Number(pc), Number(pc) + 1)
          predictor.update(Number(pc), taken)
          if (predicted !== taken) {
            mispredicts += 1
            redirect(hw.mispredictPenalty)
          }
          if (taken) {
            takenConditionalBranches += 1
            returns += 1
            popReturn()
          }
          break
        }
        case ControlKind.JUMP:
          directJumps += 1
          break
        case ControlKind.CALL: {
          calls += 1
          // A direct call has a known target; an indirect one costs a
          // redirect because the front end cannot follow it speculatively.
          if (inst.staticTarget === -1n) {
            indirectCalls += 1
            redirect(hw.indirectCallPenalty)
          }
          pushReturn()
          break
        }
        case ControlKind.RET:
          returns += 1
          popReturn()
          break
        case ControlKind.INDIRECT:
          indirectJumps += 1
          redirect(hw.indirectCallPenalty)
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
    decodeEnergyScale: 1,
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

  const executed: ExecutionCounts = {
    instructionBytes: fetchedBytes,
    loads,
    stores,
    memoryInstructions,
    conditionalBranches,
    takenConditionalBranches,
    calls,
    returns,
    indirectJumps,
    codeFootprintBytes,
    platformTraps,
  }

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
    calls: calls - indirectCalls,
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
    executed,
  }
}
