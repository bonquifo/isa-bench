/*
 * ISA Bench native corpus v1.
 * Freestanding deterministic implementations of the twelve built-in workloads.
 * BENCH_WORKLOAD, BENCH_N and BENCH_SEED are fixed by the build descriptor.
 */
typedef unsigned char u8;
typedef __UINT32_TYPE__ u32;
typedef __INT32_TYPE__ i32;
typedef __UINT64_TYPE__ u64;

#ifndef BENCH_WORKLOAD
#error BENCH_WORKLOAD is required
#endif
#ifndef BENCH_N
#error BENCH_N is required
#endif
#ifndef BENCH_SEED
#error BENCH_SEED is required
#endif

#define W_INT_SUM 1
#define W_DOT_PRODUCT 2
#define W_SAXPY 3
#define W_MEMCPY 4
#define W_MATMUL 5
#define W_INSERTION_SORT 6
#define W_BINARY_SEARCH 7
#define W_SIEVE 8
#define W_CHECKSUM 9
#define W_POINTER_CHASE 10
#define W_FIR 11
#define W_FP_SUM 12
#define NOINLINE_USED __attribute__((noinline, used))

typedef union {
  double value;
  u64 bits;
} f64_bits;

volatile u64 isa_bench_result_sink __attribute__((section(".bss.isa_bench_sink")));
static volatile u32 isa_bench_runtime_n __attribute__((section(".bss.isa_bench_n")));

NOINLINE_USED void isa_bench_roi_begin(void) {
  __asm__ volatile("" ::: "memory");
}

NOINLINE_USED void isa_bench_roi_end(void) {
  __asm__ volatile("" ::: "memory");
}

static u32 lcg_next(u32 *state) {
  *state = (*state * 1664525u) + 1013904223u;
  return *state;
}

static u32 add32(u32 left, u32 right) { return left + right; }
static u32 mul32(u32 left, u32 right) { return left * right; }
static u32 shl32(u32 value, u32 shift) { return value << (shift & 31u); }
static u32 shr32(u32 value, u32 shift) { return value >> (shift & 31u); }

static i32 signed32(u32 value) {
  if (value <= 0x7fffffffu) return (i32)value;
  return -1 - (i32)(0xffffffffu - value);
}

static int less_signed(u32 left, u32 right) {
  return signed32(left) < signed32(right);
}

static u32 signed_rem(u32 value, i32 divisor) {
  return (u32)(signed32(value) % divisor);
}

static u32 fnv_words(const u32 *words, u32 count) {
  u32 hash = 2166136261u;
  for (u32 i = 0; i < count; ++i) hash = mul32(hash ^ words[i], 16777619u);
  return hash;
}

#if BENCH_WORKLOAD == W_DOT_PRODUCT || BENCH_WORKLOAD == W_SAXPY || \
    BENCH_WORKLOAD == W_MEMCPY || BENCH_WORKLOAD == W_BINARY_SEARCH
static u32 data_a[BENCH_N];
static u32 data_b[BENCH_N];
#elif BENCH_WORKLOAD == W_MATMUL
static u32 data_a[BENCH_N * BENCH_N];
static u32 data_b[BENCH_N * BENCH_N];
static u32 data_c[BENCH_N * BENCH_N];
#elif BENCH_WORKLOAD == W_INSERTION_SORT
static u32 data_a[BENCH_N];
#elif BENCH_WORKLOAD == W_SIEVE
static u32 data_a[BENCH_N + 1];
#elif BENCH_WORKLOAD == W_POINTER_CHASE
static u32 data_a[BENCH_N];
static u32 data_b[BENCH_N];
#elif BENCH_WORKLOAD == W_FIR
static u32 data_a[BENCH_N];
static u32 data_b[BENCH_N];
#elif BENCH_WORKLOAD == W_FP_SUM
static double fp_data[BENCH_N];
#endif

