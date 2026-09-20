export type TokKind =
  | 'ident'
  | 'int'
  | 'float'
  | 'str'
  | 'char'
  | 'kw'
  | 'punct'
  | 'eof'

export interface Tok {
  kind: TokKind
  text: string
  value?: number | string
  line: number
  col: number
}

const KEYWORDS = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do',
  'double', 'else', 'enum', 'extern', 'float', 'for', 'goto', 'if',
  'inline', 'int', 'long', 'register', 'restrict', 'return', 'short',
  'signed', 'sizeof', 'static', 'struct', 'switch', 'typedef', 'union',
  'unsigned', 'void', 'volatile', 'while', '_Bool', 'bool',
  '_Generic', '_Static_assert', '_Alignof', '_Thread_local',
])

const PUNCT = [
  '...', '>>=', '<<=', '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=',
  '==', '!=', '<=', '>=', '&&', '||', '++', '--', '->', '<<', '>>',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '=', '<', '>',
  '?', ':', ',', ';', '.', '(', ')', '[', ']', '{', '}',
]

export class CError extends Error {
  line: number
  col: number
  constructor(message: string, line: number, col: number) {
    super(`C:${line}:${col}: ${message}`)
    this.name = 'CError'
    this.line = line
    this.col = col
  }
}

interface Macro {
  params?: string[]
  body: string
}

function evalIf(expr: string, macros: Map<string, Macro>): boolean {
  let s = expr.trim()
  s = s.replace(/defined\s*\(\s*([A-Za-z_]\w*)\s*\)/g, (_, n) => (macros.has(n) ? '1' : '0'))
  s = s.replace(/defined\s+([A-Za-z_]\w*)/g, (_, n) => (macros.has(n) ? '1' : '0'))
  s = s.replace(/\b([A-Za-z_]\w*)\b/g, (name) => {
    if (name === 'defined') return name
    const m = macros.get(name)
    if (!m || m.params) return '0'
    const n = Number(m.body)
    return Number.isFinite(n) ? String(n | 0) : '0'
  })
  s = s.replace(/&&/g, '&').replace(/\|\|/g, '|').replace(/!/g, '1-')
  try {
    // eslint-disable-next-line no-new-func
    const v = Function(`"use strict"; return (${s});`)()
    return !!v
  } catch {
    return false
  }
}

function expandMacros(line: string, macros: Map<string, Macro>, busy: Set<string>): string {
  let out = ''
  let i = 0
  while (i < line.length) {
    const c = line[i]
    if (c === '"' || c === "'") {
      const q = c
      let j = i + 1
      while (j < line.length && line[j] !== q) {
        if (line[j] === '\\') j += 1
        j += 1
      }
      out += line.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1
      while (j < line.length && /[A-Za-z0-9_]/.test(line[j])) j += 1
      const name = line.slice(i, j)
      const m = macros.get(name)
      if (!m || busy.has(name)) {
        out += name
        i = j
        continue
      }
      if (m.params) {
        let k = j
        while (k < line.length && (line[k] === ' ' || line[k] === '\t')) k += 1
        if (line[k] !== '(') {
          out += name
          i = j
          continue
        }
        k += 1
        const args: string[] = []
        let cur = ''
        let depth = 1
        while (k < line.length && depth) {
          const ch = line[k]
          if (ch === '(') depth += 1
          if (ch === ')') depth -= 1
          if (ch === ',' && depth === 1) {
            args.push(cur.trim())
            cur = ''
          } else if (depth) cur += ch
          k += 1
        }
        if (cur.trim() || args.length < m.params.length) args.push(cur.trim())
        let body = m.body
        for (let p = 0; p < m.params.length; p++) {
          body = body.replace(new RegExp(`\\b${m.params[p]}\\b`, 'g'), args[p] ?? '')
        }
        const next = new Set(busy)
        next.add(name)
        out += expandMacros(body, macros, next)
        i = k
        continue
      }
      const next = new Set(busy)
      next.add(name)
      out += expandMacros(m.body, macros, next)
      i = j
      continue
    }
    out += c
    i += 1
  }
  return out
}

