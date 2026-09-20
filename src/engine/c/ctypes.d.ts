export type CType = {
    kind: 'void';
} | {
    kind: 'int';
} | {
    kind: 'char';
    signed: true;
} | {
    kind: 'double';
} | {
    kind: 'ptr';
    to: CType;
} | {
    kind: 'array';
    to: CType;
    len: number;
} | {
    kind: 'fn';
    ret: CType;
    params: CType[];
    variadic: boolean;
} | {
    kind: 'record';
    rec: 'struct' | 'union';
    tag: string;
};
export interface Field {
    name: string;
    ty: CType;
    off: number;
    bits?: number;
    bitOff?: number;
}
export interface RecordDef {
    rec: 'struct' | 'union';
    tag: string;
    fields: Field[];
    size: number;
    align: number;
    complete: boolean;
}
export interface TypeEnv {
    records: Map<string, RecordDef>;
    enums: Map<string, number>;
    typedefs: Map<string, CType>;
}
export declare function emptyEnv(): TypeEnv;
export declare function cloneType(ty: CType): CType;
export declare function alignOf(ty: CType, env: TypeEnv): number;
export declare function sizeOf(ty: CType, env: TypeEnv): number;
export declare function decay(ty: CType): CType;
export declare function isFloat(ty: CType): boolean;
export declare function isPtr(ty: CType): boolean;
export declare function isAgg(ty: CType): boolean;
export declare function typesEq(a: CType, b: CType): boolean;
export declare function fieldOf(ty: CType, name: string, env: TypeEnv): Field;
export declare function flattenFields(fields: Field[], env: TypeEnv): Field[];
export declare function layoutRecord(rec: 'struct' | 'union', tag: string, raw: {
    name: string;
    ty: CType;
    bits?: number;
}[], env: TypeEnv): RecordDef;
//# sourceMappingURL=ctypes.d.ts.map