NOINLINE_USED void isa_bench_prepare(void) {
  u32 state = (u32)BENCH_SEED;
  isa_bench_runtime_n = BENCH_N;
#if BENCH_WORKLOAD == W_DOT_PRODUCT
  for (u32 i = 0; i < BENCH_N; ++i) data_a[i] = signed_rem(lcg_next(&state), 17) - 8u;
  for (u32 i = 0; i < BENCH_N; ++i) data_b[i] = signed_rem(lcg_next(&state), 13) - 6u;
#elif BENCH_WORKLOAD == W_SAXPY
  for (u32 i = 0; i < BENCH_N; ++i) data_a[i] = signed_rem(lcg_next(&state), 11) - 5u;
  for (u32 i = 0; i < BENCH_N; ++i) data_b[i] = signed_rem(lcg_next(&state), 9) - 4u;
#elif BENCH_WORKLOAD == W_MEMCPY
  for (u32 i = 0; i < BENCH_N; ++i) {
    data_a[i] = lcg_next(&state);
    data_b[i] = 0u;
  }
#elif BENCH_WORKLOAD == W_MATMUL
  for (u32 i = 0; i < BENCH_N * BENCH_N; ++i) data_a[i] = signed_rem(lcg_next(&state), 7) - 3u;
  for (u32 i = 0; i < BENCH_N * BENCH_N; ++i) data_b[i] = signed_rem(lcg_next(&state), 7) - 3u;
  for (u32 i = 0; i < BENCH_N * BENCH_N; ++i) data_c[i] = 0u;
#elif BENCH_WORKLOAD == W_INSERTION_SORT
  for (u32 i = 0; i < BENCH_N; ++i) data_a[i] = lcg_next(&state);
#elif BENCH_WORKLOAD == W_BINARY_SEARCH
  for (u32 i = 0; i < BENCH_N; ++i) data_a[i] = signed_rem(lcg_next(&state), 10000);
  for (u32 i = 1; i < BENCH_N; ++i) {
    u32 key = data_a[i];
    u32 j = i;
    while (j > 0u && less_signed(key, data_a[j - 1u])) {
      data_a[j] = data_a[j - 1u];
      --j;
    }
    data_a[j] = key;
  }
  for (u32 i = 0; i < BENCH_N; ++i) {
    data_b[i] = i % 3u == 0u ? signed_rem(lcg_next(&state), 10000) : data_a[i % BENCH_N];
  }
#elif BENCH_WORKLOAD == W_SIEVE
  for (u32 i = 0; i <= BENCH_N; ++i) data_a[i] = 1u;
#elif BENCH_WORKLOAD == W_POINTER_CHASE
  for (u32 i = 0; i < BENCH_N; ++i) data_a[i] = i;
  for (u32 i = BENCH_N - 1u; i > 0u; --i) {
    u32 j = lcg_next(&state) % (i + 1u);
    u32 temp = data_a[i];
    data_a[i] = data_a[j];
    data_a[j] = temp;
  }
  for (u32 i = 0; i < BENCH_N; ++i) data_b[data_a[i]] = data_a[(i + 1u) % BENCH_N];
#elif BENCH_WORKLOAD == W_FIR
  for (u32 i = 0; i < BENCH_N; ++i) {
    data_a[i] = signed_rem(lcg_next(&state), 21) - 10u;
    data_b[i] = 0u;
  }
#elif BENCH_WORKLOAD == W_FP_SUM
  for (u32 i = 0; i < BENCH_N; ++i) {
    i32 numerator = (i32)signed_rem(lcg_next(&state), 2001) - 1000;
    fp_data[i] = (double)numerator / 100.0;
  }
#else
  (void)state;
#endif
}