export function preprocess(src: string): string {
  const joined = src.replace(/\r\n/g, '\n').replace(/\\\n/g, '')
  const macros = new Map<string, Macro>()
  const out: string[] = []
  const stack: { take: boolean; parent: boolean; hadElse: boolean }[] = []
  const active = () => !stack.length || stack.every((s) => s.take)

  for (const raw of joined.split('\n')) {
    const trimmed = raw.trim()
    if (trimmed.startsWith('#')) {
      const body = trimmed.replace(/^#\s*/, '')
      if (/^include\b/.test(body)) {
        out.push('')
        continue
      }
      if (/^undef\s+([A-Za-z_]\w*)/.test(body)) {
        if (active()) macros.delete(RegExp.$1)
        out.push('')
        continue
      }
      const def = /^define\s+([A-Za-z_]\w*)(\(([^)]*)\))?\s*(.*)$/.exec(body)
      if (def) {
        if (active()) {
          const params = def[2] ? def[3].split(',').map((s) => s.trim()).filter(Boolean) : undefined
          macros.set(def[1], { params, body: def[4] })
        }
        out.push('')
        continue
      }
      if (/^ifdef\s+([A-Za-z_]\w*)/.test(body)) {
        stack.push({ take: active() && macros.has(RegExp.$1), parent: active(), hadElse: false })
        out.push('')
        continue
      }
      if (/^ifndef\s+([A-Za-z_]\w*)/.test(body)) {
        stack.push({ take: active() && !macros.has(RegExp.$1), parent: active(), hadElse: false })
        out.push('')
        continue
      }
      if (/^if\b/.test(body)) {
        stack.push({ take: active() && evalIf(body.slice(2), macros), parent: active(), hadElse: false })
        out.push('')
        continue
      }
      if (/^elif\b/.test(body)) {
        const top = stack[stack.length - 1]
        if (top && !top.hadElse && top.parent && !top.take) top.take = evalIf(body.slice(4), macros)
        else if (top) top.take = false
        out.push('')
        continue
      }
      if (/^else\b/.test(body)) {
        const top = stack[stack.length - 1]
        if (top && !top.hadElse) {
          top.take = top.parent && !top.take
          top.hadElse = true
        }
        out.push('')
        continue
      }
      if (/^endif\b/.test(body)) {
        stack.pop()
        out.push('')
        continue
      }
      out.push('')
      continue
    }
    out.push(active() ? expandMacros(raw, macros, new Set()) : '')
  }
  return out.join('\n')
}

export function lex(source: string): Tok[] {
  const src = preprocess(source)
  const toks: Tok[] = []
  let i = 0
  let line = 1
  let col = 1

  const peek = (n = 0) => src[i + n] ?? ''
  const bump = () => {
    const c = src[i] ?? ''
    i += 1
    if (c === '\n') {
      line += 1
      col = 1
    } else col += 1
    return c
  }

  const at = (line0: number, col0: number): Pick<Tok, 'line' | 'col'> => ({
    line: line0,
    col: col0,
  })

  while (i < src.length) {
    const c = peek()
    const line0 = line
    const col0 = col
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
      bump()
      continue
    }
    if (c === '/' && peek(1) === '/') {
      while (i < src.length && peek() !== '\n') bump()
      continue
    }
    if (c === '/' && peek(1) === '*') {
      bump()
      bump()
      while (i < src.length && !(peek() === '*' && peek(1) === '/')) bump()
      if (i >= src.length) throw new CError('unterminated comment', line0, col0)
      bump()
      bump()
      continue
    }
    if (c === '"' || c === "'") {
      const q = bump()
      let s = ''
      while (i < src.length && peek() !== q) {
        if (peek() === '\\') {
          bump()
          const e = bump()
          const map: Record<string, string> = {
            n: '\n',
            t: '\t',
            r: '\r',
            '0': '\0',
            '\\': '\\',
            "'": "'",
            '"': '"',
          }
          s += map[e] ?? e
        } else s += bump()
      }
      if (peek() !== q) throw new CError('unterminated string', line0, col0)
      bump()
      if (q === '"') toks.push({ kind: 'str', text: s, value: s, ...at(line0, col0) })
      else toks.push({ kind: 'char', text: s, value: s.charCodeAt(0) || 0, ...at(line0, col0) })
      continue
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(peek(1)))) {
      let t = ''
      let isFloat = false
      if (c === '0' && (peek(1) === 'x' || peek(1) === 'X')) {
        t += bump() + bump()
        while (/[0-9a-fA-F]/.test(peek())) t += bump()
        toks.push({ kind: 'int', text: t, value: Number.parseInt(t, 16), ...at(line0, col0) })
        continue
      }
      while (/[0-9]/.test(peek())) t += bump()
      if (peek() === '.') {
        isFloat = true
        t += bump()
        while (/[0-9]/.test(peek())) t += bump()
      }
      if (peek() === 'e' || peek() === 'E') {
        isFloat = true
        t += bump()
        if (peek() === '+' || peek() === '-') t += bump()
        while (/[0-9]/.test(peek())) t += bump()
      }
      while (/[uUlLfF]/.test(peek())) bump()
      if (isFloat) toks.push({ kind: 'float', text: t, value: Number(t), ...at(line0, col0) })
      else toks.push({ kind: 'int', text: t, value: Number(t), ...at(line0, col0) })
      continue
    }
    if (/[A-Za-z_]/.test(c)) {
      let t = ''
      while (/[A-Za-z0-9_]/.test(peek())) t += bump()
      toks.push({
        kind: KEYWORDS.has(t) ? 'kw' : 'ident',
        text: t,
        ...at(line0, col0),
      })
      continue
    }
    let matched = ''
    for (const p of PUNCT) {
      if (src.startsWith(p, i) && p.length > matched.length) matched = p
    }
    if (!matched) throw new CError(`unexpected '${c}'`, line0, col0)
    for (let k = 0; k < matched.length; k++) bump()
    toks.push({ kind: 'punct', text: matched, ...at(line0, col0) })
  }
  toks.push({ kind: 'eof', text: '', line, col })
  return toks
}
