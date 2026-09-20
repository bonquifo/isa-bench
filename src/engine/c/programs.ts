/** Premade C programs for the guest compiler. `heavy` ones are software gfx / games / math. */

export interface CExample {
  id: string
  name: string
  /** Short label in the main Program dropdown. */
  menuName: string
  blurb: string
  source: string
  /** Independent oracle; never derived from the live IR gold run. */
  expectedReturn: number
  expectedStdout: { exact: string } | { fnv1a: number; length: number }
  /** Tutorial snippets stay tiny. Heavy kernels are still bounded so MOS can finish. */
  kind: 'tutorial' | 'heavy'
}

export const C_WORKLOAD_PREFIX = 'c-'

export const SAMPLE_C = `#include <stdio.h>

int fib(int n) {
  if (n <= 1) return n;
  return fib(n - 1) + fib(n - 2);
}

int main(void) {
  int n = 10;
  int v = fib(n);
  printf("fib(%d) = %d\\n", n, v);
  return v;
}
`

const HELLO = `#include <stdio.h>

int main(void) {
  printf("hello world\\n");
  return 0;
}
`

const SUM = `int main(void) {
  int n = 40;
  int acc = 0;
  for (int i = 1; i <= n; i = i + 1) acc = acc + i;
  return acc;
}
`

const PTR = `#include <stdio.h>

int main(void) {
  int *p = (int *)malloc(3 * sizeof(int));
  p[0] = 10;
  p[1] = 20;
  p[2] = p[0] + p[1];
  printf("%d\\n", p[2]);
  return p[2];
}
`

const STRUCT = `#include <stdio.h>

typedef struct Point {
  int x;
  int y;
} Point;

enum Color { RED, GREEN = 5, BLUE };

Point add(Point a, Point b) {
  return (Point){ a.x + b.x, a.y + b.y };
}

int main(void) {
  Point p = { .x = 3, .y = 4 };
  Point q = { 1, 2 };
  Point r = add(p, q);
  _Static_assert(sizeof(Point) == 8, "point");
  printf("%d %d %d\\n", r.x, r.y, BLUE);
  return r.x + r.y + BLUE;
}
`

/** 12.12 fixed-point helper used by several kernels. */
const MIX = `
int mix(int h, int v) {
  h = h ^ v;
  h = h * 16777619;
  return h;
}

int mul12(int a, int b) {
  return (a * b) >> 12;
}
`

const MANDELBROT = `#include <stdio.h>
${MIX}
/* Software Mandelbrot. No GPU — every pixel is 12.12 fixed-point iterate + escape. */
int main(void) {
  int W = 32;
  int H = 12;
  int MAXIT = 16;
  int h = 2166136261;
  int y;
  for (y = 0; y < H; y = y + 1) {
    int x;
    for (x = 0; x < W; x = x + 1) {
      int cr = ((x - W / 2) * 8192) / W - 2048;
      int ci = ((y - H / 2) * 7372) / H;
      int zr = 0;
      int zi = 0;
      int it = 0;
      while (it < MAXIT) {
        int zr2 = mul12(zr, zr);
        int zi2 = mul12(zi, zi);
        if (zr2 + zi2 > 16384) break;
        int nr = zr2 - zi2 + cr;
        zi = mul12(zr, zi) * 2 + ci;
        zr = nr;
        it = it + 1;
      }
      h = mix(h, it);
      if (it >= MAXIT) putchar(' ');
      else if (it > 10) putchar('#');
      else if (it > 6) putchar('*');
      else if (it > 3) putchar('+');
      else putchar('.');
    }
    putchar(10);
  }
  printf("%d\\n", h);
  return h;
}
`

const WOLF = `#include <stdio.h>
${MIX}
/* Mini Wolfenstein: 8×8 map, 24 DDA-style rays, 16-high slices, checksum fb. */
int map8(int x, int y) {
  if (x <= 0 || y <= 0 || x >= 7 || y >= 7) return 1;
  if (x == 3 && y == 2) return 1;
  if (x == 5 && y == 4) return 1;
  return 0;
}

int main(void) {
  int W = 24;
  int H = 16;
  int fb[384];
  int i;
  for (i = 0; i < W * H; i = i + 1) fb[i] = 0;
  int px = 3 * 256 + 128;
  int py = 3 * 256 + 128;
  int col;
  for (col = 0; col < W; col = col + 1) {
    int ang = col - W / 2;
    int dx = 40;
    int dy = ang * 3;
    int x = px;
    int y = py;
    int dist = 1;
    int hit = 0;
    while (dist < 40 && hit == 0) {
      x = x + dx;
      y = y + dy;
      dist = dist + 1;
      int cx = x >> 8;
      int cy = y >> 8;
      if (map8(cx, cy)) hit = 1;
    }
    int slice = (H * 6) / dist;
    if (slice > H) slice = H;
    int top = (H - slice) / 2;
    int row;
    for (row = 0; row < H; row = row + 1) {
      int shade = 0;
      if (row >= top && row < top + slice) shade = 255 - dist * 4;
      if (shade < 0) shade = 0;
      fb[row * W + col] = shade;
    }
  }
  int h = 2166136261;
  for (i = 0; i < W * H; i = i + 1) h = mix(h, fb[i]);
  printf("wolf %d\\n", h);
  return h;
}
`

