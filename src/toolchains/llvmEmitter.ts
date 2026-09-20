import { C_PARK_BYTES, C_STACK_BASE, C_STACK_STRIDE, STDOUT_BASE, STDOUT_MAX } from '../engine/types.ts'
import { validateProgram, virtDef, virtUses, type IrInst, type IrProgram } from '../engine/ir.ts'

export const LLVM_EMITTER_VERSION = '1.1.0'

/**
 * Emits deterministic, target-neutral LLVM IR. The generated function is a
 * compiled state machine so calls and indirect calls retain the source IR's
 * exact program-counter semantics on every LLVM backend.
 */
export function emitCanonicalLlvmIr(program: IrProgram): string {
  validateProgram(program)
  const maxReg = program.insts.reduce((max, ins) => Math.max(max, virtDef(ins), ...virtUses(ins)), 0)
  const labels = new Map<string, number>()
  program.insts.forEach((ins, index) => {
    if (ins.kind === 'label') {
      if (labels.has(ins.name)) throw new Error(`Duplicate label ${ins.name}`)
      labels.set(ins.name, index)
    }
  })
  const bytes = initialMemory(program)
  const lines = [
    '; isa-sim canonical LLVM IR',
    `; emitter-version: ${LLVM_EMITTER_VERSION}`,
    `; memory-bytes: ${program.memSize}`,
    'source_filename = "isa-sim-canonical"',
    '',
    `%isa_result = type { i8, i8, i16, i32, i64 }`,
    `@isa_memory = internal global [${program.memSize} x i8] zeroinitializer, align 8`,
    '',
    ...runtimeHelpers(program.memSize, bytes),
    '',
    'define i32 @isa_run(ptr %out) {',
    'entry:',
    `  %regs = alloca [${maxReg + 1} x double], align 8`,
    `  %kinds = alloca [${maxReg + 1} x i8], align 1`,
    '  %calls = alloca [4096 x i32], align 16',
    '  call void @llvm.memset.p0.i64(ptr %regs, i8 0, i64 ' + ((maxReg + 1) * 8) + ', i1 false)',
    '  call void @llvm.memset.p0.i64(ptr %kinds, i8 0, i64 ' + (maxReg + 1) + ', i1 false)',
    '  %pc = alloca i32, align 4',
    '  %sp = alloca i32, align 4',
    '  %steps = alloca i32, align 4',
    `  call void @llvm.memset.p0.i64(ptr @isa_memory, i8 0, i64 ${program.memSize}, i1 false)`,
    '  call void @init_memory()',
    '  store i32 0, ptr %pc',
    '  store i32 0, ptr %sp',
    '  store i32 0, ptr %steps',
    '  br label %dispatch',
    '',
    'dispatch:',
    '  %step0 = load i32, ptr %steps',
    '  %limit = icmp uge i32 %step0, 100000000',
    '  br i1 %limit, label %fault_steps, label %dispatch_ok',
    '',
    'dispatch_ok:',
    '  %step1 = add i32 %step0, 1',
    '  store i32 %step1, ptr %steps',
    '  %pcv = load i32, ptr %pc',
    `  switch i32 %pcv, label %fault_pc [${program.insts.map((_, i) => `\n    i32 ${i}, label %i${i}`).join('')}\n  ]`,
    '',
  ]
  program.insts.forEach((ins, index) => lines.push(...emitInstruction(ins, index, labels)))
  lines.push(
    'fault_steps:',
    '  call void @set_fault(ptr %out, i32 1)',
    '  ret i32 1',
    'fault_memory:',
    '  call void @set_fault(ptr %out, i32 2)',
    '  ret i32 1',
    'fault_callstack:',
    '  call void @set_fault(ptr %out, i32 3)',
    '  ret i32 1',
    'fault_pc:',
    '  call void @set_fault(ptr %out, i32 4)',
    '  ret i32 1',
    '}',
    '',
    'declare void @llvm.memset.p0.i64(ptr nocapture writeonly, i8, i64, i1 immarg)',
    '',
    ...stdoutHelper(program.memSize),
    '',
  )
  return `${lines.join('\n')}\n`
}

