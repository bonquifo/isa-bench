export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US')
}

export function fmtFixed(n: number, digits = 2): string {
  const special = fmtIeee(n)
  if (special) return special
  return n.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function fmtNum(n: number, fp: boolean): string {
  const special = fmtIeee(n)
  if (special) return special
  if (fp) return fmtFixed(n, 6)
  return (n | 0).toLocaleString('en-US')
}

export function fmtIeee(n: number): string | null {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'Infinity'
  if (n === -Infinity) return '-Infinity'
  if (Object.is(n, -0)) return '-0'
  return null
}

export function fmtNs(cycles: number, mhz: number): string {
  const us = cycles / mhz
  if (us >= 1000) return `${fmtFixed(us / 1000, 3)} ms`
  if (us >= 1) return `${fmtFixed(us, 2)} µs`
  return `${fmtFixed(us * 1000, 2)} ns`
}

export function pct(part: number, whole: number): string {
  if (whole === 0) return '0%'
  return `${fmtFixed((100 * part) / whole, 1)}%`
}

export function fmtMult(n: number): string {
  if (!Number.isFinite(n)) return '—'
  return `${n.toFixed(2)}×`
}

export function signedPct(n: number): string {
  // An undefined relative change is not parity, so it reads as em dash like
  // fmtMult rather than collapsing to 0%.
  if (!Number.isFinite(n)) return '—'
  if (Math.abs(n) < 0.05) return '0%'
  const sign = n > 0 ? '+' : ''
  return `${sign}${fmtFixed(n, 1)}%`
}

export function download(filename: string, text: string, type = 'text/plain'): void {
  const blob = new Blob([text], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
