typedef unsigned char u8;
typedef signed char i8;
typedef unsigned short u16;
typedef unsigned long u32;
typedef unsigned long long u64;

struct sim_reg {
  u8 clock[4];
  u8 unclaimed;
  char getchar_value;
  char input_eof;
  u8 abort;
  i8 exit;
  u8 putchar_value;
};

struct isa_result {
  u8 status;
  u8 kind;
  u16 reserved;
  u32 detail;
  u64 bits;
};

extern volatile struct sim_reg *const sim_reg_iface;
extern int isa_run(struct isa_result *);

static void put(u8 value) {
  sim_reg_iface->putchar_value = value;
}

static void put_u32le(u32 value) {
  for (u8 i = 0; i < 4; ++i) put((u8)(value >> (8u * i)));
}

static void put_u64le(u64 value) {
  for (u8 i = 0; i < 8; ++i) put((u8)(value >> (8u * i)));
}

int main(void) {
  struct isa_result result = {0};
  int rc = isa_run(&result);
  if (rc != 0) result.status = 1;
  put_u32le(0x46415349ul);
  put(1);
  put(0);
  put(result.status);
  put(result.kind);
  put_u64le(result.bits);
  put_u32le(0);
  put_u32le(0);
  sim_reg_iface->exit = result.status == 0 ? 0 : 1;
  return 0;
}
