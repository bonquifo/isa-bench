import { cache, cpu, type CpuModel } from './cpus_build.ts'

const G = {
  interp: 'WASM · interpreters',
  baseline: 'WASM · baseline / mid-tier',
  opt: 'WASM · optimizing JITs',
} as const

export const WASM_CPUS: CpuModel[] = [
  cpu('wasm-interp', 'WASM interpreter', 'Spec / engines', 2017, 'wasm', 'Naive one-op-at-a-time engine, no JIT.', {
    clockMhz: 400, issueWidth: 1, pipelineStages: 3, fetchWidth: 8,
    l1i: cache(8192, 2), l1d: cache(8192, 2), memLatency: 8, predictor: 'none', predEntries: 8, mispredictPenalty: 1, staticPowerMw: 20,
  }, G.interp),
  cpu('wasm3', 'wasm3', 'wasm3', 2019, 'wasm', 'Register-based interpreter, tiny embeddable.', {
    clockMhz: 600, issueWidth: 1, pipelineStages: 3, fetchWidth: 8,
    l1i: cache(8192, 2), l1d: cache(8192, 2), memLatency: 8, predictor: 'none', predEntries: 8, mispredictPenalty: 1, staticPowerMw: 25,
  }, G.interp),
  cpu('wamr-interp', 'WAMR classic interpreter', 'Bytecode Alliance', 2019, 'wasm', 'iwasm walk-the-bytecode, MCU friendly.', {
    clockMhz: 500, issueWidth: 1, pipelineStages: 3, fetchWidth: 8,
    l1i: cache(8192, 2), l1d: cache(8192, 2), memLatency: 8, predictor: 'none', predEntries: 8, mispredictPenalty: 1, staticPowerMw: 18,
  }, G.interp),
  cpu('wamr-fast', 'WAMR fast interpreter', 'Bytecode Alliance', 2020, 'wasm', 'Pre-decoded labels, still no JIT.', {
    clockMhz: 900, issueWidth: 1, pipelineStages: 4, fetchWidth: 8,
    l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 10, predictor: 'static', predEntries: 16, mispredictPenalty: 2, staticPowerMw: 40,
  }, G.interp),
  cpu('wizard', 'Wizard engine', 'Wizard / research', 2022, 'wasm', 'Research interpreter with instrumentation hooks.', {
    clockMhz: 700, issueWidth: 1, pipelineStages: 4, fetchWidth: 8,
    l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 10, predictor: 'static', predEntries: 16, mispredictPenalty: 2, staticPowerMw: 30,
  }, G.interp),

  cpu('wasm-liftoff', 'V8 Liftoff', 'Google', 2018, 'wasm', 'Single-pass baseline compiler, fast startup.', {
    clockMhz: 1800, issueWidth: 1, pipelineStages: 6, fetchWidth: 16,
    l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 25, predEntries: 128, staticPowerMw: 200,
  }, G.baseline),
  cpu('wasm-winch', 'SpiderMonkey Winch', 'Mozilla', 2023, 'wasm', 'Single-pass baseline (Firefox).', {
    clockMhz: 1800, issueWidth: 1, pipelineStages: 6, fetchWidth: 16,
    l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 25, predEntries: 128, staticPowerMw: 190,
  }, G.baseline),
  cpu('sm-baseline', 'SpiderMonkey Baseline', 'Mozilla', 2013, 'wasm', 'Older JS/wasm baseline ICs.', {
    clockMhz: 1600, issueWidth: 1, pipelineStages: 6, fetchWidth: 16,
    l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 22, predEntries: 64, staticPowerMw: 160,
  }, G.baseline),
  cpu('jsc-bbq', 'JSC BBQ', 'Apple', 2017, 'wasm', 'JavaScriptCore Build Bytecode Quickly.', {
    clockMhz: 1700, issueWidth: 1, pipelineStages: 6, fetchWidth: 16,
    l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 24, predEntries: 128, staticPowerMw: 180,
  }, G.baseline),
  cpu('wasmer-singlepass', 'Wasmer Singlepass', 'Wasmer', 2019, 'wasm', 'Single-pass compiler, bounded compile time.', {
    clockMhz: 2000, issueWidth: 1, pipelineStages: 6, fetchWidth: 16,
    l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 24, predEntries: 128, staticPowerMw: 210,
  }, G.baseline),
  cpu('wasm-cranelift', 'Wasmtime Cranelift', 'Bytecode Alliance', 2018, 'wasm', 'SSA mid-tier JIT used by Wasmtime/Firefox.', {
    clockMhz: 2400, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 400,
  }, G.baseline),
  cpu('lucet', 'Lucet / Cranelift AOT', 'Fastly', 2018, 'wasm', 'AOT Cranelift for edge (Terrarium era).', {
    clockMhz: 2400, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 380,
  }, G.baseline),

  cpu('wasm-turbofan', 'V8 TurboFan', 'Google', 2015, 'wasm', 'Optimizing compiler tier, host-like throughput.', {
    clockMhz: 3200, issueWidth: 4, pipelineStages: 12, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 70, predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 800,
  }, G.opt),
  cpu('v8-maglev', 'V8 Maglev', 'Google', 2022, 'wasm', 'Mid-tier optimizing compiler (JS/wasm path).', {
    clockMhz: 2800, issueWidth: 3, pipelineStages: 10, fetchWidth: 24, aluCount: 2, memPorts: 1,
    l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 50, predEntries: 1024, mispredictPenalty: 10, staticPowerMw: 550,
  }, G.opt),
  cpu('sm-ion', 'SpiderMonkey Ion', 'Mozilla', 2013, 'wasm', 'IonMonkey optimizing JIT.', {
    clockMhz: 3000, issueWidth: 3, pipelineStages: 11, fetchWidth: 24, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 65, predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 700,
  }, G.opt),
  cpu('jsc-omg', 'JSC OMG', 'Apple', 2017, 'wasm', 'JavaScriptCore Optimize Magically (B3/Air).', {
    clockMhz: 3100, issueWidth: 4, pipelineStages: 12, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 68, predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 750,
  }, G.opt),
  cpu('wasmedge', 'WasmEdge LLVM', 'CNCF', 2020, 'wasm', 'AOT/JIT via LLVM, cloud-native runtime.', {
    clockMhz: 3200, issueWidth: 4, pipelineStages: 12, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 70, predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 820,
  }, G.opt),
  cpu('wavm', 'WAVM', 'WAVM', 2018, 'wasm', 'LLVM-based standalone VM, high throughput.', {
    clockMhz: 3300, issueWidth: 4, pipelineStages: 12, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 70, predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 850,
  }, G.opt),
  cpu('wamr-aot', 'WAMR LLVM AOT', 'Bytecode Alliance', 2020, 'wasm', 'Ahead-of-time LLVM for iwasm.', {
    clockMhz: 3000, issueWidth: 4, pipelineStages: 11, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 65, predEntries: 2048, mispredictPenalty: 11, staticPowerMw: 700,
  }, G.opt),
  cpu('wasmer-llvm', 'Wasmer LLVM', 'Wasmer', 2019, 'wasm', 'Wasmer backend via LLVM IR.', {
    clockMhz: 3200, issueWidth: 4, pipelineStages: 12, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 70, predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 830,
  }, G.opt),
]
