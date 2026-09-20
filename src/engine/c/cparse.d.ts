import { CError } from './clex.ts';
import { type CType, type TypeEnv } from './ctypes.ts';
export type { CType, TypeEnv } from './ctypes.ts';
export type Expr = {
    kind: 'int';
    value: number;
} | {
    kind: 'float';
    value: number;
} | {
    kind: 'str';
    value: string;
} | {
    kind: 'ident';
    name: string;
} | {
    kind: 'unary';
    op: string;
    expr: Expr;
} | {
    kind: 'binary';
    op: string;
    a: Expr;
    b: Expr;
} | {
    kind: 'assign';
    op: string;
    lhs: Expr;
    rhs: Expr;
} | {
    kind: 'call';
    callee: Expr;
    args: Expr[];
} | {
    kind: 'index';
    base: Expr;
    index: Expr;
} | {
    kind: 'member';
    base: Expr;
    field: string;
    arrow: boolean;
} | {
    kind: 'cast';
    ty: CType;
    expr: Expr;
} | {
    kind: 'sizeof';
    ty?: CType;
    expr?: Expr;
} | {
    kind: 'alignof';
    ty: CType;
} | {
    kind: 'cond';
    c: Expr;
    t: Expr;
    f: Expr;
} | {
    kind: 'comma';
    items: Expr[];
} | {
    kind: 'compound';
    ty: CType;
    init: Init;
} | {
    kind: 'generic';
    ctrl: Expr;
    assocs: {
        ty?: CType;
        expr: Expr;
    }[];
};
export type Designator = {
    kind: 'field';
    name: string;
} | {
    kind: 'index';
    index: number;
};
export type Init = {
    kind: 'expr';
    expr: Expr;
} | {
    kind: 'list';
    items: {
        designators: Designator[];
        init: Init;
    }[];
};
export interface VarDecl {
    name: string;
    ty: CType;
    init?: Init;
    vla?: Expr;
    storage?: 'static' | 'auto' | 'extern';
}
export type Stmt = {
    kind: 'block';
    stmts: Stmt[];
} | {
    kind: 'expr';
    expr: Expr;
} | {
    kind: 'if';
    cond: Expr;
    then: Stmt;
    else?: Stmt;
} | {
    kind: 'while';
    cond: Expr;
    body: Stmt;
} | {
    kind: 'do';
    cond: Expr;
    body: Stmt;
} | {
    kind: 'for';
    init?: Stmt;
    cond?: Expr;
    step?: Expr;
    body: Stmt;
} | {
    kind: 'return';
    expr?: Expr;
} | {
    kind: 'break';
} | {
    kind: 'continue';
} | {
    kind: 'goto';
    name: string;
} | {
    kind: 'label';
    name: string;
} | {
    kind: 'switch';
    expr: Expr;
    body: Stmt[];
} | {
    kind: 'case';
    value: number;
} | {
    kind: 'default';
} | {
    kind: 'decl';
    decls: VarDecl[];
} | {
    kind: 'static_assert';
    ok: boolean;
    msg: string;
};
export interface Param {
    name: string;
    ty: CType;
}
export interface FnDecl {
    name: string;
    ret: CType;
    params: Param[];
    variadic: boolean;
    explicitVoid: boolean;
    body?: Stmt;
}
export interface GlobalDecl {
    name: string;
    ty: CType;
    init?: Init;
}
export interface CProgram {
    fns: FnDecl[];
    globals: GlobalDecl[];
    env: TypeEnv;
}
export declare function parseC(source: string): CProgram;
export { CError };
//# sourceMappingURL=cparse.d.ts.map