const LIFE = `#include <stdio.h>
${MIX}
/* Conway's Game of Life, 20×12 torus, 12 generations, glider + blinker seed. */
int main(void) {
  int W = 20;
  int H = 12;
  int a[240];
  int b[240];
  int i;
  for (i = 0; i < W * H; i = i + 1) a[i] = 0;
  a[1 * W + 2] = 1;
  a[2 * W + 3] = 1;
  a[3 * W + 1] = 1;
  a[3 * W + 2] = 1;
  a[3 * W + 3] = 1;
  a[6 * W + 8] = 1;
  a[6 * W + 9] = 1;
  a[6 * W + 10] = 1;
  int gen;
  for (gen = 0; gen < 12; gen = gen + 1) {
    int y;
    for (y = 0; y < H; y = y + 1) {
      int x;
      for (x = 0; x < W; x = x + 1) {
        int n = 0;
        int dy;
        for (dy = -1; dy <= 1; dy = dy + 1) {
          int dx;
          for (dx = -1; dx <= 1; dx = dx + 1) {
            if (dx == 0 && dy == 0) continue;
            int xx = x + dx;
            int yy = y + dy;
            if (xx < 0) xx = W - 1;
            if (yy < 0) yy = H - 1;
            if (xx >= W) xx = 0;
            if (yy >= H) yy = 0;
            n = n + a[yy * W + xx];
          }
        }
        int live = a[y * W + x];
        if (live) b[y * W + x] = (n == 2 || n == 3);
        else b[y * W + x] = (n == 3);
      }
    }
    for (i = 0; i < W * H; i = i + 1) a[i] = b[i];
  }
  int h = 2166136261;
  int pop = 0;
  for (i = 0; i < W * H; i = i + 1) {
    pop = pop + a[i];
    h = mix(h, a[i]);
  }
  printf("life pop=%d\\n", pop);
  return h;
}
`

const CUBE = `${MIX}
/* Rotating wireframe cube: integer sine, perspective, Bresenham, 4 frames. */
int isin(int t) {
  int a = t & 63;
  int quad = a >> 4;
  int x = a & 15;
  int s = (x * (16 - x) * 17) >> 3;
  if (quad == 1) s = 34 - ((15 - x) * (x + 1) * 17 >> 3);
  if (quad == 2) s = 0 - s;
  if (quad == 3) s = 0 - (34 - ((15 - x) * (x + 1) * 17 >> 3));
  return s;
}

int main(void) {
  int W = 20;
  int H = 12;
  int fb[240];
  int i;
  for (i = 0; i < 240; i = i + 1) fb[i] = 0;
  int frame;
  for (frame = 0; frame < 4; frame = frame + 1) {
    int cs = isin(frame * 7 + 16);
    int sn = isin(frame * 7);
    int px[8];
    int py[8];
    int sx[8];
    int sy[8];
    int sz[8];
    sx[0] = -8; sy[0] = -8; sz[0] = -8;
    sx[1] = 8;  sy[1] = -8; sz[1] = -8;
    sx[2] = 8;  sy[2] = 8;  sz[2] = -8;
    sx[3] = -8; sy[3] = 8;  sz[3] = -8;
    sx[4] = -8; sy[4] = -8; sz[4] = 8;
    sx[5] = 8;  sy[5] = -8; sz[5] = 8;
    sx[6] = 8;  sy[6] = 8;  sz[6] = 8;
    sx[7] = -8; sy[7] = 8;  sz[7] = 8;
    int v;
    for (v = 0; v < 8; v = v + 1) {
      int xr = (sx[v] * cs - sz[v] * sn) >> 6;
      int zr = (sx[v] * sn + sz[v] * cs) >> 6;
      int depth = zr + 28;
      px[v] = W / 2 + (xr * 16) / depth;
      py[v] = H / 2 + (sy[v] * 10) / depth;
    }
    int e0;
    int e1;
    int e;
    for (e = 0; e < 12; e = e + 1) {
      if (e < 4) { e0 = e; e1 = (e + 1) & 3; }
      else if (e < 8) { e0 = e; e1 = 4 + ((e + 1) & 3); }
      else { e0 = e - 8; e1 = e - 4; }
      int x0 = px[e0];
      int y0 = py[e0];
      int x1 = px[e1];
      int y1 = py[e1];
      int dx = x1 - x0;
      int dy = y1 - y0;
      if (dx < 0) dx = 0 - dx;
      if (dy < 0) dy = 0 - dy;
      int sxp = 1;
      int syp = 1;
      if (x0 > x1) sxp = 0 - 1;
      if (y0 > y1) syp = 0 - 1;
      int err = dx - dy;
      int x = x0;
      int y = y0;
      int g = 0;
      while (g < 64) {
        if (x >= 0) {
          if (y >= 0) {
            if (x < W) {
              if (y < H) fb[y * W + x] = fb[y * W + x] + 1;
            }
          }
        }
        if (x == x1 && y == y1) break;
        int e2 = err + err;
        if (e2 > 0 - dy) { err = err - dy; x = x + sxp; }
        if (e2 < dx) { err = err + dx; y = y + syp; }
        g = g + 1;
      }
    }
  }
  int h = 2166136261;
  for (i = 0; i < 240; i = i + 1) h = mix(h, fb[i]);
  return h;
}
`

