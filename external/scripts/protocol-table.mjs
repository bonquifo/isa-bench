// Renders the generated tables in docs/PROTOCOL.md from the data the server
// actually enforces, so the document cannot drift from it: the research
// simulator matrix from external/capabilities.lock.json and the native corpus
// eligibility summary from the artifact index that lock is bound to.
// `--check` fails instead of writing.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import process from 'node:process'

const root = resolve(import.meta.dirname, '..', '..')
const docPath = resolve(root, 'docs/PROTOCOL.md')
const engines = ['gem5', 'llvm-mca', 'champsim']
const corpusTargets = [
  'x86_64-linux', 'aarch64-linux', 'riscv64-linux', 'mipsel-o32',
  'powerpc64le-elfv2', 'sparc-v8', 'wasm32-wasip1', 'mos-sim',
]
const reasonLimit = 120

const sections = [
  {
    begin: '<!-- external-capabilities:begin -->',
    end: '<!-- external-capabilities:end -->',
    render: renderCapabilities,
  },
  {
    begin: '<!-- native-corpus:begin -->',
    end: '<!-- native-corpus:end -->',
    render: renderCorpus,
  },
]

const original = await readFile(docPath, 'utf8')
let document = original
const drifted = []
for (const section of sections) {
  const start = document.indexOf(section.begin)
  const stop = document.indexOf(section.end)
  if (start < 0 || stop < 0 || stop < start) {
    throw new Error(`docs/PROTOCOL.md must contain ${section.begin} … ${section.end} markers`)
  }
  const rendered = `\n${await section.render()}\n`
  if (document.slice(start + section.begin.length, stop) !== rendered) drifted.push(section.begin)
  document = `${document.slice(0, start + section.begin.length)}${rendered}${document.slice(stop)}`
}

if (process.argv.includes('--check')) {
  if (drifted.length > 0) {
    process.stderr.write(`docs/PROTOCOL.md generated sections differ from their sources (${drifted.join(', ')}); run \`npm run docs:external\`\n`)
    process.exit(1)
  }
  process.stdout.write('docs/PROTOCOL.md generated sections match their sources\n')
} else if (document !== original) {
  await writeFile(docPath, document)
  process.stdout.write(`docs/PROTOCOL.md regenerated (${drifted.join(', ')})\n`)
} else {
  process.stdout.write('docs/PROTOCOL.md generated sections already current\n')
}

async function renderCapabilities() {
  const lock = JSON.parse(await readFile(resolve(root, 'external/capabilities.lock.json'), 'utf8'))
  const observations = lock.observations ?? {}
  const rows = []
  for (const engine of engines) {
    // One row per distinct (tier, reason) in first-seen target order, so the
    // table stays as compact as the hand-written one it replaces.
    const groups = new Map()
    for (const [key, value] of Object.entries(observations)) {
      if (!key.startsWith(`${engine}:`)) continue
      const target = key.slice(engine.length + 1)
      const tier = String(value.tier ?? 'unsupported')
      const reason = abbreviate(String(value.reason ?? ''))
      const id = `${tier}\0${reason}`
      if (!groups.has(id)) groups.set(id, { tier, reason, targets: [] })
      groups.get(id).targets.push(target)
    }
    for (const { tier, reason, targets } of groups.values()) {
      rows.push(`| ${engine} | ${targets.map(code).join(', ')} | ${tier} | ${reason} |`)
    }
  }
  return [
    'Generated from `external/capabilities.lock.json` by `npm run docs:external`; the lock is authoritative and reasons are abbreviated.',
    '',
    '| Engine | Targets | Observed tier | Reason |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

async function renderCorpus() {
  const indexPath = resolve(root, '.isa-bench-data/native-corpus/artifact-index.json')
  if (!existsSync(indexPath)) throw new Error('native corpus index is missing; run `npm run native-corpus:build`')
  const index = JSON.parse(await readFile(indexPath, 'utf8'))
  const records = Array.isArray(index.records) ? index.records : []
  const workloads = new Set(records.map((record) => record.workload))
  const rows = corpusTargets.map((target) => {
    const own = records.filter((record) => record.target === target)
    const eligible = own.filter((record) => record.eligible)
    const notes = own.filter((record) => !record.eligible)
      .map((record) => `\`${record.workload}\`: ${abbreviate(ineligibleReason(record))}`)
    const note = own.length === 0
      ? 'not built in this index'
      : notes.length > 0 ? notes.join('; ') : 'all workloads measurement-eligible'
    return `| ${code(target)} | ${eligible.length} / ${workloads.size} workloads | ${note} |`
  })
  return [
    `Generated from the \`${index.mode ?? 'unknown'}\` index of corpus \`${index.corpusVersion ?? 'unknown'}\` by \`npm run docs:external\`; counts are this machine's observed eligibility (two clean builds + independent result-frame check).`,
    '',
    '| Target | Eligible artifacts | Notes |',
    '| --- | --- | --- |',
    ...rows,
  ].join('\n')
}

function ineligibleReason(record) {
  for (const candidate of [record.ineligibleReason, record.reason, record.unsupportedReason, record.eligibility?.reason]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate
  }
  return 'ineligible'
}

function code(value) {
  return `\`${value}\``
}

function abbreviate(reason) {
  const single = reason.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim()
  return single.length > reasonLimit ? `${single.slice(0, reasonLimit - 1).trimEnd()}…` : single
}
