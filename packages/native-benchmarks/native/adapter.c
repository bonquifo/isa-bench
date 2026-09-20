typedef unsigned char u8;
typedef unsigned short u16;
typedef __UINT32_TYPE__ u32;
typedef __UINT64_TYPE__ u64;

struct isa_result {
  u8 status;
  u8 kind;
  u16 reserved;
  u32 detail;
  u64 bits;
};

extern u64 isa_bench_inner_iteration(void);

__attribute__((noinline, used))
int isa_run_iterations(struct isa_result *result, u64 iterations) {
  if (iterations == 0 || iterations > 1000000000ULL) return 2;
  u64 bits = 0;
  for (u64 i = 0; i < iterations; ++i) bits = isa_bench_inner_iteration();
  result->status = 0;
#if BENCH_WORKLOAD == 12
  result->kind = 1;
#else
  result->kind = 0;
#endif
  result->reserved = 0;
  result->detail = 0;
  result->bits = bits;
  return 0;
}

__attribute__((noinline, used))
int isa_run(struct isa_result *result) {
  return isa_run_iterations(result, 1);
}

int isa_copy_stdout(u8 *destination, int capacity) {
  (void)destination;
  (void)capacity;
  return 0;
}