const FIRE = `#include <stdio.h>
${MIX}
/* Classic demo-scene fire: heat diffusion + LCG sparks, 8 frames, 20×14. */
int main(void) {
  int W = 20;
  int H = 14;
  int heat[280];
  int i;
  for (i = 0; i < W * H; i = i + 1) heat[i] = 0;
  int seed = 1234567;
  int frame;
  for (frame = 0; frame < 8; frame = frame + 1) {
    int x;
    for (x = 0; x < W; x = x + 1) {
      seed = seed * 1664525 + 1013904223;
      int spark = seed;
      if (spark < 0) spark = 0 - spark;
      heat[(H - 1) * W + x] = spark % 220 + 30;
    }
    int y;
    for (y = 0; y < H - 1; y = y + 1) {
      for (x = 0; x < W; x = x + 1) {
        int xm = x - 1;
        int xp = x + 1;
        if (xm < 0) xm = 0;
        if (xp >= W) xp = W - 1;
        int s = heat[(y + 1) * W + xm] + heat[(y + 1) * W + x] + heat[(y + 1) * W + xp];
        if (y + 2 < H) s = s + heat[(y + 2) * W + x];
        else s = s + heat[(y + 1) * W + x];
        heat[y * W + x] = s / 4;
        if (heat[y * W + x] > 0) heat[y * W + x] = heat[y * W + x] - 1;
      }
    }
  }
  int h = 2166136261;
  for (i = 0; i < W * H; i = i + 1) h = mix(h, heat[i]);
  printf("fire %d\\n", h);
  return h;
}
`

const NBODY = `#include <stdio.h>
${MIX}
/* Integer N-body: 6 bodies, 1/r^2 with softening, 16 steps, checksum positions. */
int main(void) {
  int N = 6;
  int px[6] = { -80, 80, 0, 0, 50, -50 };
  int py[6] = { 0, 0, -80, 80, 50, -50 };
  int vx[6] = { 0, 0, 2, -2, -1, 1 };
  int vy[6] = { 2, -2, 0, 0, 1, -1 };
  int m[6] = { 8, 8, 8, 8, 5, 5 };
  int step;
  for (step = 0; step < 16; step = step + 1) {
    int ax[6];
    int ay[6];
    int i;
    for (i = 0; i < N; i = i + 1) { ax[i] = 0; ay[i] = 0; }
    for (i = 0; i < N; i = i + 1) {
      int j;
      for (j = 0; j < N; j = j + 1) {
        if (i == j) continue;
        int dx = px[j] - px[i];
        int dy = py[j] - py[i];
        int r2 = dx * dx + dy * dy + 40;
        ax[i] = ax[i] + (m[j] * dx) / r2;
        ay[i] = ay[i] + (m[j] * dy) / r2;
      }
    }
    for (i = 0; i < N; i = i + 1) {
      vx[i] = vx[i] + ax[i];
      vy[i] = vy[i] + ay[i];
      px[i] = px[i] + vx[i];
      py[i] = py[i] + vy[i];
    }
  }
  int h = 2166136261;
  int i;
  for (i = 0; i < N; i = i + 1) {
    h = mix(h, px[i]);
    h = mix(h, py[i]);
  }
  printf("nbody %d\\n", h);
  return h;
}
`