function emitInstruction(
  ins: IrInst,
  index: number,
  labels: ReadonlyMap<string, number>,
): string[] {
  const p = `i${index}`
  const next = index + 1
  const out = [`${p}:`]
  const loadedD = new Set<number>()
  const loadedI = new Set<number>()
  const reg = (n: number) => `%r${index}_${n}`
  const ip = (n: number) => `%ri${index}_${n}`
  const kp = (n: number) => `%rk${index}_${n}`
  const loadD = (n: number) => {
    if (loadedD.has(n)) return []
    loadedD.add(n)
    return [
      `  ${reg(n)}p = getelementptr inbounds [${Math.max(1, maxReferencedRegister(ins) + 1)} x double], ptr %regs, i32 0, i32 ${n}`,
      `  ${reg(n)} = load double, ptr ${reg(n)}p, align 8`,
    ]
  }
  // GEP's pointee array length is irrelevant with opaque pointers. Use a
  // per-instruction sufficient bound to keep the textual form canonical.
  const loadI = (n: number) => {
    const loaded = loadD(n)
    if (loadedI.has(n)) return loaded
    loadedI.add(n)
    return [...loaded, `  ${ip(n)} = call i32 @to_i32(double ${reg(n)})`]
  }
  const loadKind = (n: number) => [
    `  ${kp(n)}p = getelementptr inbounds [${Math.max(1, maxReferencedRegister(ins) + 1)} x i8], ptr %kinds, i32 0, i32 ${n}`,
    `  ${kp(n)} = load i8, ptr ${kp(n)}p, align 1`,
  ]
  const storeD = (n: number, value: string, kind: string = '1') => [
    `  %w${index}_${n} = getelementptr inbounds [${Math.max(1, maxReferencedRegister(ins) + 1)} x double], ptr %regs, i32 0, i32 ${n}`,
    `  store double ${value}, ptr %w${index}_${n}, align 8`,
    `  %wk${index}_${n} = getelementptr inbounds [${Math.max(1, maxReferencedRegister(ins) + 1)} x i8], ptr %kinds, i32 0, i32 ${n}`,
    `  store i8 ${kind}, ptr %wk${index}_${n}, align 1`,
  ]
  const storeI = (n: number, value: string) => [
    `  %wd${index}_${n} = sitofp i32 ${value} to double`,
    ...storeD(n, `%wd${index}_${n}`, '0'),
  ]
  const advance = () => [`  store i32 ${next}, ptr %pc`, '  br label %dispatch', '']
  const target = (name: string) => {
    const value = labels.get(name)
    if (value === undefined) throw new Error(`Unknown label ${name}`)
    return value
  }
  const address = (base: number, off: number, indexed?: { index: number; scale: number }) => {
    out.push(...loadI(base))
    if (indexed) {
      out.push(...loadI(indexed.index))
      out.push(`  %scale${index} = mul i32 ${ip(indexed.index)}, ${indexed.scale}`)
      out.push(`  %addr0_${index} = add i32 ${ip(base)}, %scale${index}`)
    }
    out.push(`  %addr_${index} = add i32 ${indexed ? `%addr0_${index}` : ip(base)}, ${off | 0}`)
  }
  switch (ins.kind) {
    case 'label':
    case 'barrier':
      out.push(...advance())
      break
    case 'imm':
      out.push(...storeI(ins.dst, `${ins.value | 0}`), ...advance())
      break
    case 'immf':
      out.push(...storeD(ins.dst, llvmDouble(ins.value)), ...advance())
      break
    case 'mov':
      out.push(...loadD(ins.src), ...loadKind(ins.src), ...storeD(ins.dst, reg(ins.src), kp(ins.src)), ...advance())
      break
    case 'convert':
      out.push(...loadD(ins.src))
      if (ins.op === 'itod') {
        out.push(`  %cv${index} = call i32 @to_i32(double ${reg(ins.src)})`)
        out.push(`  %cvd${index} = sitofp i32 %cv${index} to double`)
        out.push(...storeD(ins.dst, `%cvd${index}`, '1'))
      } else if (ins.op === 'i8') {
        out.push(`  %cv0_${index} = call i32 @to_i32(double ${reg(ins.src)})`)
        out.push(`  %cv1_${index} = trunc i32 %cv0_${index} to i8`)
        out.push(`  %cv${index} = sext i8 %cv1_${index} to i32`)
        out.push(...storeI(ins.dst, `%cv${index}`))
      } else {
        out.push(`  %cv${index} = call i32 @to_i32(double ${reg(ins.src)})`)
        out.push(...storeI(ins.dst, `%cv${index}`))
      }
      out.push(...advance())
      break
    case 'addi':
      out.push(...loadI(ins.a), `  %v${index} = add i32 ${ip(ins.a)}, ${ins.imm | 0}`)
      out.push(...storeI(ins.dst, `%v${index}`), ...advance())
      break
    case 'binop':
      out.push(...emitBinop(ins, index, loadD, loadI, storeD, storeI), ...advance())
      break
    case 'ldb':
    case 'ldw':
    case 'ldd':
    case 'ldw_s':
    case 'ldd_s': {
      const scaled = 'index' in ins ? { index: ins.index, scale: ins.scale } : undefined
      address(ins.base, ins.off, scaled)
      const width = ins.kind === 'ldb' ? 1 : ins.kind.startsWith('ldd') ? 8 : 4
      out.push(`  %ok${index} = call i1 @bounds(i32 %addr_${index}, i32 ${width})`)
      out.push(`  br i1 %ok${index}, label %mem_ok_${index}, label %fault_memory`, `mem_ok_${index}:`)
      if (width === 1) {
        out.push(`  %lv${index} = call i32 @load_i8(i32 %addr_${index})`, ...storeI(ins.dst, `%lv${index}`))
      } else if (width === 4) {
        out.push(`  %lv${index} = call i32 @load_i32le(i32 %addr_${index})`, ...storeI(ins.dst, `%lv${index}`))
      } else {
        out.push(`  %lb${index} = call i64 @load_i64le(i32 %addr_${index})`)
        out.push(`  %lv${index} = bitcast i64 %lb${index} to double`, ...storeD(ins.dst, `%lv${index}`))
      }
      out.push(...advance())
      break
    }
    case 'stb':
    case 'stw':
    case 'std':
    case 'stw_s':
    case 'std_s': {
      const scaled = 'index' in ins ? { index: ins.index, scale: ins.scale } : undefined
      address(ins.base, ins.off, scaled)
      const width = ins.kind === 'stb' ? 1 : ins.kind.startsWith('std') ? 8 : 4
      out.push(`  %ok${index} = call i1 @bounds(i32 %addr_${index}, i32 ${width})`)
      out.push(`  br i1 %ok${index}, label %mem_ok_${index}, label %fault_memory`, `mem_ok_${index}:`)
      if (width === 8) {
        out.push(...loadD(ins.src), `  %sv${index} = bitcast double ${reg(ins.src)} to i64`)
        out.push(`  call void @store_i64le(i32 %addr_${index}, i64 %sv${index})`)
      } else {
        out.push(...loadI(ins.src))
        out.push(`  call void @store_i${width * 8}le(i32 %addr_${index}, i32 ${ip(ins.src)})`)
      }
      out.push(...advance())
      break
    }
    case 'br':
      out.push(`  store i32 ${target(ins.label)}, ptr %pc`, '  br label %dispatch', '')
      break
    case 'brc':
      out.push(...loadI(ins.a), ...loadI(ins.b))
      out.push(`  %cond${index} = icmp ${condPredicate(ins.cond)} i32 ${ip(ins.a)}, ${ip(ins.b)}`)
      out.push(`  %npc${index} = select i1 %cond${index}, i32 ${target(ins.label)}, i32 ${next}`)
      out.push(`  store i32 %npc${index}, ptr %pc`, '  br label %dispatch', '')
      break
    case 'halt': {
      out.push(...loadD(ins.src), ...loadKind(ins.src))
      out.push(`  %fbits${index} = bitcast double ${reg(ins.src)} to i64`)
      out.push(`  %iv${index} = call i32 @to_i32(double ${reg(ins.src)})`)
      out.push(`  %ibits${index} = zext i32 %iv${index} to i64`)
      out.push(`  %isfloat${index} = icmp eq i8 ${kp(ins.src)}, 1`)
      out.push(`  %bits${index} = select i1 %isfloat${index}, i64 %fbits${index}, i64 %ibits${index}`)
      out.push(`  %kind${index} = select i1 %isfloat${index}, i8 1, i8 0`)
      out.push(`  call void @set_result(ptr %out, i8 %kind${index}, i64 %bits${index}, i32 %step1)`)
      out.push('  ret i32 0', '')
      break
    }
    case 'tid':
    case 'ptid':
      out.push(...storeI(ins.dst, '0'), ...advance())
      break
    case 'nthreads':
    case 'pnthreads':
      out.push(...storeI(ins.dst, '1'), ...advance())
      break
    case 'cstack_check': {
      out.push(...loadI(ins.src))
      const low = ins.area === 'software' ? C_STACK_BASE + C_PARK_BYTES : C_STACK_BASE
      const high = ins.area === 'software' ? C_STACK_BASE + C_STACK_STRIDE : C_STACK_BASE + C_PARK_BYTES
      out.push(`  %lo${index} = icmp sge i32 ${ip(ins.src)}, ${low}`)
      out.push(`  %hi${index} = icmp sle i32 ${ip(ins.src)}, ${high}`)
      out.push(`  %ok${index} = and i1 %lo${index}, %hi${index}`)
      out.push(`  br i1 %ok${index}, label %stack_ok_${index}, label %fault_callstack`, `stack_ok_${index}:`, ...advance())
      break
    }
    case 'call':
      out.push(...pushCall(index, next, String(target(ins.label))))
      break
    case 'icall':
      out.push(...loadI(ins.fn), ...pushCall(index, next, ip(ins.fn)))
      break
    case 'ret':
      out.push(
        `  %sp0_${index} = load i32, ptr %sp`,
        `  %empty${index} = icmp eq i32 %sp0_${index}, 0`,
        `  br i1 %empty${index}, label %fault_callstack, label %ret_ok_${index}`,
        `ret_ok_${index}:`,
        `  %sp1_${index} = sub i32 %sp0_${index}, 1`,
        `  store i32 %sp1_${index}, ptr %sp`,
        `  %cp_${index} = getelementptr inbounds [4096 x i32], ptr %calls, i32 0, i32 %sp1_${index}`,
        `  %back${index} = load i32, ptr %cp_${index}`,
        `  store i32 %back${index}, ptr %pc`,
        '  br label %dispatch',
        '',
      )
      break
    case 'labaddr':
      out.push(...storeI(ins.dst, String(target(ins.label))), ...advance())
      break
    case 'spill_load':
    case 'spill_store':
      throw new Error('Allocator spill instruction is invalid in canonical source IR')
    default:
      return assertNever(ins)
  }
  return out
}

