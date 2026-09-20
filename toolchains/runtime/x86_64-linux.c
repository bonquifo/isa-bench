typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;

struct isa_result {
  u8 status;
  u8 kind;
  u16 reserved;
  u32 detail;
  u64 bits;
};

extern int isa_run(struct isa_result *);
extern int isa_run_iterations(struct isa_result *, u64) __attribute__((weak));
extern int isa_copy_stdout(u8 *, int);

void *memset(void *destination, int value, unsigned long size) {
  volatile u8 *bytes = (volatile u8 *)destination;
  for (unsigned long i = 0; i < size; ++i) bytes[i] = (u8)value;
  return destination;
}

static long syscall3(long number, long a, long b, long c) {
  register long rax __asm__("rax") = number;
  register long rdi __asm__("rdi") = a;
  register long rsi __asm__("rsi") = b;
  register long rdx __asm__("rdx") = c;
  __asm__ volatile("syscall" : "+a"(rax) : "D"(rdi), "S"(rsi), "d"(rdx) : "rcx", "r11", "memory");
  return rax;
}

static void u32le(u8 *out, u32 value) {
  for (u32 i = 0; i < 4; ++i) out[i] = (u8)(value >> (8 * i));
}

static void u64le(u8 *out, u64 value) {
  for (u32 i = 0; i < 8; ++i) out[i] = (u8)(value >> (8 * i));
}

static u16 get_u16le(const u8 *in) { return (u16)((u16)in[0] | ((u16)in[1] << 8)); }
static u32 get_u32le(const u8 *in) { return (u32)in[0] | ((u32)in[1] << 8) | ((u32)in[2] << 16) | ((u32)in[3] << 24); }
static u64 get_u64le(const u8 *in) {
  u64 value = 0;
  for (u32 i = 0; i < 8; ++i) value |= (u64)in[i] << (8 * i);
  return value;
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
  u8 frame[24 + 2048 + 32 + 88];
  u8 control[80];
  long control_len = syscall3(0, 0, (long)control, 80);
  int measured = isa_run_iterations != 0 && control_len == 80 && get_u32le(control) == 0x43415349u && get_u16le(control + 4) == 1 && get_u16le(control + 6) == 0;
  u64 iterations = measured ? get_u64le(control + 8) : 1;
  int rc = measured ? isa_run_iterations(&result, iterations) : isa_run(&result);
  int stdout_len = isa_copy_stdout(frame + 24, 2048);
  u32 fault_len = 0;
  if (rc != 0 || result.status != 0) {
    result.status = 1;
    fault_len = fault_text(frame + 24 + stdout_len, result.detail);
  }
  u32le(frame, 0x46415349u);
  frame[4] = 1;
  frame[5] = 0;
  frame[6] = result.status;
  frame[7] = result.kind;
  u64le(frame + 8, result.bits);
  u32le(frame + 16, (u32)stdout_len);
  u32le(frame + 20, fault_len);
  unsigned long total = 24 + stdout_len + fault_len;
  if (measured && rc == 0 && result.status == 0) {
    u8 *oracle = frame + total;
    u32le(oracle, 0x4f415349u);
    oracle[4] = 1; oracle[5] = 0; oracle[6] = 0; oracle[7] = 0;
    u64le(oracle + 8, iterations);
    u64le(oracle + 16, result.bits);
    for (u32 i = 0; i < 64; ++i) oracle[24 + i] = control[16 + i];
    total += 88;
  }
  syscall3(1, 1, (long)frame, total);
  syscall3(60, 0, 0, 0);
  __builtin_unreachable();
}
