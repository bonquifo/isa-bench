import { describe, expect, it } from 'vitest'
import { CError, lex, preprocess } from './clex.ts'

describe('C preprocessor', () => {
  it('expands object-like and function-like macros', () => {
    const out = preprocess(`
      #define N 4
      #define SQR(x) ((x)*(x))
      int x = SQR(N);
    `)
    expect(out).toMatch(/int x = \(\(4\)\*\(4\)\);/)
  })

  it('respects #ifdef / #ifndef / #else / #endif', () => {
    const src = `
      #define YES
      #ifdef YES
      A
      #else
      B
      #endif
      #ifndef NO
      C
      #endif
      #ifdef NO
      D
      #endif
    `
    const out = preprocess(src)
    expect(out).toMatch(/\bA\b/)
    expect(out).not.toMatch(/\bB\b/)
    expect(out).toMatch(/\bC\b/)
    expect(out).not.toMatch(/\bD\b/)
  })

  it('evaluates #if defined() and #elif', () => {
    const out = preprocess(`
      #define FLAG 1
      #if defined(FLAG) && FLAG
      TAKE
      #elif 1
      SKIP
      #endif
      #if defined(MISSING)
      NO
      #endif
    `)
    expect(out).toMatch(/TAKE/)
    expect(out).not.toMatch(/SKIP/)
    expect(out).not.toMatch(/NO/)
  })

  it('undefines macros and ignores #include', () => {
    const out = preprocess(`
      #define X 1
      #undef X
      #ifdef X
      STILL
      #endif
      #include <stdio.h>
      int main(void);
    `)
    expect(out).not.toMatch(/STILL/)
    expect(out).toMatch(/int main/)
  })

  it('joins backslash-continued lines before lexing', () => {
    const out = preprocess('int lon\\\ngname;')
    expect(out).toMatch(/int longname;/)
  })
})

describe('C lexer', () => {
  it('classifies keywords, idents, ints, double literals, strings, and chars', () => {
    const toks = lex('int x = 0x2A + 3.5e1 + \'A\' + "hi\\n";')
    const kinds = toks.filter((t) => t.kind !== 'eof').map((t) => t.kind)
    expect(kinds).toContain('kw')
    expect(kinds).toContain('ident')
    expect(kinds).toContain('int')
    expect(kinds).toContain('float')
    expect(kinds).toContain('char')
    expect(kinds).toContain('str')
    expect(toks.find((t) => t.kind === 'int' && t.text.startsWith('0x'))?.value).toBe(0x2a)
    expect(toks.find((t) => t.kind === 'char')?.value).toBe(65)
    expect(toks.find((t) => t.kind === 'str')?.value).toBe('hi\n')
  })

  it('recognizes multi-character punctuators', () => {
    const texts = lex('a <<= 1 && b != c ? d : e;').map((t) => t.text)
    expect(texts).toContain('<<=')
    expect(texts).toContain('&&')
    expect(texts).toContain('!=')
    expect(texts).toContain('?')
  })

  it('strips // and /* */ comments', () => {
    const toks = lex('int x = 1; // c\n /* block */ int y = 2;')
    expect(toks.filter((t) => t.kind === 'ident').map((t) => t.text)).toEqual(['x', 'y'])
  })

  it('throws CError with a line number on junk and unterminated constructs', () => {
    expect(() => lex('@')).toThrow(CError)
    expect(() => lex('@')).toThrow(/C:1:/)
    expect(() => lex('/* oops')).toThrow(/unterminated comment/)
    expect(() => lex('"oops')).toThrow(/unterminated string/)
  })
})