function assertNever(value: never): never {
  throw new Error(`Unsupported canonical IR instruction: ${JSON.stringify(value)}`)
}

function emitBinop(
  ins: Extract<IrInst, { kind: 'binop' }>,
  index: number,
  loadD: (n: number) => string[],
  loadI: (n: number) => string[],
  storeD: (n: number, value: string) => string[],
  storeI: (n: number, value: string) => string[],
): string[] {
  const fp = ['addf', 'subf', 'mulf', 'divf', 'eqf', 'nef', 'ltf', 'gef'].includes(ins.op)
  if (fp) {
    const out = [...loadD(ins.a), ...loadD(ins.b)]
    if (['eqf', 'nef', 'ltf', 'gef'].includes(ins.op)) {
      const predicates = { eqf: 'oeq', nef: 'une', ltf: 'olt', gef: 'oge' } as const
      out.push(`  %fc${index} = fcmp ${predicates[ins.op as keyof typeof predicates]} double %r${index}_${ins.a}, %r${index}_${ins.b}`)
      out.push(`  %v${index} = zext i1 %fc${index} to i32`, ...storeI(ins.dst, `%v${index}`))
    } else {
      const op = ({ addf: 'fadd', subf: 'fsub', mulf: 'fmul', divf: 'fdiv' } as Record<string, string>)[ins.op]
      out.push(`  %v${index} = ${op} double %r${index}_${ins.a}, %r${index}_${ins.b}`)
      out.push(...storeD(ins.dst, `%v${index}`))
    }
    return out
  }
  const out = [...loadI(ins.a), ...loadI(ins.b)]
  const a = `%ri${index}_${ins.a}`
  const b = `%ri${index}_${ins.b}`
  if (ins.op === 'div' || ins.op === 'rem') {
    out.push(`  %zero${index} = icmp eq i32 ${b}, 0`)
    out.push(`  %ov${index} = icmp eq i32 ${a}, -2147483648`)
    out.push(`  %neg1_${index} = icmp eq i32 ${b}, -1`)
    out.push(`  %overflow${index} = and i1 %ov${index}, %neg1_${index}`)
    out.push(`  %bad${index} = or i1 %zero${index}, %overflow${index}`)
    out.push(`  %safe_b${index} = select i1 %bad${index}, i32 1, i32 ${b}`)
    out.push(`  %calc${index} = s${ins.op} i32 ${a}, %safe_b${index}`)
    const overflowValue = ins.op === 'div' ? -2147483648 : 0
    out.push(`  %overflow_value${index} = select i1 %overflow${index}, i32 ${overflowValue}, i32 %calc${index}`)
    out.push(`  %v${index} = select i1 %zero${index}, i32 0, i32 %overflow_value${index}`)
  } else if (['shl', 'shr', 'sar'].includes(ins.op)) {
    out.push(`  %shift${index} = and i32 ${b}, 31`)
    const op = ins.op === 'shl' ? 'shl' : ins.op === 'shr' ? 'lshr' : 'ashr'
    out.push(`  %v${index} = ${op} i32 ${a}, %shift${index}`)
  } else {
    const op = ({ add: 'add', sub: 'sub', mul: 'mul', and: 'and', or: 'or', xor: 'xor' } as Record<string, string>)[ins.op]
    out.push(`  %v${index} = ${op} i32 ${a}, ${b}`)
  }
  out.push(...storeI(ins.dst, `%v${index}`))
  return out
}

