/** Premade C programs for the guest compiler. `heavy` ones are software gfx / games / math. */
export interface CExample {
    id: string;
    name: string;
    /** Short label in the main Program dropdown. */
    menuName: string;
    blurb: string;
    source: string;
    /** Independent oracle; never derived from the live IR gold run. */
    expectedReturn: number;
    expectedStdout: {
        exact: string;
    } | {
        fnv1a: number;
        length: number;
    };
    /** Tutorial snippets stay tiny. Heavy kernels are still bounded so MOS can finish. */
    kind: 'tutorial' | 'heavy';
}
export declare const C_WORKLOAD_PREFIX = "c-";
export declare const SAMPLE_C = "#include <stdio.h>\n\nint fib(int n) {\n  if (n <= 1) return n;\n  return fib(n - 1) + fib(n - 2);\n}\n\nint main(void) {\n  int n = 10;\n  int v = fib(n);\n  printf(\"fib(%d) = %d\\n\", n, v);\n  return v;\n}\n";
export declare const C_EXAMPLES: CExample[];
export declare function cWorkloadId(ex: CExample): string;
export declare function isCWorkload(id: string): boolean;
export declare function cExampleByWorkloadId(id: string): CExample | undefined;
//# sourceMappingURL=programs.d.ts.map