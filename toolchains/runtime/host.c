#include <stdint.h>
#include <stdio.h>
#include <string.h>

struct isa_result {
  uint8_t status;
  uint8_t kind;
  uint16_t reserved;
  uint32_t detail;
  uint64_t bits;
};

extern int32_t isa_run(struct isa_result *);
extern int32_t isa_copy_stdout(uint8_t *, int32_t);

static void put_u16le(uint8_t *p, uint16_t v) {
  p[0] = (uint8_t)v;
  p[1] = (uint8_t)(v >> 8);
}

static void put_u32le(uint8_t *p, uint32_t v) {
  for (unsigned i = 0; i < 4; ++i) p[i] = (uint8_t)(v >> (8 * i));
}

static void put_u64le(uint8_t *p, uint64_t v) {
  for (unsigned i = 0; i < 8; ++i) p[i] = (uint8_t)(v >> (8 * i));
}

int main(void) {
  struct isa_result result = {0};
  uint8_t stdout_bytes[2048];
  uint8_t header[24] = {0};
  char fault[64] = {0};
  int32_t rc = isa_run(&result);
  int32_t stdout_len = isa_copy_stdout(stdout_bytes, (int32_t)sizeof stdout_bytes);
  uint32_t fault_len = 0;
  if (rc != 0 || result.status != 0) {
    fault_len = (uint32_t)snprintf(fault, sizeof fault, "guest fault code %u", result.detail);
    result.status = 1;
  }
  put_u32le(header + 0, UINT32_C(0x46415349));
  put_u16le(header + 4, 1);
  header[6] = result.status;
  header[7] = result.kind;
  put_u64le(header + 8, result.bits);
  put_u32le(header + 16, (uint32_t)stdout_len);
  put_u32le(header + 20, fault_len);
  if (fwrite(header, 1, sizeof header, stdout) != sizeof header) return 120;
  if (stdout_len > 0 && fwrite(stdout_bytes, 1, (size_t)stdout_len, stdout) != (size_t)stdout_len) return 121;
  if (fault_len > 0 && fwrite(fault, 1, fault_len, stdout) != fault_len) return 122;
  return 0;
}