function runtimeHelpers(memorySize: number, initial: Uint8Array): string[] {
  return [
    'define internal i32 @to_i32(double %x) {',
    '  %bits = bitcast double %x to i64',
    '  %raw_exp0 = lshr i64 %bits, 52',
    '  %raw_exp1 = and i64 %raw_exp0, 2047',
    '  %raw_exp = trunc i64 %raw_exp1 to i32',
    '  %fraction = and i64 %bits, 4503599627370495',
    '  %mantissa = or i64 %fraction, 4503599627370496',
    '  %too_small = icmp ult i32 %raw_exp, 1023',
    '  %special = icmp eq i32 %raw_exp, 2047',
    '  %exponent = sub i32 %raw_exp, 1023',
    '  %large = icmp uge i32 %exponent, 84',
    '  %left_case = icmp uge i32 %exponent, 52',
    '  %left_amount0 = sub i32 %exponent, 52',
    '  %left_amount1 = and i32 %left_amount0, 63',
    '  %left_amount = zext i32 %left_amount1 to i64',
    '  %left = shl i64 %mantissa, %left_amount',
    '  %right_amount0 = sub i32 52, %exponent',
    '  %right_amount1 = and i32 %right_amount0, 63',
    '  %right_amount = zext i32 %right_amount1 to i64',
    '  %right = lshr i64 %mantissa, %right_amount',
    '  %magnitude0 = select i1 %left_case, i64 %left, i64 %right',
    '  %zero = or i1 %too_small, %special',
    '  %zero_or_large = or i1 %zero, %large',
    '  %magnitude = select i1 %zero_or_large, i64 0, i64 %magnitude0',
    '  %low = trunc i64 %magnitude to i32',
    '  %negated = sub i32 0, %low',
    '  %sign0 = lshr i64 %bits, 63',
    '  %sign = trunc i64 %sign0 to i1',
    '  %value = select i1 %sign, i32 %negated, i32 %low',
    '  ret i32 %value',
    '}',
    'define internal void @init_memory() {',
    ...Array.from(initial.entries())
      .filter(([, value]) => value !== 0)
      .flatMap(([address, value]) => [
        `  %init_${address} = getelementptr inbounds [${memorySize} x i8], ptr @isa_memory, i32 0, i32 ${address}`,
        `  store i8 ${value}, ptr %init_${address}`,
      ]),
    '  ret void',
    '}',
    'define internal i1 @bounds(i32 %addr, i32 %width) {',
    '  %nonnegative = icmp sge i32 %addr, 0',
    `  %width_fits = icmp ule i32 %width, ${memorySize}`,
    `  %last = sub i32 ${memorySize}, %width`,
    '  %inside = icmp ule i32 %addr, %last',
    '  %candidate = and i1 %nonnegative, %inside',
    '  %ok = and i1 %candidate, %width_fits',
    '  ret i1 %ok',
    '}',
    ...loadStoreHelpers(memorySize),
    'define internal void @set_result(ptr %out, i8 %kind, i64 %bits, i32 %steps) {',
    '  store %isa_result { i8 0, i8 0, i16 0, i32 0, i64 0 }, ptr %out, align 8',
    '  %kindp = getelementptr inbounds %isa_result, ptr %out, i32 0, i32 1',
    '  store i8 %kind, ptr %kindp',
    '  %stepp = getelementptr inbounds %isa_result, ptr %out, i32 0, i32 3',
    '  store i32 %steps, ptr %stepp',
    '  %bitsp = getelementptr inbounds %isa_result, ptr %out, i32 0, i32 4',
    '  store i64 %bits, ptr %bitsp',
    '  ret void',
    '}',
    'define internal void @set_fault(ptr %out, i32 %code) {',
    '  store %isa_result { i8 1, i8 0, i16 0, i32 0, i64 0 }, ptr %out, align 8',
    '  %codep = getelementptr inbounds %isa_result, ptr %out, i32 0, i32 3',
    '  store i32 %code, ptr %codep',
    '  ret void',
    '}',
  ]
}

