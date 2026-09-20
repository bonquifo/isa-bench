import { i32 } from './bits.ts';
import { readGuestStdout } from './guestio.ts';
import { checkMemoryAccess, evalBin, evalCond, virtDef, virtUses, } from './ir.ts';
import { C_PARK_BYTES, C_STACK_BASE, C_STACK_STRIDE, MAX_HW_THREADS, } from './types.ts';
export const IR_REFERENCE_MODEL_VERSION = 'ir-reference-2.0.0';
export function isParallelIr(prog) {
    return prog.insts.some((ins) => ins.kind === 'tid' || ins.kind === 'nthreads');
}
/**
 * ISA-independent deterministic IR oracle. One runnable instruction is
 * executed per thread in fixed round-robin order each round. Memory is shared;
 * registers and call stacks are private. Barriers use the initial participant
 * set and release only after every participant reaches the same epoch.
 */
export function interpretIrWorkers(prog, mem, requestedWorkers) {
    const workers = Math.max(1, Math.min(MAX_HW_THREADS, Math.trunc(requestedWorkers)));
    const maxReg = prog.insts.reduce((n, ins) => {
        const defined = virtDef(ins);
        return Math.max(n, defined, ...virtUses(ins));
    }, 0);
    const labels = new Map();
    prog.insts.forEach((ins, index) => {
        if (ins.kind === 'label')
            labels.set(ins.name, index);
    });
    const threads = Array.from({ length: workers }, (_, id) => ({
        id,
        pc: 0,
        regs: new Float64Array(maxReg + 1),
        calls: [],
        halted: false,
        result: 0,
        barrierEpoch: null,
    }));
    const view = new DataView(mem);
    const maxSteps = 100_000_000;
    const maxRoundsWithoutProgress = Math.max(1024, prog.insts.length * workers * 4);
    let steps = 0;
    let roundsWithoutProgress = 0;
    let epoch = 0;
    const target = (label) => {
        const pc = labels.get(label);
        if (pc === undefined)
            throw new Error(`Unknown label ${label}`);
        return pc;
    };
    const address = (thread, base, off, index = 0, scale = 0) => i32(thread.regs[base] + off + (scale ? thread.regs[index] * scale : 0));
    while (steps < maxSteps) {
        if (threads.every((thread) => thread.halted)) {
            return {
                value: threads[0].result,
                steps,
                stdout: readGuestStdout(mem),
                modelVersion: IR_REFERENCE_MODEL_VERSION,
                workers,
            };
        }
        let progress = false;
        for (const thread of threads) {
            if (thread.halted || thread.barrierEpoch !== null)
                continue;
            if (thread.pc < 0 || thread.pc >= prog.insts.length) {
                throw new Error(`IR reference PC ${thread.pc} is outside program for thread ${thread.id}`);
            }
            const ins = prog.insts[thread.pc];
            const regs = thread.regs;
            steps += 1;
            progress = true;
            switch (ins.kind) {
                case 'label':
                    thread.pc += 1;
                    break;
                case 'imm':
                    regs[ins.dst] = i32(ins.value);
                    thread.pc += 1;
                    break;
                case 'immf':
                    regs[ins.dst] = ins.value;
                    thread.pc += 1;
                    break;
                case 'mov':
                    regs[ins.dst] = regs[ins.src];
                    thread.pc += 1;
                    break;
                case 'convert':
                    regs[ins.dst] = ins.op === 'itod'
                        ? i32(regs[ins.src])
                        : ins.op === 'i8'
                            ? (i32(regs[ins.src]) << 24) >> 24
                            : i32(Math.trunc(regs[ins.src]));
                    thread.pc += 1;
                    break;
                case 'binop':
                    regs[ins.dst] = evalBin(ins.op, regs[ins.a], regs[ins.b]);
                    thread.pc += 1;
                    break;
                case 'addi':
                    regs[ins.dst] = i32(regs[ins.a] + ins.imm);
                    thread.pc += 1;
                    break;
                case 'ldb': {
                    const at = address(thread, ins.base, ins.off);
                    checkMemoryAccess('IR reference ldb', at, 1, mem.byteLength);
                    regs[ins.dst] = view.getInt8(at);
                    thread.pc += 1;
                    break;
                }
                case 'ldw': {
                    const at = address(thread, ins.base, ins.off);
                    checkMemoryAccess('IR reference ldw', at, 4, mem.byteLength);
                    regs[ins.dst] = view.getInt32(at, true);
                    thread.pc += 1;
                    break;
                }
                case 'ldd': {
                    const at = address(thread, ins.base, ins.off);
                    checkMemoryAccess('IR reference ldd', at, 8, mem.byteLength);
                    regs[ins.dst] = view.getFloat64(at, true);
                    thread.pc += 1;
                    break;
                }
                case 'stb': {
                    const at = address(thread, ins.base, ins.off);
                    checkMemoryAccess('IR reference stb', at, 1, mem.byteLength);
                    view.setInt8(at, i32(regs[ins.src]));
                    thread.pc += 1;
                    break;
                }
                case 'stw': {
                    const at = address(thread, ins.base, ins.off);
                    checkMemoryAccess('IR reference stw', at, 4, mem.byteLength);
                    view.setInt32(at, i32(regs[ins.src]), true);
                    thread.pc += 1;
                    break;
                }
                case 'std': {
                    const at = address(thread, ins.base, ins.off);
                    checkMemoryAccess('IR reference std', at, 8, mem.byteLength);
                    view.setFloat64(at, regs[ins.src], true);
                    thread.pc += 1;
                    break;
                }
                case 'ldw_s': {
                    const at = address(thread, ins.base, ins.off, ins.index, ins.scale);
                    checkMemoryAccess('IR reference scaled ldw', at, 4, mem.byteLength);
                    regs[ins.dst] = view.getInt32(at, true);
                    thread.pc += 1;
                    break;
                }
                case 'ldd_s': {
                    const at = address(thread, ins.base, ins.off, ins.index, ins.scale);
                    checkMemoryAccess('IR reference scaled ldd', at, 8, mem.byteLength);
                    regs[ins.dst] = view.getFloat64(at, true);
                    thread.pc += 1;
                    break;
                }
                case 'stw_s': {
                    const at = address(thread, ins.base, ins.off, ins.index, ins.scale);
                    checkMemoryAccess('IR reference scaled stw', at, 4, mem.byteLength);
                    view.setInt32(at, i32(regs[ins.src]), true);
                    thread.pc += 1;
                    break;
                }
                case 'std_s': {
                    const at = address(thread, ins.base, ins.off, ins.index, ins.scale);
                    checkMemoryAccess('IR reference scaled std', at, 8, mem.byteLength);
                    view.setFloat64(at, regs[ins.src], true);
                    thread.pc += 1;
                    break;
                }
                case 'br':
                    thread.pc = target(ins.label);
                    break;
                case 'brc':
                    thread.pc = evalCond(ins.cond, regs[ins.a], regs[ins.b])
                        ? target(ins.label)
                        : thread.pc + 1;
                    break;
                case 'halt':
                    thread.result = regs[ins.src];
                    thread.halted = true;
                    break;
                case 'call':
                    if (thread.calls.length >= 4096) {
                        throw new Error(`IR reference call depth exceeds 4096 for thread ${thread.id}`);
                    }
                    thread.calls.push(thread.pc + 1);
                    thread.pc = target(ins.label);
                    break;
                case 'ret': {
                    const back = thread.calls.pop();
                    if (back === undefined) {
                        throw new Error(`IR reference RET with empty call stack in thread ${thread.id}`);
                    }
                    thread.pc = back;
                    break;
                }
                case 'icall':
                    if (thread.calls.length >= 4096) {
                        throw new Error(`IR reference call depth exceeds 4096 for thread ${thread.id}`);
                    }
                    thread.calls.push(thread.pc + 1);
                    thread.pc = i32(regs[ins.fn]);
                    break;
                case 'labaddr':
                    regs[ins.dst] = target(ins.label);
                    thread.pc += 1;
                    break;
                case 'tid':
                case 'ptid':
                    regs[ins.dst] = thread.id;
                    thread.pc += 1;
                    break;
                case 'nthreads':
                case 'pnthreads':
                    regs[ins.dst] = workers;
                    thread.pc += 1;
                    break;
                case 'cstack_check': {
                    const ptr = i32(regs[ins.src]);
                    const low = C_STACK_BASE + thread.id * C_STACK_STRIDE;
                    const high = low + C_STACK_STRIDE;
                    const valid = ins.area === 'software'
                        ? ptr >= low + C_PARK_BYTES && ptr <= high
                        : ptr >= low && ptr <= low + C_PARK_BYTES;
                    if (!valid) {
                        throw new Error(`Guest C ${ins.area} stack fault for worker ${thread.id} ` +
                            `at address ${ptr} (region ${low}..${high})`);
                    }
                    thread.pc += 1;
                    break;
                }
                case 'barrier':
                    thread.barrierEpoch = epoch;
                    break;
                case 'spill_load':
                case 'spill_store':
                    throw new Error('Allocator spill instruction is invalid in source IR');
            }
        }
        const waiting = threads.filter((thread) => thread.barrierEpoch === epoch);
        if (waiting.length > 0) {
            const halted = threads.find((thread) => thread.halted);
            if (halted) {
                throw new Error(`IR reference divergent barrier epoch ${epoch}: ` +
                    `thread ${halted.id} halted before all participants arrived`);
            }
            if (waiting.length === threads.length) {
                for (const thread of threads) {
                    thread.barrierEpoch = null;
                    thread.pc += 1;
                }
                epoch += 1;
                progress = true;
            }
        }
        if (progress)
            roundsWithoutProgress = 0;
        else
            roundsWithoutProgress += 1;
        if (roundsWithoutProgress >= maxRoundsWithoutProgress) {
            throw new Error(`IR reference deadlock after ${roundsWithoutProgress} rounds at barrier epoch ${epoch}`);
        }
    }
    throw new Error(`IR reference exceeded ${maxSteps} steps`);
}
//# sourceMappingURL=ir-reference.js.map