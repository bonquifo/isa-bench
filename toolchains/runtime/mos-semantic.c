#include <stdint.h>

struct sim_reg {
  uint8_t clock[4];
  uint8_t unclaimed;
  char getchar;
  char input_eof;
  uint8_t abort;
  int8_t exit;
  uint8_t putchar;
};

extern volatile struct sim_reg *const sim_reg_iface;

static void put(char value) {
  sim_reg_iface->putchar = (uint8_t)value;
}

static void text(const char *value) {
  while (*value) put(*value++);
}

static int32_t engine_div(int32_t left, int32_t right) {
  if (right == 0) return 0;
  if (left == INT32_MIN && right == -1) return INT32_MIN;
  return left / right;
}

static int32_t engine_rem(int32_t left, int32_t right) {
  if (right == 0 || (left == INT32_MIN && right == -1)) return 0;
  return left % right;
}

int main(void) {
  volatile uint8_t memory[7] = {1, 2, 3, 4, 5, 6, 7};
  uint16_t arithmetic = (uint16_t)((21 + 7) * 3 / 2);
  uint16_t unaligned = (uint16_t)memory[1] | ((uint16_t)memory[2] << 8);
  int edge_ok = engine_div(17, 0) == 0 &&
                engine_rem(17, 0) == 0 &&
                engine_div(INT32_MIN, -1) == INT32_MIN &&
                engine_rem(INT32_MIN, -1) == 0;
  text(arithmetic == 42 ? "arithmetic:ok\n" : "arithmetic:failed\n");
  text(unaligned == 0x0302 ? "memory:ok\n" : "memory:failed\n");
  text(edge_ok ? "edge:ok\n" : "edge:failed\n");
  sim_reg_iface->exit = (arithmetic == 42 && unaligned == 0x0302 && edge_ok) ? 0 : 1;
  return 0;
}