NOINLINE_USED u64 isa_bench_core(void) {
  u32 n = isa_bench_runtime_n;
#if BENCH_WORKLOAD == W_INT_SUM
  u32 acc = 0u;
  for (u32 i = 0; i < n; ++i) acc = add32(acc, i);
  return (u64)acc;
#elif BENCH_WORKLOAD == W_DOT_PRODUCT
  u32 acc = 0u;
  for (u32 i = 0; i < n; ++i) acc = add32(acc, mul32(data_a[i], data_b[i]));
  return (u64)acc;
#elif BENCH_WORKLOAD == W_SAXPY
  for (u32 i = 0; i < n; ++i) data_b[i] = add32(data_b[i], mul32(3u, data_a[i]));
  return (u64)fnv_words(data_b, n);
#elif BENCH_WORKLOAD == W_MEMCPY
  for (u32 i = 0; i < n; ++i) data_b[i] = data_a[i];
  return (u64)fnv_words(data_b, n);
#elif BENCH_WORKLOAD == W_MATMUL
  for (u32 i = 0; i < n; ++i) {
    for (u32 j = 0; j < n; ++j) {
      u32 acc = 0u;
      for (u32 k = 0; k < n; ++k) {
        acc = add32(acc, mul32(data_a[i * n + k], data_b[k * n + j]));
      }
      data_c[i * n + j] = acc;
    }
  }
  return (u64)fnv_words(data_c, n * n);
#elif BENCH_WORKLOAD == W_INSERTION_SORT
  for (u32 i = 1; i < n; ++i) {
    u32 key = data_a[i];
    u32 j = i;
    while (j > 0u && less_signed(key, data_a[j - 1u])) {
      data_a[j] = data_a[j - 1u];
      --j;
    }
    data_a[j] = key;
  }
  return (u64)fnv_words(data_a, n);
#elif BENCH_WORKLOAD == W_BINARY_SEARCH
  u32 total = 0u;
  for (u32 q = 0; q < n; ++q) {
    i32 lo = 0;
    i32 hi = (i32)n - 1;
    i32 found = -1;
    while (lo <= hi) {
      i32 mid = lo + ((hi - lo) / 2);
      u32 value = data_a[(u32)mid];
      if (value == data_b[q]) { found = mid; break; }
      if (less_signed(value, data_b[q])) lo = mid + 1;
      else hi = mid - 1;
    }
    total = add32(total, (u32)found);
  }
  return (u64)total;
#elif BENCH_WORKLOAD == W_SIEVE
  data_a[0] = 0u;
  data_a[1] = 0u;
  for (u32 i = 2u; i <= n / i; ++i) {
    if (data_a[i] == 0u) continue;
    for (u32 j = i * i; j <= n; j += i) data_a[j] = 0u;
  }
  u32 count = 0u;
  for (u32 i = 2u; i <= n; ++i) if (data_a[i] != 0u) ++count;
  return (u64)count;
#elif BENCH_WORKLOAD == W_CHECKSUM
  u32 hash = (u32)BENCH_SEED;
  for (u32 i = 0; i < n; ++i) {
    hash ^= i;
    hash = add32(shl32(hash, 5u) | shr32(hash, 27u), 0x9e3779b9u);
    hash ^= shr32(hash, 7u);
  }
  return (u64)hash;
#elif BENCH_WORKLOAD == W_POINTER_CHASE
  u32 node = 0u;
  u32 acc = 0u;
  for (u32 step = 0; step < n; ++step) {
    acc = add32(acc, add32(mul32(node, 17u), (u32)BENCH_SEED));
    node = data_b[node];
  }
  return (u64)acc;
#elif BENCH_WORKLOAD == W_FIR
  static const u32 coeffs[8] = {1u, 0xfffffffeu, 3u, 0xffffffffu, 2u, 1u, 0xffffffffu, 1u};
  u32 total = 0u;
  for (u32 i = 0; i < n; ++i) {
    u32 acc = 0u;
    for (u32 k = 0; k < 8u; ++k) {
      u32 sample = i >= k ? data_a[i - k] : 0u;
      acc = add32(acc, mul32(coeffs[k], sample));
    }
    data_b[i] = acc;
    total = add32(total, acc);
  }
  return (u64)total;
#elif BENCH_WORKLOAD == W_FP_SUM
  double acc = 0.0;
  for (u32 i = 0; i < n; ++i) acc = acc + fp_data[i];
  f64_bits result = { .value = acc };
  return result.bits;
#else
#error unknown BENCH_WORKLOAD
#endif
}

NOINLINE_USED u64 isa_bench_inner_iteration(void) {
  isa_bench_prepare();
  isa_bench_roi_begin();
  u64 result = isa_bench_core();
  isa_bench_roi_end();
  isa_bench_result_sink = result;
  return result;
}
