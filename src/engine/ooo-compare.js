import { valuesEqual } from './bits.ts';
import { buildInput, cloneMem, hardwareFor, selectedIsas, } from './compare.ts';
import { compile } from './compile.ts';
import { interpretIr } from './ir.ts';
import { IR_REFERENCE_MODEL_VERSION, interpretIrWorkers, } from './ir-reference.ts';
import { stableSerialize } from './measurement.ts';
import { simulateOoO } from './ooo.ts';
import { DEFAULT_OOO_PROFILE, OOO_MODEL_VERSION, validateOoOProfile, } from './ooo-types.ts';
export function runOoOComparison(input) {
    const profile = validateOoOProfile(input.oooProfile ?? DEFAULT_OOO_PROFILE);
    const isas = selectedIsas(input);
    const built = buildInput(input);
    const custom = built.workload.kind === 'custom-ir' || built.workload.kind === 'custom-c';
    const gold = custom && built.workload.parallelSemantics === 'source-defined'
        ? interpretIrWorkers(built.ir, cloneMem(built.memory), built.maxWorkers)
        : interpretIr(built.ir, cloneMem(built.memory));
    if (!valuesEqual(gold.value, built.expected, built.fp)) {
        throw new Error(`Internal OoO gold mismatch for ${built.name}: IR=${gold.value} expected=${built.expected}`);
    }
    const rows = isas.map((isa) => {
        const program = compile(built.ir, isa);
        const row = simulateOoO(program, hardwareFor(isa, input), cloneMem(built.memory), {
            maxWorkers: built.maxWorkers,
            profile,
        });
        row.matchedGold = valuesEqual(row.result, gold.value, built.fp) && row.stdout === gold.stdout;
        if (!row.matchedGold) {
            throw new Error(`${isa} OoO result/stdout ${String(row.result)}/${JSON.stringify(row.stdout)} ` +
                `does not match reference ${String(gold.value)}/${JSON.stringify(gold.stdout)}`);
        }
        return row;
    });
    const createdAt = new Date().toISOString();
    const workloadHash = sha256(stableSerialize({
        workloadId: input.workloadId,
        n: input.n,
        seed: input.seed,
        source: built.source,
        workload: built.workload,
    }));
    const pipelineHash = sha256(stableSerialize({ model: OOO_MODEL_VERSION, lowerer: 'MachInst-DecodedOp-v1' }));
    const roiHash = sha256('whole-program-through-full-store-drain-v1');
    const inputIdentity = sha256(stableSerialize(input));
    const envelopes = rows.map((row) => {
        const profileHash = sha256(stableSerialize({
            ooo: profile,
            hardware: hardwareFor(row.isa, input),
        }));
        const comparison = {
            experimentKind: 'analytical-ooo',
            modelVersion: OOO_MODEL_VERSION,
            workloadSemanticHash: workloadHash,
            artifactPipelineHash: pipelineHash,
            roiDefinitionHash: roiHash,
            profileConfigFingerprint: profileHash,
            metricDomain: 'analytical-model-cycles',
            unit: 'model-cycle',
        };
        return {
            schemaVersion: '0.1.0',
            modelVersion: OOO_MODEL_VERSION,
            referenceModelVersion: IR_REFERENCE_MODEL_VERSION,
            adapterVersion: '1.0.0',
            experimentKind: 'analytical-ooo',
            claimClass: 'analytical-estimate',
            evidenceClass: 'model-output',
            inputIdentity,
            artifactIdentities: [pipelineHash],
            comparisonGroupKey: sha256(stableSerialize(comparison)),
            comparison,
            createdAt,
            metrics: [
                { name: 'cycles', domain: 'analytical-model-cycles', unit: 'model-cycle', value: row.cycles },
                { name: 'energy', domain: 'analytical-model-nj', unit: 'model-nJ', value: row.totalEnergyNj },
            ],
            modelPayload: row,
        };
    });
    return {
        modelVersion: OOO_MODEL_VERSION,
        referenceModelVersion: IR_REFERENCE_MODEL_VERSION,
        modelKind: 'deterministic-isa-inspired-decoded-op-ooo',
        claimScope: 'analytical-model-only',
        profile,
        gold: gold.value,
        fp: built.fp,
        stdout: gold.stdout,
        workloadId: input.workloadId,
        workloadName: built.name,
        workload: built.workload,
        rows,
        envelopes,
    };
}
export async function runOoOComparisonAsync(input, onProgress, options = {}) {
    const signal = options.signal;
    const checkpoint = () => {
        if (signal?.aborted)
            throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    };
    checkpoint();
    onProgress({ ratio: 0.05, phase: 'OOO-LINK', detail: 'validating analytical OoO profile' });
    await Promise.resolve();
    checkpoint();
    onProgress({ ratio: 0.15, phase: 'OOO-REFERENCE', detail: 'building shared workload and reference' });
    await Promise.resolve();
    checkpoint();
    onProgress({ ratio: 0.25, phase: 'OOO-MODEL', detail: 'running deterministic decoded-op model' });
    const result = runOoOComparison(input);
    checkpoint();
    onProgress({ ratio: 1, phase: 'OOO-MATCH', detail: 'all target outputs match reference' });
    return result;
}
// Small synchronous SHA-256 used for contracts identities in browser and Node.
function sha256(text) {
    const bytes = [...new TextEncoder().encode(text)];
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56)
        bytes.push(0);
    const high = Math.floor(bitLength / 0x1_0000_0000);
    const low = bitLength >>> 0;
    for (let shift = 24; shift >= 0; shift -= 8)
        bytes.push((high >>> shift) & 0xff);
    for (let shift = 24; shift >= 0; shift -= 8)
        bytes.push((low >>> shift) & 0xff);
    const h = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];
    const k = Array.from({ length: 64 }, (_, index) => {
        const prime = nthPrime(index + 1);
        return Math.floor((Math.cbrt(prime) % 1) * 0x1_0000_0000) >>> 0;
    });
    const rotate = (value, amount) => (value >>> amount) | (value << (32 - amount));
    for (let offset = 0; offset < bytes.length; offset += 64) {
        const w = new Uint32Array(64);
        for (let index = 0; index < 16; index++) {
            const at = offset + index * 4;
            w[index] = ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
        }
        for (let index = 16; index < 64; index++) {
            const s0 = rotate(w[index - 15], 7) ^ rotate(w[index - 15], 18) ^ (w[index - 15] >>> 3);
            const s1 = rotate(w[index - 2], 17) ^ rotate(w[index - 2], 19) ^ (w[index - 2] >>> 10);
            w[index] = (w[index - 16] + s0 + w[index - 7] + s1) >>> 0;
        }
        let [a, b, c, d, e, f, g, hh] = h;
        for (let index = 0; index < 64; index++) {
            const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (hh + s1 + ch + k[index] + w[index]) >>> 0;
            const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (s0 + maj) >>> 0;
            hh = g;
            g = f;
            f = e;
            e = (d + t1) >>> 0;
            d = c;
            c = b;
            b = a;
            a = (t1 + t2) >>> 0;
        }
        for (const [index, value] of [a, b, c, d, e, f, g, hh].entries())
            h[index] = (h[index] + value) >>> 0;
    }
    return h.map((value) => value.toString(16).padStart(8, '0')).join('');
}
function nthPrime(n) {
    let found = 0;
    for (let candidate = 2;; candidate++) {
        let prime = true;
        for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
            if (candidate % divisor === 0) {
                prime = false;
                break;
            }
        }
        if (prime && ++found === n)
            return candidate;
    }
}
//# sourceMappingURL=ooo-compare.js.map