function loadStoreHelpers(memorySize: number): string[] {
  const get = (suffix: string, add: number) => [
    `  %a${suffix} = add i32 %addr, ${add}`,
    `  %p${suffix} = getelementptr inbounds [${memorySize} x i8], ptr @isa_memory, i32 0, i32 %a${suffix}`,
    `  %b${suffix} = load i8, ptr %p${suffix}`,
  ]
  return [
    'define internal i32 @load_i8(i32 %addr) {',
    `  %p = getelementptr inbounds [${memorySize} x i8], ptr @isa_memory, i32 0, i32 %addr`,
    '  %b = load i8, ptr %p',
    '  %v = sext i8 %b to i32',
    '  ret i32 %v',
    '}',
    'define internal i32 @load_i32le(i32 %addr) {',
    ...[0, 1, 2, 3].flatMap((n) => get(String(n), n)),
    ...[0, 1, 2, 3].map((n) => `  %z${n} = zext i8 %b${n} to i32`),
    '  %s1 = shl i32 %z1, 8', '  %s2 = shl i32 %z2, 16', '  %s3 = shl i32 %z3, 24',
    '  %o1 = or i32 %z0, %s1', '  %o2 = or i32 %s2, %s3', '  %v = or i32 %o1, %o2',
    '  ret i32 %v', '}',
    'define internal i64 @load_i64le(i32 %addr) {',
    ...Array.from({ length: 8 }, (_, n) => get(String(n), n)).flat(),
    ...Array.from({ length: 8 }, (_, n) => `  %z${n} = zext i8 %b${n} to i64`),
    ...Array.from({ length: 7 }, (_, n) => `  %s${n + 1} = shl i64 %z${n + 1}, ${(n + 1) * 8}`),
    '  %o1 = or i64 %z0, %s1', '  %o2 = or i64 %s2, %s3', '  %o3 = or i64 %s4, %s5',
    '  %o4 = or i64 %s6, %s7', '  %o5 = or i64 %o1, %o2', '  %o6 = or i64 %o3, %o4',
    '  %v = or i64 %o5, %o6', '  ret i64 %v', '}',
    'define internal void @store_i8le(i32 %addr, i32 %value) {',
    `  %p = getelementptr inbounds [${memorySize} x i8], ptr @isa_memory, i32 0, i32 %addr`,
    '  %b = trunc i32 %value to i8', '  store i8 %b, ptr %p', '  ret void', '}',
    'define internal void @store_i32le(i32 %addr, i32 %value) {',
    ...Array.from({ length: 4 }, (_, n) => [
      `  %s${n} = lshr i32 %value, ${n * 8}`,
      `  %b${n} = trunc i32 %s${n} to i8`,
      `  %a${n} = add i32 %addr, ${n}`,
      `  %p${n} = getelementptr inbounds [${memorySize} x i8], ptr @isa_memory, i32 0, i32 %a${n}`,
      `  store i8 %b${n}, ptr %p${n}`,
    ]).flat(),
    '  ret void', '}',
    'define internal void @store_i64le(i32 %addr, i64 %value) {',
    ...Array.from({ length: 8 }, (_, n) => [
      `  %s${n} = lshr i64 %value, ${n * 8}`,
      `  %b${n} = trunc i64 %s${n} to i8`,
      `  %a${n} = add i32 %addr, ${n}`,
      `  %p${n} = getelementptr inbounds [${memorySize} x i8], ptr @isa_memory, i32 0, i32 %a${n}`,
      `  store i8 %b${n}, ptr %p${n}`,
    ]).flat(),
    '  ret void', '}',
  ]
}

