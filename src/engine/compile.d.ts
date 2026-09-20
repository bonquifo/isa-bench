import { type IrProgram } from './ir.ts';
import { type IsaId as IsaIdT, type Program } from './types.ts';
export declare function compile(prog: IrProgram, isa: IsaIdT): Program;
export declare function disassemble(program: Program, limit?: number): string[];
//# sourceMappingURL=compile.d.ts.map