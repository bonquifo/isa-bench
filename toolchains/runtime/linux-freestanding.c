typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;
typedef __SIZE_TYPE__ usize;

struct isa_result {
  u8 status;
  u8 kind;
  u16 reserved;
  u32 detail;
  u64 bits;
};

extern int isa_run(struct isa_result *);
extern int isa_copy_stdout(u8 *, int);

#if defined(__sparc__)
typedef union {
  u64 value;
  struct { u32 high; u32 low; } words;
  u8 bytes[8];
} wide_value;

u64 __ashldi3(u64 value, int shift) {
  wide_value in = { .value = value };
  wide_value out = { .value = 0 };
  unsigned amount = (unsigned)shift & 63u;
  if (amount == 0) return value;
  if (amount < 32) {
    out.words.high = (in.words.high << amount) | (in.words.low >> (32 - amount));
    out.words.low = in.words.low << amount;
  } else {
    out.words.high = in.words.low << (amount - 32);
  }
  return out.value;
}

u64 __lshrdi3(u64 value, int shift) {
  wide_value in = { .value = value };
  wide_value out = { .value = 0 };
  unsigned amount = (unsigned)shift & 63u;
  if (amount == 0) return value;
  if (amount < 32) {
    out.words.low = (in.words.low >> amount) | (in.words.high << (32 - amount));
    out.words.high = in.words.high >> amount;
  } else {
    out.words.low = in.words.high >> (amount - 32);
  }
  return out.value;
}
#endif

void *memset(void *destination, int value, usize size) {
  volatile u8 *bytes = (volatile u8 *)destination;
  for (usize i = 0; i < size; ++i) bytes[i] = (u8)value;
  return destination;
}

static long syscall3(long number, long a, long b, long c) {
#if defined(__x86_64__)
  register long rax __asm__("rax") = number;
  register long rdi __asm__("rdi") = a;
  register long rsi __asm__("rsi") = b;
  register long rdx __asm__("rdx") = c;
  __asm__ volatile("syscall" : "+a"(rax) : "D"(rdi), "S"(rsi), "d"(rdx) : "rcx", "r11", "memory");
  return rax;
#elif defined(__aarch64__)
  register long x8 __asm__("x8") = number;
  register long x0 __asm__("x0") = a;
  register long x1 __asm__("x1") = b;
  register long x2 __asm__("x2") = c;
  __asm__ volatile("svc #0" : "+r"(x0) : "r"(x8), "r"(x1), "r"(x2) : "memory");
  return x0;
#elif defined(__riscv) && __riscv_xlen == 64
  register long a7 __asm__("a7") = number;
  register long a0 __asm__("a0") = a;
  register long a1 __asm__("a1") = b;
  register long a2 __asm__("a2") = c;
  __asm__ volatile("ecall" : "+r"(a0) : "r"(a7), "r"(a1), "r"(a2) : "memory");
  return a0;
#elif defined(__mips__)
  register long v0 __asm__("$2") = number;
  register long a0 __asm__("$4") = a;
  register long a1 __asm__("$5") = b;
  register long a2 __asm__("$6") = c;
  __asm__ volatile("syscall" : "+r"(v0), "+r"(a0) : "r"(a1), "r"(a2) : "$1", "$3", "$7", "memory");
  return v0;
#elif defined(__powerpc64__)
  register long r0 __asm__("r0") = number;
  register long r3 __asm__("r3") = a;
  register long r4 __asm__("r4") = b;
  register long r5 __asm__("r5") = c;
  __asm__ volatile("sc" : "+r"(r3) : "r"(r0), "r"(r4), "r"(r5) : "cr0", "memory");
  return r3;
#elif defined(__sparc__)
  register long g1 __asm__("g1") = number;
  register long o0 __asm__("o0") = a;
  register long o1 __asm__("o1") = b;
  register long o2 __asm__("o2") = c;
  __asm__ volatile("ta 0x10" : "+r"(o0) : "r"(g1), "r"(o1), "r"(o2) : "memory");
  return o0;
#else
#error unsupported Linux syscall architecture
#endif
}

static long write_bytes(const void *bytes, usize size) {
#if defined(__aarch64__) || defined(__riscv)
  return syscall3(64, 1, (long)bytes, (long)size);
#elif defined(__mips__)
  return syscall3(4004, 1, (long)bytes, (long)size);
#else
  return syscall3(4, 1, (long)bytes, (long)size);
#endif
}

__attribute__((noreturn)) static void exit_process(int status) {
#if defined(__aarch64__) || defined(__riscv)
  syscall3(93, status, 0, 0);
#elif defined(__mips__)
  syscall3(4001, status, 0, 0);
#else
  syscall3(1, status, 0, 0);
#endif
  __builtin_unreachable();
}

static void put_u32le(u8 *out, u32 value) {
  for (u32 i = 0; i < 4; ++i) out[i] = (u8)(value >> (8 * i));
}

static void put_u64le(u8 *out, u64 value) {
#if defined(__sparc__)
  wide_value wide = { .value = value };
  for (u32 i = 0; i < 8; ++i) out[i] = wide.bytes[7 - i];
#else
  for (u32 i = 0; i < 8; ++i) out[i] = (u8)(value >> (8 * i));
#endif
}

static u32 fault_text(u8 *out, u32 code) {
  static const char prefix[] = "guest fault code ";
  u32 length = 0;
  for (u32 i = 0; i < sizeof(prefix) - 1; ++i) out[length++] = (u8)prefix[i];
  if (code >= 10) out[length++] = (u8)('0' + ((code / 10) % 10));
  out[length++] = (u8)('0' + (code % 10));
  return length;
}

__attribute__((noreturn)) void _start(void) {
  struct isa_result result = {0};
  u8 frame[24 + 2048 + 32];
  int rc = isa_run(&result);
  int stdout_length = isa_copy_stdout(frame + 24, 2048);
  u32 fault_length = 0;
  if (rc != 0 || result.status != 0) {
    result.status = 1;
    fault_length = fault_text(frame + 24 + stdout_length, result.detail);
  }
  put_u32le(frame, 0x46415349u);
  frame[4] = 1;
  frame[5] = 0;
  frame[6] = result.status;
  frame[7] = result.kind;
  put_u64le(frame + 8, result.bits);
  put_u32le(frame + 16, (u32)stdout_length);
  put_u32le(frame + 20, fault_length);
  usize total = 24 + (usize)stdout_length + fault_length;
  if (write_bytes(frame, total) != (long)total) exit_process(121);
  exit_process(0);
}