function stdoutHelper(memorySize: number): string[] {
  if (memorySize < STDOUT_BASE + 4) {
    return [
      'define i32 @isa_copy_stdout(ptr %out, i32 %capacity) {',
      '  ret i32 0',
      '}',
    ]
  }
  const availableStdout = Math.min(STDOUT_MAX, Math.floor((memorySize - STDOUT_BASE - 4) / 4))
  return [
    'define i32 @isa_copy_stdout(ptr %out, i32 %capacity) {',
    `  %n = call i32 @load_i32le(i32 ${STDOUT_BASE})`,
    '  %positive = icmp sgt i32 %n, 0',
    `  %within_guest = icmp ule i32 %n, ${availableStdout}`,
    '  %within_out = icmp ule i32 %n, %capacity',
    '  %valid0 = and i1 %positive, %within_guest',
    '  %valid = and i1 %valid0, %within_out',
    '  br i1 %valid, label %copy, label %empty',
    'copy:',
    '  br label %loop',
    'loop:',
    '  %i = phi i32 [ 0, %copy ], [ %next, %body ]',
    '  %done = icmp eq i32 %i, %n',
    '  br i1 %done, label %return, label %body',
    'body:',
    `  %word_offset = mul i32 %i, 4`,
    `  %addr = add i32 %word_offset, ${STDOUT_BASE + 4}`,
    '  %word = call i32 @load_i32le(i32 %addr)',
    '  %byte = trunc i32 %word to i8',
    '  %dst = getelementptr inbounds i8, ptr %out, i32 %i',
    '  store i8 %byte, ptr %dst',
    '  %next = add i32 %i, 1',
    '  br label %loop',
    'return:',
    '  ret i32 %n',
    'empty:',
    '  ret i32 0',
    '}',
  ]
}

