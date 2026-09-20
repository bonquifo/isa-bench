import { cache, cpu } from './cpus_build.ts';
import { chipDefaults } from './hardware.ts';
const G = {
    classic: 'MIPS · classic / SGI',
    synth: 'MIPS · synthesizable',
    soc: 'MIPS · SoC / networking',
    game: 'MIPS · consoles / China',
};
export const MIPS_CPUS = [
    cpu('r2000', 'MIPS R2000', 'MIPS', 1986, 'mips', 'First commercial MIPS, 5-stage, no on-chip cache.', {
        clockMhz: 16, issueWidth: 1, pipelineStages: 5, fetchWidth: 4,
        l1i: cache(4096, 1, 16), l1d: cache(4096, 1, 16), memLatency: 4,
        predictor: 'none', predEntries: 4, mispredictPenalty: 2, staticPowerMw: 4,
    }, G.classic),
    cpu('r3000', 'MIPS R3000', 'MIPS', 1988, 'mips', 'DECstation / PS1-class 5-stage.', {
        clockMhz: 40, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(8192, 1, 16), l1d: cache(8192, 1, 16), memLatency: 4,
        predictor: 'none', predEntries: 4, mispredictPenalty: 2, staticPowerMw: 8,
    }, G.classic),
    cpu('r4000', 'MIPS R4000', 'MIPS', 1991, 'mips', 'First 64-bit MIPS, 8-stage superpipeline.', {
        clockMhz: 100, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
        l1i: cache(8192, 1), l1d: cache(8192, 1), memLatency: 8,
        predictor: 'static', predEntries: 16, mispredictPenalty: 4, staticPowerMw: 20,
    }, G.classic),
    cpu('r4400', 'MIPS R4400', 'MIPS', 1993, 'mips', 'R4000 with larger caches, Indy/Indigo2.', {
        clockMhz: 200, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
        l1i: cache(16384, 1), l1d: cache(16384, 1), memLatency: 10,
        predictor: 'static', predEntries: 16, mispredictPenalty: 4, staticPowerMw: 35,
    }, G.classic),
    cpu('r4600', 'QED R4600', 'QED / IDT', 1993, 'mips', 'Shorter-pipe R4k, embedded / Nintendo 64 cousin.', {
        clockMhz: 133, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 8,
        predictor: 'static', predEntries: 16, mispredictPenalty: 3, staticPowerMw: 18,
    }, G.classic),
    cpu('r5000', 'MIPS R5000', 'QED / MIPS', 1996, 'mips', 'Dual-issue in-order, O2 / low-end SGI.', {
        clockMhz: 200, issueWidth: 2, pipelineStages: 5, fetchWidth: 8, aluCount: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), memLatency: 12, predEntries: 32, mispredictPenalty: 4, staticPowerMw: 50,
    }, G.classic),
    cpu('r8000', 'MIPS R8000', 'MIPS', 1994, 'mips', '4-issue HPC, huge off-chip cache, short-lived.', {
        clockMhz: 90, issueWidth: 4, pipelineStages: 5, fetchWidth: 16, aluCount: 3, memPorts: 2,
        l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 20, predEntries: 64, mispredictPenalty: 5, staticPowerMw: 200,
    }, G.classic),
    cpu('r10000', 'MIPS R10000', 'MIPS', 1996, 'mips', '4-issue OoO, Origin / Octane flagship.', {
        clockMhz: 195, issueWidth: 4, pipelineStages: 5, fetchWidth: 16, aluCount: 3, memPorts: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), memLatency: 18, predEntries: 512, mispredictPenalty: 5, staticPowerMw: 280,
    }, G.classic),
    cpu('r12000', 'MIPS R12000', 'MIPS / SGI', 1998, 'mips', 'R10k shrink, deeper window.', {
        clockMhz: 300, issueWidth: 4, pipelineStages: 6, fetchWidth: 16, aluCount: 3, memPorts: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), predEntries: 1024, mispredictPenalty: 6, staticPowerMw: 320,
    }, G.classic),
    cpu('r14000', 'MIPS R14000', 'SGI', 2001, 'mips', 'Last big-endian SGI MIPS, 0.13 µm.', {
        clockMhz: 500, issueWidth: 4, pipelineStages: 6, fetchWidth: 16, aluCount: 3, memPorts: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), predEntries: 2048, mispredictPenalty: 6, staticPowerMw: 400,
    }, G.classic),
    cpu('r16000', 'MIPS R16000', 'SGI', 2002, 'mips', 'Final Origin 3000 CPU, 700+ MHz bins.', {
        clockMhz: 700, issueWidth: 4, pipelineStages: 6, fetchWidth: 16, aluCount: 3, memPorts: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), predEntries: 2048, mispredictPenalty: 6, staticPowerMw: 450,
    }, G.classic),
    cpu('mips-4kc', 'MIPS 32 4Kc', 'MIPS', 1999, 'mips', 'Classic 32-bit 5-stage embedded core.', {
        clockMhz: 200, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 12, predictor: 'static', predEntries: 32, mispredictPenalty: 2, staticPowerMw: 20,
    }, G.synth),
    cpu('mips-4kec', 'MIPS 32 4KEc', 'MIPS', 2002, 'mips', '4Kc + EJTAG / more cache options.', {
        clockMhz: 266, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 12, predictor: 'static', predEntries: 32, mispredictPenalty: 2, staticPowerMw: 22,
    }, G.synth),
    cpu('mips-5kc', 'MIPS 64 5Kc', 'MIPS', 2000, 'mips', '64-bit synthesizable 5-stage.', {
        clockMhz: 300, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 14, predEntries: 64, staticPowerMw: 40,
    }, G.synth),
    cpu('mips-24k', 'MIPS 24K', 'MIPS', 2003, 'mips', '8-stage synthesizable, widespread in routers/SoCs.', {
        clockMhz: 600, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
        l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 20, predEntries: 128, mispredictPenalty: 7, staticPowerMw: 80,
    }, G.synth),
    cpu('mips-24ke', 'MIPS 24KE', 'MIPS', 2005, 'mips', '24K + DSP ASE.', {
        clockMhz: 650, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
        l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 20, predEntries: 128, mispredictPenalty: 7, staticPowerMw: 90,
    }, G.synth),
    cpu('mips-34k', 'MIPS 34K', 'MIPS', 2006, 'mips', 'MT ASE, 9-stage, dual-thread 24K-class.', {
        clockMhz: 700, issueWidth: 1, pipelineStages: 9, fetchWidth: 8,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 128, mispredictPenalty: 8, staticPowerMw: 110,
    }, G.synth),
    cpu('mips-74k', 'MIPS 74K', 'MIPS', 2007, 'mips', '15-stage, dual-issue DSP-oriented 32-bit core.', {
        clockMhz: 1000, issueWidth: 2, pipelineStages: 15, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 256, mispredictPenalty: 11, staticPowerMw: 220,
    }, G.synth),
    cpu('mips-1004k', 'MIPS 1004K', 'MIPS', 2008, 'mips', 'Coherent multicore 34K-class.', {
        clockMhz: 800, issueWidth: 1, pipelineStages: 9, fetchWidth: 8,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 128, mispredictPenalty: 8, staticPowerMw: 130,
    }, G.synth),
    cpu('mips-1074k', 'MIPS 1074K', 'MIPS', 2010, 'mips', 'Coherent 74K multicore.', {
        clockMhz: 1100, issueWidth: 2, pipelineStages: 15, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 256, mispredictPenalty: 11, staticPowerMw: 260,
    }, G.synth),
    cpu('interaptiv', 'MIPS interAptiv', 'Imagination', 2013, 'mips', '9-stage MT mid-range Warrior.', {
        clockMhz: 1200, issueWidth: 1, pipelineStages: 9, fetchWidth: 16,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 256, mispredictPenalty: 8, staticPowerMw: 200,
    }, G.synth),
    cpu('proaptiv', 'MIPS proAptiv', 'Imagination', 2012, 'mips', '16-stage dual-issue high-end Warrior-P.', {
        clockMhz: 1400, issueWidth: 2, pipelineStages: 16, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, mispredictPenalty: 12, staticPowerMw: 320,
    }, G.synth),
    cpu('mips-p5600', 'MIPS P5600', 'Imagination', 2013, 'mips', 'Release 5, dual-issue, 128-bit SIMD class.', {
        clockMhz: 1500, issueWidth: 2, pipelineStages: 9, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 350,
    }, G.synth),
    cpu('mips-i6400', 'MIPS I6400', 'Imagination', 2015, 'mips', '64-bit Warrior-I, hardware multithreading.', {
        clockMhz: 1600, issueWidth: 2, pipelineStages: 9, fetchWidth: 16, aluCount: 2,
        l1i: cache(65536, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 400,
    }, G.synth),
    cpu('mips-i6500', 'MIPS I6500', 'MIPS', 2017, 'mips', 'Multi-threaded 64-bit, networking dataplane.', {
        clockMhz: 1800, issueWidth: 2, pipelineStages: 10, fetchWidth: 16, aluCount: 2,
        l1i: cache(65536, 4), l1d: cache(32768, 4), predEntries: 1024, staticPowerMw: 500,
    }, G.synth),
    cpu('alchemy-au1550', 'Alchemy Au1550', 'AMD / Raza', 2004, 'mips', 'Low-power Au1xxx, early netbooks / SoCs.', {
        clockMhz: 500, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 14, predEntries: 64, staticPowerMw: 45,
    }, G.soc),
    cpu('octeon', 'Cavium Octeon', 'Cavium', 2006, 'mips', 'cnMIPS, many-core packet processors.', {
        clockMhz: 600, issueWidth: 1, pipelineStages: 7, fetchWidth: 8,
        l1i: cache(32768, 4), l1d: cache(8192, 4), memLatency: 18, predEntries: 64, staticPowerMw: 80,
        ...chipDefaults(16, 16),
    }, G.soc),
    cpu('octeon-ii', 'Cavium Octeon II', 'Cavium', 2010, 'mips', 'cnMIPS II, 32-core networking.', {
        clockMhz: 1100, issueWidth: 1, pipelineStages: 7, fetchWidth: 16,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 128, staticPowerMw: 140,
        ...chipDefaults(32, 32),
    }, G.soc),
    cpu('octeon-iii', 'Cavium Octeon III', 'Cavium', 2013, 'mips', 'cnMIPS III, 48-core class.', {
        clockMhz: 1800, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 256, staticPowerMw: 220,
        ...chipDefaults(48, 48),
    }, G.soc),
    cpu('bmips', 'Broadcom BMIPS', 'Broadcom', 2004, 'mips', 'Cable/DSL SoC cores (338x / 63xx).', {
        clockMhz: 600, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
        l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 16, predEntries: 64, staticPowerMw: 70,
    }, G.soc),
    cpu('xburst', 'Ingenic XBurst', 'Ingenic', 2006, 'mips', 'Clock-gated MIPS32 for handhelds (JZxxxx).', {
        clockMhz: 800, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 16, predEntries: 64, staticPowerMw: 60,
    }, G.soc),
    cpu('xburst2', 'Ingenic XBurst2', 'Ingenic', 2013, 'mips', 'Dual-issue XBurst (JZ4780 / M200).', {
        clockMhz: 1200, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 256, staticPowerMw: 140,
    }, G.soc),
    cpu('r4300i', 'NEC VR4300 / R4300i', 'NEC / MIPS', 1995, 'mips', 'Nintendo 64 CPU, 93.75 MHz, 5-stage.', {
        clockMhz: 94, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(16384, 1), l1d: cache(8192, 1), memLatency: 8,
        predictor: 'static', predEntries: 16, mispredictPenalty: 2, staticPowerMw: 12,
    }, G.game),
    cpu('r5900', 'Emotion Engine R5900', 'Toshiba / Sony', 2000, 'mips', 'PS2 EE: dual-issue + 128-bit MMI.', {
        clockMhz: 295, issueWidth: 2, pipelineStages: 6, fetchWidth: 16, aluCount: 2,
        l1i: cache(16384, 2), l1d: cache(8192, 2), memLatency: 10, predEntries: 64, mispredictPenalty: 5, staticPowerMw: 80,
    }, G.game),
    cpu('lexra-lx5280', 'Lexra LX5280', 'Lexra', 1999, 'mips', 'MIPS-like embedded (no unaligned, patent era).', {
        clockMhz: 133, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(8192, 2), l1d: cache(8192, 2), memLatency: 8,
        predictor: 'static', predEntries: 16, mispredictPenalty: 3, staticPowerMw: 15,
    }, G.game),
    cpu('godson-2e', 'Godson-2E', 'ICT CAS', 2006, 'mips', 'Early Loongson MIPS64 OoO.', {
        clockMhz: 800, issueWidth: 4, pipelineStages: 9, fetchWidth: 16, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 1024, mispredictPenalty: 9, staticPowerMw: 350,
    }, G.game),
    cpu('loongson-2f', 'Loongson 2F', 'Loongson', 2008, 'mips', 'MIPS64 desktop (Lemote / netbooks).', {
        clockMhz: 800, issueWidth: 4, pipelineStages: 9, fetchWidth: 16, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 1024, mispredictPenalty: 9, staticPowerMw: 400,
    }, G.game),
    cpu('loongson-3a1000', 'Loongson 3A1000', 'Loongson', 2009, 'mips', 'Quad MIPS64, GS464.', {
        clockMhz: 1000, issueWidth: 4, pipelineStages: 9, fetchWidth: 16, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 2048, mispredictPenalty: 9, staticPowerMw: 700,
        ...chipDefaults(4, 4),
    }, G.game),
    cpu('loongson-3a2000', 'Loongson 3A2000', 'Loongson', 2015, 'mips', 'GS464E, last widely-known MIPS Loongson.', {
        clockMhz: 1000, issueWidth: 4, pipelineStages: 12, fetchWidth: 24, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 900,
        ...chipDefaults(4, 4),
    }, G.game),
    cpu('loongson-3a4000', 'Loongson 3A4000', 'Loongson', 2019, 'mips', 'GS464V, 1.8–2.0 GHz MIPS64 (pre-LoongArch).', {
        clockMhz: 1800, issueWidth: 4, pipelineStages: 12, fetchWidth: 24, aluCount: 4, memPorts: 2,
        l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 12, staticPowerMw: 1400,
        ...chipDefaults(4, 4),
    }, G.game),
];
//# sourceMappingURL=cpus_mips.js.map