const QUEENS = `#include <stdio.h>

int col[8];
int d1[15];
int d2[15];
int sols;

void search(int y) {
  if (y == 8) {
    sols = sols + 1;
    return;
  }
  int x;
  for (x = 0; x < 8; x = x + 1) {
    if (col[x]) continue;
    if (d1[x + y]) continue;
    if (d2[x - y + 7]) continue;
    col[x] = 1;
    d1[x + y] = 1;
    d2[x - y + 7] = 1;
    search(y + 1);
    col[x] = 0;
    d1[x + y] = 0;
    d2[x - y + 7] = 0;
  }
}

int main(void) {
  int i;
  for (i = 0; i < 8; i = i + 1) col[i] = 0;
  for (i = 0; i < 15; i = i + 1) { d1[i] = 0; d2[i] = 0; }
  sols = 0;
  search(0);
  printf("queens %d\\n", sols);
  return sols;
}
`

const FFT = `#include <stdio.h>
${MIX}
/* 16-point DFT, Q5 twiddles (32 ≈ 1.0). Cos/sin of 2πk/16. */
int main(void) {
  int n = 16;
  int costab[16] = { 32, 30, 23, 12, 0, -12, -23, -30, -32, -30, -23, -12, 0, 12, 23, 30 };
  int sintab[16] = { 0, 12, 23, 30, 32, 30, 23, 12, 0, -12, -23, -30, -32, -30, -23, -12 };
  int x[16];
  int i;
  for (i = 0; i < n; i = i + 1) x[i] = (i * 17 + 3) % 40 - 20;
  int h = 2166136261;
  int energy = 0;
  int k;
  for (k = 0; k < n; k = k + 1) {
    int re = 0;
    int im = 0;
    int t;
    for (t = 0; t < n; t = t + 1) {
      int a = (t * k) & 15;
      re = re + x[t] * costab[a];
      im = im - x[t] * sintab[a];
    }
    re = re >> 5;
    im = im >> 5;
    energy = energy + re * re + im * im;
    h = mix(h, re);
    h = mix(h, im);
  }
  printf("dft e=%d\\n", energy);
  return h;
}
`

const PI = `#include <stdio.h>

/* Machin's formula, scaled integers: π/4 = 4·arctan(1/5) − arctan(1/239). */
int arctan_inv(int x, int scale) {
  int powx = x;
  int s = 0;
  int sign = 1;
  int n;
  for (n = 0; n < 10; n = n + 1) {
    int den = (2 * n + 1) * powx;
    if (den == 0) break;
    int term = scale / den;
    s = s + sign * term;
    sign = 0 - sign;
    if (powx > 2000000) break;
    powx = powx * x * x;
  }
  return s;
}

int main(void) {
  int scale = 100000;
  int pi = 16 * arctan_inv(5, scale) - 4 * arctan_inv(239, scale);
  printf("pi~%d\\n", pi);
  return pi;
}
`

