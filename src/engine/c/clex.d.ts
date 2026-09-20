export type TokKind = 'ident' | 'int' | 'float' | 'str' | 'char' | 'kw' | 'punct' | 'eof';
export interface Tok {
    kind: TokKind;
    text: string;
    value?: number | string;
    line: number;
    col: number;
}
export declare class CError extends Error {
    line: number;
    col: number;
    constructor(message: string, line: number, col: number);
}
export declare function preprocess(src: string): string;
export declare function lex(source: string): Tok[];
//# sourceMappingURL=clex.d.ts.map