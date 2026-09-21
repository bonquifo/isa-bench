import { describe, expect, it } from 'vitest'
import { runComparison } from '../compare.ts'
import { FRONTEND_VERSION } from '../measurement.ts'
import { ALL_ISAS, DATA_BASE, HEAP_BASE, IsaId } from '../types.ts'
import { C_EXAMPLES, GUEST_C_VERSION, cExampleByWorkloadId, compileC, cWorkloadId, isCWorkload, SAMPLE_C } from './compile_c.ts'
import { CError } from './clex.ts'
import { parseC } from './cparse.ts'

describe('C frontend', () => {
  it('compiles hello world and matches gold on every ISA', () => {
    const hello = C_EXAMPLES.find((e) => e.id === 'hello')!.source
    const result = runComparison({
      workloadId: 'custom-c',
      n: 1,
      seed: 1,
      isas: ALL_ISAS,
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: hello,
    })
    expect(result.gold).toBe(0)
    expect(result.stdout).toBe('hello world\n')
    expect(result.rows).toHaveLength(ALL_ISAS.length)
    expect(result.rows.every((r) => r.matchedGold && r.stdout === 'hello world\n')).toBe(true)
  })

  it('runs recursive fib with printf', () => {
    const result = runComparison({
      workloadId: 'custom-c',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.X86, IsaId.MOS],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: SAMPLE_C,
    })
    expect(result.gold).toBe(55)
    expect(result.stdout).toBe('fib(10) = 55\n')
    expect(result.rows.every((r) => r.matchedGold)).toBe(true)
  })

  it('sums a loop', () => {
    const src = C_EXAMPLES.find((e) => e.id === 'sum')!.source
    const result = runComparison({
      workloadId: 'custom-c',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.ARM],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: src,
    })
    expect(result.gold).toBe(820)
  })

  it('rejects programs without main', () => {
    expect(() => compileC('int foo(void) { return 1; }')).toThrow(CError)
  })

  it('rejects invalid syntax with a line number', () => {
    expect(() => parseC('int main( { return 0; }')).toThrow(/C:1:/)
  })

  it('runs structs, typedef, enum, and compound literals', () => {
    const src = C_EXAMPLES.find((e) => e.id === 'struct')!.source
    const result = runComparison({
      workloadId: 'custom-c',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.X86, IsaId.ARM],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: src,
    })
    expect(result.gold).toBe(16)
    expect(result.stdout).toBe('4 6 6\n')
  })

  it('supports unions, goto, and function pointers', () => {
    const src = `
      union U { int i; int j; };
      int twice(int x) { return x + x; }
      int main(void) {
        union U u;
        u.i = 7;
        int (*fp)(int) = twice;
        int acc = 0;
        if (u.j != 7) goto fail;
        acc = fp(u.i);
        return acc;
      fail:
        return 0;
      }
    `
    const result = runComparison({
      workloadId: 'custom-c',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.X86],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: src,
    })
    expect(result.gold).toBe(14)
  })

  it('applies #ifdef and function-like macros', () => {
    const src = `
      #define SQR(x) ((x) * (x))
      #ifdef MISSING
      int main(void) { return 0; }
      #else
      int main(void) { return SQR(6); }
      #endif
    `
    const result = runComparison({
      workloadId: 'custom-c',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: src,
    })
    expect(result.gold).toBe(36)
  })

  it('runs pointer stores through malloc', () => {
    const src = C_EXAMPLES.find((e) => e.id === 'ptr')!.source
    const result = runComparison({
      workloadId: 'custom-c',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.X86, IsaId.WASM],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
      customSource: src,
    })
    expect(result.gold).toBe(30)
    expect(result.stdout).toBe('30\n')
  })
})

function runC(source: string, isas: IsaId[] = [IsaId.RISCV]) {
  return runComparison({
    workloadId: 'custom-c',
    n: 1,
    seed: 1,
    isas,
    hardwareMode: 'same',
    profileId: 'equal-inorder',
    customSource: source,
  })
}