export const C_EXAMPLES: CExample[] = [
  {
    id: 'fib',
    name: 'Recursive fib + printf',
    menuName: 'Recursive fib',
    blurb: 'Recursive Fibonacci(10) with printf. Small C control-flow check.',
    source: SAMPLE_C,
    expectedReturn: 55,
    expectedStdout: { exact: 'fib(10) = 55\n' },
    kind: 'tutorial',
  },
  {
    id: 'hello',
    name: 'Hello world',
    menuName: 'Hello world',
    blurb: 'printf("hello world"). Checks hosted stdout on every ISA.',
    source: HELLO,
    expectedReturn: 0,
    expectedStdout: { exact: 'hello world\n' },
    kind: 'tutorial',
  },
  {
    id: 'sum',
    name: 'Loop sum 1..N',
    menuName: 'C loop sum',
    blurb: 'for-loop sum 1..40 in C. Gold is 820.',
    source: SUM,
    expectedReturn: 820,
    expectedStdout: { exact: '' },
    kind: 'tutorial',
  },
  {
    id: 'ptr',
    name: 'Pointers + malloc',
    menuName: 'Pointers + malloc',
    blurb: 'Heap store through a malloc’d int array, then printf.',
    source: PTR,
    expectedReturn: 30,
    expectedStdout: { exact: '30\n' },
    kind: 'tutorial',
  },
  {
    id: 'struct',
    name: 'Structs, typedef, enum',
    menuName: 'Structs / typedef / enum',
    blurb: 'Record layout, designated initializers, and enum constants.',
    source: STRUCT,
    expectedReturn: 16,
    expectedStdout: { exact: '4 6 6\n' },
    kind: 'tutorial',
  },
  {
    id: 'mandelbrot',
    name: '▸ gfx · Mandelbrot (ASCII + hash)',
    menuName: 'Mandelbrot (ASCII)',
    blurb: 'Software Mandelbrot, 32×12, 12.12 fixed-point. No GPU — every pixel is iterate + escape. ASCII plot plus an FNV hash.',
    source: MANDELBROT,
    expectedReturn: -322095334,
    expectedStdout: { fnv1a: -146420788, length: 407 },
    kind: 'heavy',
  },
  {
    id: 'wolf',
    name: '▸ game · Wolf-like raycast',
    menuName: 'Wolf-like raycast',
    blurb: 'Approximate mini 8×8 raycaster: 24 stepped-ray columns, 16-high slices, framebuffer checksum.',
    source: WOLF,
    expectedReturn: 1968457438,
    expectedStdout: { exact: 'wolf 1968457438\n' },
    kind: 'heavy',
  },
  {
    id: 'life',
    name: '▸ game · Conway Game of Life',
    menuName: 'Conway Game of Life',
    blurb: '20×12 toroidal Life, glider + blinker, 12 generations, population + hash.',
    source: LIFE,
    expectedReturn: 212766499,
    expectedStdout: { exact: 'life pop=8\n' },
    kind: 'heavy',
  },
  {
    id: 'cube',
    name: '▸ gfx · Rotating wireframe cube',
    menuName: 'Wireframe cube',
    blurb: 'Integer sine, perspective project, Bresenham edges, 4 rotation frames, hash the framebuffer.',
    source: CUBE,
    expectedReturn: 1274204170,
    expectedStdout: { exact: '' },
    kind: 'heavy',
  },
  {
    id: 'fire',
    name: '▸ gfx · Demo-scene fire',
    menuName: 'Demo-scene fire',
    blurb: 'Classic fire: LCG sparks on the bottom row, 8 frames of heat diffusion, then a checksum.',
    source: FIRE,
    expectedReturn: -1938390215,
    expectedStdout: { exact: 'fire -1938390215\n' },
    kind: 'heavy',
  },
  {
    id: 'nbody',
    name: '▸ math · N-body gravity',
    menuName: 'N-body gravity',
    blurb: 'Six integer bodies, softened 1/r², 16 steps, checksum of final positions.',
    source: NBODY,
    expectedReturn: -975672083,
    expectedStdout: { exact: 'nbody -975672083\n' },
    kind: 'heavy',
  },
  {
    id: 'queens',
    name: '▸ game · 8-queens search',
    menuName: '8-queens search',
    blurb: 'Recursive 8-queens. Gold is the known 92 solutions on every ISA.',
    source: QUEENS,
    expectedReturn: 92,
    expectedStdout: { exact: 'queens 92\n' },
    kind: 'heavy',
  },
  {
    id: 'fft',
    name: '▸ math · 16-point integer DFT',
    menuName: '16-point DFT',
    blurb: '16-point DFT with Q5 cos/sin twiddles. Returns a coefficient hash; prints energy.',
    source: FFT,
    expectedReturn: 476065557,
    expectedStdout: { exact: 'dft e=35566\n' },
    kind: 'heavy',
  },
  {
    id: 'pi',
    name: '▸ math · Machin π (scaled)',
    menuName: 'Machin π',
    blurb: 'π/4 = 4·arctan(1/5) − arctan(1/239) in scaled integers. Gold is the same series.',
    source: PI,
    expectedReturn: 314168,
    expectedStdout: { exact: 'pi~314168\n' },
    kind: 'heavy',
  },
]

export function cWorkloadId(ex: CExample): string {
  return `${C_WORKLOAD_PREFIX}${ex.id}`
}

export function isCWorkload(id: string): boolean {
  return id.startsWith(C_WORKLOAD_PREFIX)
}

export function cExampleByWorkloadId(id: string): CExample | undefined {
  if (!isCWorkload(id)) return undefined
  return C_EXAMPLES.find((e) => e.id === id.slice(C_WORKLOAD_PREFIX.length))
}
