import { cache, cpu } from './cpus_build.ts';
import { chipDefaults } from './hardware.ts';
const G = {
    sun: 'Sun / Oracle · UltraSPARC',
    fuji: 'Fujitsu · SPARC64',
    ft: 'SPARC · fault-tolerant / early',
};
export const SPARC_CPUS = [
    cpu('mb86900', 'Fujitsu MB86900', 'Fujitsu', 1987, 'sparc', 'First SPARC, Sun-4/200 class.', {
        clockMhz: 16, issueWidth: 1, pipelineStages: 4, fetchWidth: 4,
        l1i: cache(4096, 1, 16), l1d: cache(4096, 1, 16), memLatency: 4,
        predictor: 'none', predEntries: 4, mispredictPenalty: 2, staticPowerMw: 6,
    }, G.ft),
    cpu('cy7c601', 'Cypress CY7C601', 'Cypress', 1989, 'sparc', 'Early discrete SPARC integer unit.', {
        clockMhz: 33, issueWidth: 1, pipelineStages: 4, fetchWidth: 4,
        l1i: cache(4096, 1, 16), l1d: cache(4096, 1, 16), memLatency: 5,
        predictor: 'none', predEntries: 4, mispredictPenalty: 2, staticPowerMw: 10,
    }, G.ft),
    cpu('supersparc', 'SuperSPARC', 'Texas Instruments / Sun', 1992, 'sparc', '3-issue V8, SPARCstation 10/20.', {
        clockMhz: 60, issueWidth: 3, pipelineStages: 4, fetchWidth: 8, aluCount: 2,
        l1i: cache(20480, 5), l1d: cache(16384, 4), memLatency: 8, predEntries: 16, mispredictPenalty: 3, staticPowerMw: 40,
    }, G.ft),
    cpu('supersparc-ii', 'SuperSPARC II', 'TI / Sun', 1994, 'sparc', 'SuperSPARC shrink, SS20 / SS1000.', {
        clockMhz: 85, issueWidth: 3, pipelineStages: 4, fetchWidth: 8, aluCount: 2,
        l1i: cache(20480, 5), l1d: cache(16384, 4), memLatency: 8, predEntries: 16, mispredictPenalty: 3, staticPowerMw: 50,
    }, G.ft),
    cpu('hypersparc', 'hyperSPARC', 'Ross / Fujitsu', 1993, 'sparc', 'Competing SuperSPARC, SS20 MBus.', {
        clockMhz: 125, issueWidth: 2, pipelineStages: 4, fetchWidth: 8, aluCount: 2,
        l1i: cache(8192, 2), l1d: cache(8192, 1), memLatency: 8, predEntries: 16, mispredictPenalty: 3, staticPowerMw: 35,
    }, G.ft),
    cpu('microsparc', 'microSPARC', 'TI / Sun', 1992, 'sparc', 'Low-cost SPARCstation LX / Classic.', {
        clockMhz: 50, issueWidth: 1, pipelineStages: 4, fetchWidth: 4,
        l1i: cache(4096, 1), l1d: cache(2048, 1), memLatency: 6,
        predictor: 'static', predEntries: 8, mispredictPenalty: 2, staticPowerMw: 12,
    }, G.ft),
    cpu('microsparc-ii', 'microSPARC II', 'Fujitsu / Sun', 1994, 'sparc', 'SPARCstation 5, 110 MHz.', {
        clockMhz: 110, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(16384, 1), l1d: cache(8192, 1), memLatency: 8,
        predictor: 'static', predEntries: 16, mispredictPenalty: 3, staticPowerMw: 20,
    }, G.ft),
    cpu('erc32', 'ERC32', 'Temic / ESA', 1995, 'sparc', 'Radiation-tolerant SPARC V7 for space.', {
        clockMhz: 25, issueWidth: 1, pipelineStages: 4, fetchWidth: 4,
        l1i: cache(4096, 1, 16), l1d: cache(4096, 1, 16), memLatency: 4,
        predictor: 'none', predEntries: 4, mispredictPenalty: 2, staticPowerMw: 3,
    }, G.ft),
    cpu('leon2', 'GAISLER LEON2', 'ESA / Gaisler', 2000, 'sparc', 'Synthesizable SPARC V8, early space FPGA.', {
        clockMhz: 80, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(4096, 2), l1d: cache(4096, 2), memLatency: 5,
        predictor: 'bimodal', predEntries: 16, mispredictPenalty: 2, staticPowerMw: 5,
    }, G.ft),
    cpu('leon3', 'GAISLER LEON3', 'Frontgrade Gaisler', 2004, 'sparc', 'Fault-tolerant SPARC V8 for space/FPGA.', {
        clockMhz: 125, issueWidth: 1, pipelineStages: 7, fetchWidth: 8,
        l1i: cache(8192, 2), l1d: cache(8192, 2), memLatency: 6, predictor: 'bimodal', predEntries: 32, mispredictPenalty: 3, staticPowerMw: 8,
    }, G.ft),
    cpu('leon4', 'GAISLER LEON4', 'Frontgrade Gaisler', 2010, 'sparc', '7-stage + optional dual-issue GR740.', {
        clockMhz: 250, issueWidth: 2, pipelineStages: 7, fetchWidth: 8, aluCount: 2,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 8, predEntries: 64, mispredictPenalty: 4, staticPowerMw: 20,
    }, G.ft),
    cpu('leon5', 'GAISLER LEON5', 'Frontgrade Gaisler', 2022, 'sparc', 'Dual-issue SPARC V8, GR765 class.', {
        clockMhz: 400, issueWidth: 2, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 10, predEntries: 128, mispredictPenalty: 4, staticPowerMw: 35,
    }, G.ft),
    cpu('usparc-i', 'UltraSPARC I', 'Sun', 1995, 'sparc', 'First 64-bit V9, 4-issue, 167 MHz.', {
        clockMhz: 167, issueWidth: 4, pipelineStages: 9, fetchWidth: 16, aluCount: 2,
        l1i: cache(16384, 2), l1d: cache(16384, 1), memLatency: 20, predEntries: 64, mispredictPenalty: 8, staticPowerMw: 180,
    }, G.sun),
    cpu('usparc-ii', 'UltraSPARC II', 'Sun', 1996, 'sparc', '4-issue V9, 9-stage, classic Sun workstation.', {
        clockMhz: 400, issueWidth: 4, pipelineStages: 9, fetchWidth: 16, aluCount: 2,
        l1i: cache(16384, 2), l1d: cache(16384, 4), memLatency: 30, predEntries: 128, mispredictPenalty: 8, staticPowerMw: 400,
    }, G.sun),
    cpu('usparc-2i', 'UltraSPARC IIi', 'Sun', 1998, 'sparc', 'Integrated II, Ultra 5/10.', {
        clockMhz: 480, issueWidth: 4, pipelineStages: 9, fetchWidth: 16, aluCount: 2,
        l1i: cache(16384, 2), l1d: cache(16384, 4), memLatency: 28, predEntries: 128, mispredictPenalty: 8, staticPowerMw: 350,
    }, G.sun),
    cpu('usparc-iii', 'UltraSPARC III', 'Sun', 2001, 'sparc', '14-stage, 4-issue, 64-bit Solaris servers.', {
        clockMhz: 1200, issueWidth: 4, pipelineStages: 14, fetchWidth: 16, aluCount: 3, memPorts: 1,
        l1i: cache(32768, 4), l1d: cache(65536, 4), memLatency: 60, predEntries: 512, mispredictPenalty: 14, staticPowerMw: 1200,
    }, G.sun),
    cpu('usparc-iiicu', 'UltraSPARC III Cu', 'Sun', 2003, 'sparc', 'Copper III, 1.2 GHz Fire 3800.', {
        clockMhz: 1200, issueWidth: 4, pipelineStages: 14, fetchWidth: 16, aluCount: 3, memPorts: 1,
        l1i: cache(32768, 4), l1d: cache(65536, 4), memLatency: 58, predEntries: 512, mispredictPenalty: 14, staticPowerMw: 1300,
    }, G.sun),
    cpu('usparc-iv', 'UltraSPARC IV', 'Sun', 2004, 'sparc', 'Dual-core III, 1.35 GHz.', {
        clockMhz: 1350, issueWidth: 4, pipelineStages: 14, fetchWidth: 16, aluCount: 3, memPorts: 1,
        l1i: cache(32768, 4), l1d: cache(65536, 4), predEntries: 512, mispredictPenalty: 14, staticPowerMw: 1600,
    }, G.sun),
    cpu('usparc-ivp', 'UltraSPARC IV+', 'Sun', 2005, 'sparc', 'IV with on-die L2, 1.8 GHz.', {
        clockMhz: 1800, issueWidth: 4, pipelineStages: 14, fetchWidth: 16, aluCount: 3, memPorts: 1,
        l1i: cache(32768, 4), l1d: cache(65536, 4), predEntries: 1024, mispredictPenalty: 14, staticPowerMw: 1800,
    }, G.sun),
    cpu('niagara-t1', 'UltraSPARC T1', 'Sun', 2005, 'sparc', 'Niagara: simple 6-stage, many threads, one FPU.', {
        clockMhz: 1200, issueWidth: 1, pipelineStages: 6, fetchWidth: 8,
        l1i: cache(16384, 4), l1d: cache(8192, 4), memLatency: 25, predictor: 'static', predEntries: 64, mispredictPenalty: 5, staticPowerMw: 300,
        ...chipDefaults(8, 32),
    }, G.sun),
    cpu('niagara-t2', 'UltraSPARC T2', 'Sun', 2007, 'sparc', 'Niagara 2: 8 threads/core, crypto, 10GbE.', {
        clockMhz: 1400, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
        l1i: cache(16384, 8), l1d: cache(8192, 4), memLatency: 28, predictor: 'static', predEntries: 64, mispredictPenalty: 6, staticPowerMw: 400,
        ...chipDefaults(8, 64),
    }, G.sun),
    cpu('sparc-t3', 'SPARC T3', 'Oracle / Sun', 2010, 'sparc', 'Rainbow Falls, 16 cores × 8 threads.', {
        clockMhz: 1650, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
        l1i: cache(16384, 8), l1d: cache(8192, 4), memLatency: 30, predEntries: 64, mispredictPenalty: 6, staticPowerMw: 500,
        ...chipDefaults(16, 128),
    }, G.sun),
    cpu('sparc-t4', 'SPARC T4', 'Oracle', 2011, 'sparc', 'S3 core: 8-wide OoO, first fast Niagara.', {
        clockMhz: 3000, issueWidth: 2, pipelineStages: 16, fetchWidth: 16, aluCount: 2,
        l1i: cache(16384, 4), l1d: cache(16384, 4), predEntries: 2048, mispredictPenalty: 16, staticPowerMw: 1400,
        ...chipDefaults(8, 64),
    }, G.sun),
    cpu('sparc-t5', 'SPARC T5', 'Oracle', 2013, 'sparc', 'T4 shrink, 16 S3 cores, 3.6 GHz.', {
        clockMhz: 3600, issueWidth: 2, pipelineStages: 16, fetchWidth: 16, aluCount: 2,
        l1i: cache(16384, 4), l1d: cache(16384, 4), predEntries: 2048, mispredictPenalty: 16, staticPowerMw: 1600,
        ...chipDefaults(16, 128),
    }, G.sun),
    cpu('sparc-m5', 'SPARC M5', 'Oracle', 2013, 'sparc', 'T5 S3 core in M-series scale-up.', {
        clockMhz: 3600, issueWidth: 2, pipelineStages: 16, fetchWidth: 16, aluCount: 2,
        l1i: cache(16384, 4), l1d: cache(16384, 4), predEntries: 2048, mispredictPenalty: 16, staticPowerMw: 1800,
        ...chipDefaults(16, 128),
    }, G.sun),
    cpu('sparc-m7', 'SPARC M7', 'Oracle', 2015, 'sparc', 'S4 core, 32 cores, DAX/SQL in silicon.', {
        clockMhz: 4130, issueWidth: 4, pipelineStages: 16, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 90, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 2800,
        ...chipDefaults(32, 256),
    }, G.sun),
    cpu('sparc-s7', 'SPARC S7', 'Oracle', 2016, 'sparc', 'S4 in 8-core scale-out.', {
        clockMhz: 4270, issueWidth: 4, pipelineStages: 16, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(16384, 4), l1d: cache(16384, 4), predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 2400,
        ...chipDefaults(8, 64),
    }, G.sun),
    cpu('sparc-m8', 'SPARC M8', 'Oracle', 2017, 'sparc', 'Last Oracle SPARC, 32× S4, 5.0 GHz.', {
        clockMhz: 5000, issueWidth: 4, pipelineStages: 16, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 88, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 3000,
        ...chipDefaults(32, 256),
    }, G.sun),
    cpu('sparc64-v', 'SPARC64 V', 'Fujitsu', 2003, 'sparc', 'Olympus-B, 4-issue, Primepower.', {
        clockMhz: 1350, issueWidth: 4, pipelineStages: 10, fetchWidth: 16, aluCount: 3, memPorts: 2,
        l1i: cache(131072, 2), l1d: cache(131072, 2), predEntries: 1024, mispredictPenalty: 10, staticPowerMw: 1800,
    }, G.fuji),
    cpu('sparc64-vi', 'SPARC64 VI', 'Fujitsu', 2007, 'sparc', 'Dual-core Olympus-C, SPARC Enterprise.', {
        clockMhz: 2400, issueWidth: 4, pipelineStages: 10, fetchWidth: 24, aluCount: 3, memPorts: 2,
        l1i: cache(131072, 2), l1d: cache(131072, 2), predEntries: 2048, mispredictPenalty: 10, staticPowerMw: 2200,
        ...chipDefaults(2, 4),
    }, G.fuji),
    cpu('sparc64-vii', 'SPARC64 VII', 'Fujitsu', 2008, 'sparc', '4-core SPARC64, 4-issue, HPC/Solaris.', {
        clockMhz: 2500, issueWidth: 4, pipelineStages: 13, fetchWidth: 24, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 2), l1d: cache(65536, 2), predEntries: 2048, mispredictPenalty: 13, staticPowerMw: 2200,
        ...chipDefaults(4, 8),
    }, G.fuji),
    cpu('sparc64-viip', 'SPARC64 VII+', 'Fujitsu', 2010, 'sparc', 'VII shrink, more L2.', {
        clockMhz: 3000, issueWidth: 4, pipelineStages: 13, fetchWidth: 24, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 2), l1d: cache(65536, 2), predEntries: 2048, mispredictPenalty: 13, staticPowerMw: 2300,
        ...chipDefaults(4, 8),
    }, G.fuji),
    cpu('sparc64-viiifx', 'SPARC64 VIIIfx', 'Fujitsu', 2010, 'sparc', 'K computer HPC, 8-core, HPC-ACE.', {
        clockMhz: 2000, issueWidth: 4, pipelineStages: 18, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), memLatency: 40, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 2400,
        ...chipDefaults(8, 8),
    }, G.fuji),
    cpu('sparc64-ixfx', 'SPARC64 IXfx', 'Fujitsu', 2012, 'sparc', 'PRIMEHPC FX10, 16-core.', {
        clockMhz: 1850, issueWidth: 4, pipelineStages: 18, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), memLatency: 40, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 2600,
        ...chipDefaults(16, 16),
    }, G.fuji),
    cpu('sparc64-x', 'SPARC64 X', 'Fujitsu', 2012, 'sparc', 'S4 HPC core, 4-issue, HPC-ACE SIMD.', {
        clockMhz: 3000, issueWidth: 4, pipelineStages: 18, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), memLatency: 90, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 2800,
        ...chipDefaults(16, 32),
    }, G.fuji),
    cpu('sparc64-xp', 'SPARC64 X+', 'Fujitsu', 2013, 'sparc', 'X shrink, 3.5 GHz M10.', {
        clockMhz: 3500, issueWidth: 4, pipelineStages: 18, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), memLatency: 88, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 2900,
        ...chipDefaults(16, 32),
    }, G.fuji),
    cpu('sparc64-xifx', 'SPARC64 XIfx', 'Fujitsu', 2014, 'sparc', 'PRIMEHPC FX100, 32+2 cores.', {
        clockMhz: 2200, issueWidth: 4, pipelineStages: 18, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(32768, 2), l1d: cache(32768, 2), memLatency: 45, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 2700,
        ...chipDefaults(32, 32),
    }, G.fuji),
    cpu('sparc64-xii', 'SPARC64 XII', 'Fujitsu', 2017, 'sparc', 'M12, 12-core, last Fujitsu SPARC64.', {
        clockMhz: 4250, issueWidth: 4, pipelineStages: 18, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 85, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 3000,
        ...chipDefaults(12, 24),
    }, G.fuji),
];
//# sourceMappingURL=cpus_sparc.js.map