describe('C language semantics', () => {
  it('enforces the exact runtime main signature on every backend', () => {
    const integer = runC('int main(void) { return 37; }', ALL_ISAS)
    expect(integer.gold).toBe(37)
    expect(integer.rows.every((row) => row.result === 37)).toBe(true)

    const binary64 = runC('double main(void) { return 2.5; }', ALL_ISAS)
    expect(binary64.gold).toBe(2.5)
    expect(binary64.rows.every((row) => row.result === 2.5)).toBe(true)

    for (const source of [
      'double main(int x) { return x; }',
      'int main(int x) { return x; }',
      'int main() { return 0; }',
      'char main(void) { return 0; }',
      'void main(void) { }',
      'int *main(void) { return 0; }',
      'struct S { int x; }; struct S main(void) { struct S s = { 0 }; return s; }',
      'int main(void);',
    ]) {
      expect(() => compileC(source), source).toThrow(/entry must be defined exactly as int main\(void\) or double main\(void\)/)
    }
    expect(() => compileC('int main(int x, ...) { return x; }')).toThrow(/variadic/)
  })

  it('keeps all lowered static data below the heap', () => {
    const fixedHelperBytes = '-2147483648'.length + 1
    const exactBytes = HEAP_BASE - DATA_BASE - fixedHelperBytes
    expect(() => compileC(`char exact[${exactBytes}]; int main(void) { return 0; }`)).not.toThrow()

    const tooLargeLocal = HEAP_BASE - DATA_BASE
    expect(() => compileC(`int main(void) { static char huge[${tooLargeLocal}]; return 0; }`))
      .toThrow(/static data allocation.*overlapping heap base/)

    const almostFullLocal = HEAP_BASE - DATA_BASE - fixedHelperBytes - 4
    expect(() => compileC(`
      int main(void) {
        static char almost[${almostFullLocal}];
        return "12345678"[0];
      }
    `)).toThrow(/string literal.*overlapping heap base/)

    const allocated = runC(`
      int main(void) {
        static char local_static[4];
        void *p = malloc(4);
        return p == (void *)${HEAP_BASE} && p != local_static;
      }
    `, ALL_ISAS)
    expect(allocated.gold).toBe(1)
    expect(allocated.rows.every((row) => row.result === 1)).toBe(true)
  })

  it('accepts every supported zero integer constant expression as null', () => {
    const r = runC(`
      int *global_null = 12 - 12;
      int takes(int *p) { return p == (3 - 3); }
      int main(void) {
        int *p = 1 - 1;
        p = (7 * 4) - 28;
        return (p == (2 < 1)) && global_null == 20 - 20 && takes(9 - 9)
          && ((1 ? p : 6 - 6) == p);
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(1)
    expect(r.rows.every((row) => row.result === 1)).toBe(true)
    expect(() => compileC('int main(void) { int *p = 2 - 1; return 0; }'))
      .toThrow(/pointer assignment requires/)
    expect(() => compileC('int main(void) { int *p = 0; return p == 2 - 1; }'))
      .toThrow(/pointer comparison requires/)
    expect(() => compileC('int main(void) { int x = 0; int *p = (x = 0); return 0; }'))
      .toThrow(/pointer assignment requires/)
    expect(() => compileC('int *p = 0.0; int main(void) { return 0; }'))
      .toThrow(/compatible address constant or null/)
  })

  it('initializes only the selected union member globally and locally', () => {
    const r = runC(`
      union Overlay { int i; char c; };
      union DoubleBits { double d; int i; };
      union Overlay global_first = { .i = 0x12345678 };
      union Overlay global_char = { .c = -1 };
      union DoubleBits global_double = { .d = 1.1 };
      int main(void) {
        union Overlay local_first = { 0x23456712 };
        union Overlay local_char = { .c = -2 };
        union DoubleBits local_double = { .d = 3.25 };
        return global_first.i == 0x12345678
          && global_first.c == 0x78
          && global_char.i == 255
          && local_first.i == 0x23456712
          && local_first.c == 0x12
          && local_char.i == 254
          && global_double.d == 1.1
          && local_double.d == 3.25;
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(1)
    expect(r.rows.every((row) => row.result === 1)).toBe(true)
    expect(() => compileC(`
      union U { int i; char c; };
      union U u = { .i = 1, .c = 2 };
      int main(void) { return 0; }
    `)).toThrow(/must select exactly one member/)
  })

  it('converts compound-assignment results to the lhs type', () => {
    const r = runC(`
      int main(void) {
        char c = 127;
        int converted = (c += 1);
        int a[4] = { 0 };
        int *p = a;
        int *result = (p += 2);
        return c == -128 && converted == -128
          && p == &a[2] && result == p;
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(1)
    expect(r.rows.every((row) => row.result === 1)).toBe(true)
  })

  it('bounds local and global string-array initializers exactly', () => {
    expect(() => compileC('char a[2] = "abc"; int main(void) { return 0; }'))
      .toThrow(/too long for char\[2\]/)
    expect(() => compileC('int main(void) { char a[2] = "abc"; return 0; }'))
      .toThrow(/too long for char\[2\]/)
    expect(() => compileC('int main(void) { char a[2] = { "abc" }; return 0; }'))
      .toThrow(/too long for char\[2\]/)
    const r = runC(`
      char exact[3] = "abc";
      int guard = 77;
      char inferred[] = "xy";
      int main(void) {
        char local[3] = "abc";
        int local_guard = 88;
        char auto_len[] = "z";
        char braced[] = { "q" };
        return exact[2] + local[2] + guard + local_guard
          + sizeof inferred + sizeof auto_len + sizeof braced;
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(99 + 99 + 77 + 88 + 3 + 2 + 2)
    expect(r.rows.every((row) => row.result === r.gold)).toBe(true)
  })

  it('enforces direct, indirect, assignment, and return signatures', () => {
    expect(() => compileC('int f(int x) { return x; } int main(void) { return f(); }'))
      .toThrow(/expects 1 arguments, got 0/)
    expect(() => compileC('int f(void) { return 0; } int main(void) { return f(1); }'))
      .toThrow(/expects 0 arguments, got 1/)
    expect(() => compileC('int f(int x) { return x; } int main(void) { int (*p)(int)=f; return p(); }'))
      .toThrow(/expects 1 arguments, got 0/)
    expect(() => compileC('int f(int x) { return x; } int main(void) { int (*p)(void)=f; return 0; }'))
      .toThrow(/incompatible pointer assignment/)
    expect(() => compileC('int main(void) { int *p; char *q; p = q; return 0; }'))
      .toThrow(/incompatible pointer assignment/)
    expect(() => compileC(`
      struct A { int x; }; struct B { int x; };
      struct A f(void) { struct B b; return b; }
      int main(void) { return 0; }
    `)).toThrow(/incompatible aggregate assignment/)
    expect(runC('int f(char x) { return x; } int main(void) { return f(300); }').gold).toBe(44)
  })

  it('implements scaled and commutative pointer arithmetic', () => {
    const r = runC(`
      int main(void) {
        int a[5] = { 3, 5, 7, 9, 11 };
        int *p = a;
        p += 2;
        p -= 1;
        int *q = 2 + p;
        return *p + *q + (q - p);
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(5 + 9 + 2)
    expect(r.rows.every((row) => row.result === 16)).toBe(true)
    expect(() => compileC('int main(void) { int *p; return p * 2; }')).toThrow(/invalid pointer operator/)
  })

  it('zeroes omitted local aggregate elements on every initialization', () => {
    const r = runC(`
      struct S { int a; int b; int c; };
      int probe(int dirty) {
        struct S s = { .a = 4 };
        int a[4] = { 7 };
        if (dirty) { s.b = 99; a[2] = 88; }
        return s.a + s.b + s.c + a[0] + a[1] + a[2] + a[3];
      }
      int main(void) {
        probe(1);
        return probe(0);
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(11)
    expect(r.rows.every((row) => row.result === 11)).toBe(true)
  })

  it('implements lexical scopes, shadowing, and block-local statics', () => {
    const r = runC(`
      int main(void) {
        int x = 1;
        { int x = 2; if (x != 2) return 1; }
        for (int x = 0; x < 2; x = x + 1) {
          int y = x + 3;
          if (y < 3) return 2;
        }
        { static int x = 9; if (x != 9) return 3; }
        return x;
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(1)
    expect(r.rows.every((row) => row.result === 1)).toBe(true)
    expect(() => compileC('int main(void) { int x; int x; return 0; }')).toThrow(/redeclaration/)
  })

  it('routes do-while continue through the condition', () => {
    const r = runC(`
      int main(void) {
        int i = 0;
        int checks = 0;
        do {
          i = i + 1;
          if (i < 3) continue;
        } while ((checks = checks + 1) && i < 4);
        return i * 10 + checks;
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(44)
    expect(r.rows.every((row) => row.result === 44)).toBe(true)
  })

  it('implements validated signed int bitfields including width 32 and separators', () => {
    const r = runC(`
      struct B { int a : 8; int : 0; int b : 32; };
      int main(void) {
        struct B x = { 0 };
        x.a = -2;
        x.b = -2147483648;
        return (x.a == -2) && (x.b == -2147483648) && (sizeof(struct B) == 8);
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(1)
    expect(r.rows.every((row) => row.result === 1)).toBe(true)
    expect(() => compileC('struct B { int x : 0; }; int main(void){return 0;}')).toThrow(/named bit-field/)
    expect(() => compileC('struct B { int x : 33; }; int main(void){return 0;}')).toThrow(/outside 0\.\.32/)
  })

  it('evaluates supported global constants and rejects non-constants', () => {
    const r = runC(`
      enum E { K = 3 };
      int base = 5;
      int *ptr = &base;
      int folded = (K * 7 + sizeof(int)) == 25 ? 41 : 0;
      double half = 1.0 / 2.0;
      char *text = "ok";
      int main(void) {
        return *ptr + folded + (int)(half * 10.0) + text[1];
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(5 + 41 + 5 + 107)
    expect(r.rows.every((row) => row.result === 158)).toBe(true)
    expect(() => compileC('int f(void){return 3;} int x=f(); int main(void){return x;}'))
      .toThrow(/unsupported non-constant global initializer/)
  })

  it('applies conditional-expression arithmetic and pointer type rules on every ISA', () => {
    const r = runC(`
      int main(void) {
        double a = 0 ? 1 : 2.5;
        double b = 1 ? 2 : 3.5;
        char c = -1;
        int d = 1 ? c : 300;
        int e = 0 ? c : 300;
        int local = 7;
        int *p = 1 ? &local : 0;
        void *q = 0 ? 0 : p;
        if (p != q) return 1;
        return (int)(a * 10.0) + (int)(b * 10.0) + d + e;
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(344)
    expect(r.rows.every((row) => row.result === 344)).toBe(true)

    expect(() => compileC(`
      struct A { int x; }; struct B { int x; };
      int main(void) { struct A a; struct B b; return (1 ? a : b).x; }
    `)).toThrow(/incompatible aggregate arms/)
    expect(() => compileC(`
      void a(void) { } void b(void) { }
      int main(void) { 1 ? a() : b(); return 0; }
    `)).toThrow(/void arms/)
  })

  it('normalizes logical values and short-circuits side effects for all scalar conditions', () => {
    const r = runC(`
      int side;
      int bump(void) { side = side + 1; return 7; }
      int main(void) {
        double z = 0.0;
        double f = 0.5;
        char *p = "x";
        int v = (4 && 9) + (0 || -3) + (!z) + (!f) + (!!p);
        0 && bump();
        1 || bump();
        return v * 10 + side;
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(40)
    expect(r.rows.every((row) => row.result === 40)).toBe(true)
  })

  it('implements double promotion, fractional comparisons, conversions, NaN, and infinity', () => {
    const r = runC(`
      int main(void) {
        double a = 1;
        double b = 1.5;
        double inf = 1.0 / 0.0;
        double nan = 0.0 / 0.0;
        if (!(a < b) || b == 1 || (int)3.9 != 3) return 1;
        if (!(inf > 1000000.0) || nan == nan || !nan) return 2;
        return (int)(a + b);
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(2)
    expect(r.rows.every((row) => row.result === 2)).toBe(true)
  })

  it('uses signed byte char layout and byte-oriented libc', () => {
    const r = runC(`
      int main(void) {
        char a[8] = "abc";
        char b[8];
        if (sizeof(char) != 1 || (&a[1] - &a[0]) != 1) return 1;
        memcpy(b, a, 4);
        if (memcmp(a, b, 4) != 0 || strlen(b) != 3) return 2;
        memset(b + 1, 'x', 2);
        if (b[0] != 'a' || b[1] != 'x' || b[2] != 'x' || b[3] != 0) return 3;
        strcpy(b, "q");
        strcat(b, "rs");
        return strcmp(b, "qrs");
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(0)
    expect(r.rows.every((row) => row.result === 0)).toBe(true)
  })

  it('compares strcmp and memcmp bytes as unsigned char', () => {
    const r = runC(`
      int main(void) {
        char hi[2]; char lo[2];
        hi[0] = (char)0x80; hi[1] = 0;
        lo[0] = (char)0x7f; lo[1] = 0;
        if (strcmp(hi, lo) <= 0) return 1;
        if (memcmp(hi, lo, 1) <= 0) return 2;
        if (memcmp(hi, lo, 0) != 0) return 3;
        return 0;
      }
    `, ALL_ISAS)
    expect(r.gold).toBe(0)
    expect(r.rows.every((row) => row.result === 0)).toBe(true)
  })

  it('rejects scalar widths, float, and user variadics precisely', () => {
    for (const [src, message] of [
      ['unsigned int main(void) { return 0; }', "does not support 'unsigned'"],
      ['short main(void) { return 0; }', "does not support 'short'"],
      ['long main(void) { return 0; }', "does not support 'long'"],
      ['float main(void) { return 0; }', "does not support 'float'"],
      ['int f(int x, ...) { return x; } int main(void) { return 0; }', 'variadic'],
    ]) expect(() => compileC(src)).toThrow(message)
  })

  it('preserves function-pointer return type and rejects unsupported signatures', () => {
    expect(runC(`char f(void) { return 300; } int main(void) { char (*p)(void) = f; return p(); }`).gold).toBe(44)
    expect(() => compileC(`double f(void) { return 1.0; } int main(void) { double (*p)(void)=f; return 0; }`))
      .toThrow(/double in function signature/)
  })

  it('prints INT_MIN and returns exact printf character counts', () => {
    const r = runC(`int main(void) { int n = printf("%d:%c:%s:%%", -2147483648, 'A', "xy"); return n; }`, ALL_ISAS)
    expect(r.gold).toBe(18)
    expect(r.stdout).toBe('-2147483648:A:xy:%')
    expect(r.rows.every((row) => row.result === 18 && row.stdout === r.stdout)).toBe(true)
    expect(() => compileC('int main(void) { printf("%x", 1); return 0; }')).toThrow(/does not support format/)
  })

  it('returns null for allocator overflow and OOM', () => {
    const r = runC(`int main(void) {
      if (malloc(-1) != 0) return 1;
      if (calloc(2147483647, 4) != 0) return 2;
      if (malloc(500000) != 0) return 3;
      return 0;
    }`, ALL_ISAS)
    expect(r.gold).toBe(0)
    expect(r.rows.every((row) => row.result === 0)).toBe(true)
  })

  it('gives each C worker private software and expression stacks', () => {
    const result = runComparison({
      workloadId: 'custom-c',
      n: 8,
      seed: 1,
      isas: [IsaId.RISCV, IsaId.X86],
      hardwareMode: 'same',
      profileId: 'equal-smt',
      customSource: `
        int addresses[16];
        int main(void) {
          int tid = __tid();
          int local = tid;
          addresses[tid] = (int)&local;
          __barrier();
          if (tid != 0) return 1;
          int n = __nthreads();
          for (int i = 1; i < n; i = i + 1) {
            if (addresses[i] - addresses[i - 1] != 4096) return 0;
          }
          return 1;
        }
      `,
    })
    expect(result.gold).toBe(1)
    expect(result.rows.every((row) => row.result === 1 && row.activeThreads === 8)).toBe(true)
  })

  it('disables the shared heap for parallel C workers', () => {
    const result = runComparison({
      workloadId: 'custom-c',
      n: 8,
      seed: 1,
      isas: ALL_ISAS,
      hardwareMode: 'same',
      profileId: 'equal-smt',
      customSource: `
        int main(void) {
          int n = __nthreads();
          void *p = malloc(4);
          return n == 1 ? p != 0 : p == 0;
        }
      `,
    })
    expect(result.gold).toBe(1)
    expect(result.rows.every((row) => row.result === 1 && row.activeThreads === 8)).toBe(true)

    const serial = runComparison({
      workloadId: 'custom-c',
      n: 8,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-smt',
      customSource: 'int main(void) { return malloc(4) != 0; }',
    })
    expect(serial.rows[0].activeThreads).toBe(1)
    expect(serial.rows[0].result).toBe(1)
  })

  it('reports software and expression stack overflow instead of crossing regions', () => {
    expect(() => compileC('int main(void) { char too_big[3584]; return 0; }'))
      .toThrow(/software stack frame.*limit is 3584/)
    expect(() => runC(`
      int dive(int n) { if (n == 0) return 0; return dive(n - 1); }
      int main(void) { return dive(1000); }
    `)).toThrow(/Guest C software stack fault/)

    let nested = '1'
    for (let i = 0; i < 140; i++) nested = `1 + (${nested})`
    expect(() => runC(`int main(void) { return ${nested}; }`))
      .toThrow(/Guest C park stack fault/)
  })

  it('exposes revised frontend and Guest C metadata', () => {
    expect(FRONTEND_VERSION).toBe('6')
    expect(GUEST_C_VERSION).toBe('Guest C v1.4')
    const compiled = compileC('int main(void) { return 0; }')
    expect(compiled.guestVersion).toBe(GUEST_C_VERSION)
    expect(compiled.notes).toContain('return null whenever active C worker count is greater than one')
  })

  it('implements C99 toward-zero division, remainder, and arithmetic >>', () => {
    const r = runC(`
      int main(void) {
        int d = (-7) / 2;
        int m = (-7) % 3;
        int s = (-8) >> 1;
        return (d == -3) && (m == -1) && (s == -4);
      }
    `)
    expect(r.gold).toBe(1)
  })

  it('wraps 32-bit addition like two’s-complement C int', () => {
    const r = runC(`
      int main(void) {
        int x = 2147483647;
        return x + 1;
      }
    `)
    expect(r.gold).toBe(-2147483648)
  })

  it('evaluates short-circuit && / || and the ternary', () => {
    const r = runC(`
      int side;
      int bump(void) { side = side + 1; return 1; }
      int main(void) {
        side = 0;
        int a = 0 && bump();
        int b = 1 || bump();
        int c = 1 ? 4 : bump();
        return a + b + c + side;
      }
    `)
    expect(r.gold).toBe(0 + 1 + 4 + 0)
  })

  it('implements prefix/postfix increment, comma, and bitwise ops', () => {
    const r = runC(`
      int main(void) {
        int x = 3;
        int p = ++x;
        int q = x++;
        int z = (1, 2, 3);
        int bits = (0xf0 & 0x3c) | 1;
        return p + q + x + z + bits;
      }
    `)
    expect(r.gold).toBe(4 + 4 + 5 + 3 + 0x31)
  })

  it('runs while / do / for / switch / break / continue', () => {
    const r = runC(`
      int main(void) {
        int a = 0;
        int i = 0;
        while (i < 3) { a = a + 1; i = i + 1; }
        int j = 0;
        do { j = j + 1; } while (j < 2);
        int k;
        int b = 0;
        for (k = 0; k < 5; k = k + 1) {
          if (k == 1) continue;
          if (k == 4) break;
          b = b + k;
        }
        int s = 2;
        int c = 0;
        switch (s) {
          case 1: c = 10; break;
          case 2: c = 20;
          case 3: c = c + 1; break;
          default: c = 99;
        }
        return a + j + b + c;
      }
    `)
    expect(r.gold).toBe(3 + 2 + (0 + 2 + 3) + 21)
  })

  it('honors sizeof, _Alignof, and _Static_assert', () => {
    const r = runC(`
      struct P { int x; int y; };
      int main(void) {
        _Static_assert(sizeof(int) == 4, "int");
        _Static_assert(sizeof(struct P) == 8, "P");
        int n = sizeof(int) + sizeof(double) + _Alignof(double);
        return n;
      }
    `)
    expect(r.gold).toBe(4 + 8 + 8)
    expect(() =>
      parseC('int main(void) { _Static_assert(0, "nope"); return 0; }'),
    ).toThrow(/static assertion failed/)
  })

  it('selects a _Generic association by type', () => {
    const r = runC(`
      int main(void) {
        int x = 0;
        return _Generic(x, int: 11, double: 22, default: 33);
      }
    `)
    expect(r.gold).toBe(11)
  })

  it('scales pointer arithmetic by the element size', () => {
    const r = runC(`
      int main(void) {
        int a[4];
        a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4;
        int *p = a + 2;
        return *p + (p - a);
      }
    `)
    expect(r.gold).toBe(3 + 2)
  })

  it('implements hosted libc helpers used by the runtime', () => {
    const r = runC(`
      #include <stdio.h>
      int main(void) {
        int *z = (int *)calloc(2, sizeof(int));
        if (z[0] != 0 || z[1] != 0) return 1;
        char *hello = "hello";
        if (strlen(hello) != 5) return 2;
        if (strcmp("abc", "abc") != 0) return 3;
        if (abs(-9) != 9) return 4;
        if (atoi("42") != 42) return 5;
        putchar('Z');
        puts("");
        printf("n=%d\\n", 7);
        return 0;
      }
    `)
    expect(r.gold).toBe(0)
    expect(r.stdout).toBe('Z\nn=7\n')
  })

  it('prints negative integers and %% from printf', () => {
    const r = runC(`
      #include <stdio.h>
      int main(void) {
        printf("%d %%\\n", -42);
        return 0;
      }
    `)
    expect(r.stdout).toBe('-42 %\n')
  })

  it('reads and writes bitfields', () => {
    const r = runC(`
      struct B { int a : 8; int b : 8; };
      int main(void) {
        struct B s;
        s.a = 3;
        s.b = 5;
        return s.a + s.b;
      }
    `)
    expect(r.gold).toBe(8)
  })

  it('maps Program-menu ids onto canned C without customSource', () => {
    expect(isCWorkload('c-sum')).toBe(true)
    expect(isCWorkload('custom-c')).toBe(false)
    expect(cWorkloadId(C_EXAMPLES.find((e) => e.id === 'queens')!)).toBe('c-queens')
    expect(cExampleByWorkloadId('c-sum')?.menuName).toBe('C loop sum')

    const result = runComparison({
      workloadId: 'c-queens',
      n: 1,
      seed: 1,
      isas: [IsaId.RISCV],
      hardwareMode: 'same',
      profileId: 'equal-inorder',
    })
    expect(result.gold).toBe(92)
    expect(result.workloadName).toBe('8-queens search')
    expect(result.source).toContain('queens')
    expect(result.rows.every((r) => r.matchedGold)).toBe(true)
  })

  it('rejects an unknown canned C program id', () => {
    expect(() =>
      runComparison({
        workloadId: 'c-no-such-kernel',
        n: 1,
        seed: 1,
        isas: [IsaId.RISCV],
        hardwareMode: 'same',
        profileId: 'equal-inorder',
      }),
    ).toThrow(/Unknown C program/)
  })

  it('compiles tutorial examples on several ISAs', () => {
    for (const ex of C_EXAMPLES.filter((e) => e.kind === 'tutorial')) {
      const result = runC(ex.source, [IsaId.RISCV, IsaId.POWER, IsaId.SPARC])
      expect(result.rows.every((row) => row.matchedGold), ex.id).toBe(true)
    }
  })

  it('runs queens on representative register allocators', { timeout: 60_000 }, () => {
    const queens = C_EXAMPLES.find((e) => e.id === 'queens')!
    const q = runC(queens.source, [IsaId.RISCV, IsaId.X86])
    expect(q.gold).toBe(92)
    expect(q.stdout).toBe('queens 92\n')
    expect(q.rows).toHaveLength(2)
  })

  it('runs scaled Machin pi on every target', { timeout: 60_000 }, () => {
    const pi = C_EXAMPLES.find((e) => e.id === 'pi')!
    const p = runC(pi.source, ALL_ISAS)
    expect(p.gold).toBe(machinPi(100000))
    expect(p.gold).toBeGreaterThan(314000)
    expect(p.gold).toBeLessThan(314200)
  })
})

function machinPi(scale: number): number {
  const arctanInv = (x: number) => {
    let powx = x
    let s = 0
    let sign = 1
    for (let n = 0; n < 10; n++) {
      const den = (2 * n + 1) * powx
      if (den === 0) break
      s += sign * ((scale / den) | 0)
      sign = -sign
      if (powx > 2000000) break
      powx = powx * x * x
    }
    return s
  }
  return 16 * arctanInv(5) - 4 * arctanInv(239)
}