function pushCall(index: number, back: number, destination: string): string[] {
  return [
    `  %sp0_${index} = load i32, ptr %sp`,
    `  %full${index} = icmp uge i32 %sp0_${index}, 4096`,
    `  br i1 %full${index}, label %fault_callstack, label %call_ok_${index}`,
    `call_ok_${index}:`,
    `  %cp_${index} = getelementptr inbounds [4096 x i32], ptr %calls, i32 0, i32 %sp0_${index}`,
    `  store i32 ${back}, ptr %cp_${index}`,
    `  %sp1_${index} = add i32 %sp0_${index}, 1`,
    `  store i32 %sp1_${index}, ptr %sp`,
    `  store i32 ${destination}, ptr %pc`,
    '  br label %dispatch',
    '',
  ]
}

function initialMemory(program: IrProgram): Uint8Array {
  if (!Number.isSafeInteger(program.memSize) || program.memSize <= 0) throw new Error('Invalid IR memory size')
  const bytes = new Uint8Array(program.memSize)
  const view = new DataView(bytes.buffer)
  for (const blob of program.data) {
    blob.bytes.forEach((value, i) => checkedStore(bytes, blob.addr + i, 1, () => { bytes[blob.addr + i] = value & 0xff }))
    blob.words.forEach((value, i) => checkedStore(bytes, blob.addr + i * 4, 4, () => view.setInt32(blob.addr + i * 4, value | 0, true)))
    blob.floats.forEach((value, i) => checkedStore(bytes, blob.addr + i * 8, 8, () => view.setFloat64(blob.addr + i * 8, value, true)))
  }
  return bytes
}

function checkedStore(bytes: Uint8Array, address: number, width: number, write: () => void): void {
  if (!Number.isSafeInteger(address) || address < 0 || address > bytes.byteLength - width) {
    throw new Error(`Initial data is outside guest memory at ${address}`)
  }
  write()
}

function maxReferencedRegister(ins: IrInst): number {
  return Math.max(0, virtDef(ins), ...virtUses(ins))
}

function condPredicate(cond: 'eq' | 'ne' | 'lt' | 'ge'): string {
  return ({ eq: 'eq', ne: 'ne', lt: 'slt', ge: 'sge' })[cond]
}

function llvmDouble(value: number): string {
  const bytes = new Uint8Array(8)
  const view = new DataView(bytes.buffer)
  view.setFloat64(0, value, false)
  return `0x${view.getBigUint64(0, false).toString(16).toUpperCase().padStart(16, '0')}`
}
