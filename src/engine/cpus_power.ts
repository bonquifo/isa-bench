import { cache, cpu, type CpuModel } from './cpus_build.ts'
import { chipDefaults } from './hardware.ts'

const G = {
  ibm: 'IBM · POWER',
  ppc: 'PowerPC · desktop / G',
  embed: 'PowerPC · embedded / consoles',
} as const

export const POWER_CPUS: CpuModel[] = [
  cpu('power1', 'IBM POWER1', 'IBM', 1990, 'power', 'RISC System/6000, first POWER, 4-issue class.', {
    clockMhz: 30, issueWidth: 4, pipelineStages: 4, fetchWidth: 16, aluCount: 2,
    l1i: cache(8192, 2), l1d: cache(65536, 4), memLatency: 8, predEntries: 16, mispredictPenalty: 3, staticPowerMw: 80,
  }, G.ibm),
  cpu('power2', 'IBM POWER2', 'IBM', 1993, 'power', '8-issue-class scientific POWER.', {
    clockMhz: 71, issueWidth: 6, pipelineStages: 5, fetchWidth: 16, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 2), l1d: cache(131072, 4), memLatency: 10, predEntries: 32, mispredictPenalty: 4, staticPowerMw: 200,
  }, G.ibm),
  cpu('power3', 'IBM POWER3', 'IBM', 1998, 'power', 'RS64-era 64-bit, 2-way SMT-less server.', {
    clockMhz: 200, issueWidth: 4, pipelineStages: 7, fetchWidth: 16, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 2), l1d: cache(65536, 4), predEntries: 256, mispredictPenalty: 7, staticPowerMw: 400,
  }, G.ibm),
  cpu('power4', 'IBM POWER4', 'IBM', 2001, 'power', 'First dual-core POWER, 8-issue, 1.3 GHz.', {
    clockMhz: 1300, issueWidth: 8, pipelineStages: 16, fetchWidth: 32, aluCount: 5, memPorts: 2,
    l1i: cache(65536, 2), l1d: cache(32768, 2), memLatency: 80, predEntries: 2048, mispredictPenalty: 16, staticPowerMw: 3500,
  }, G.ibm),
  cpu('power5', 'IBM POWER5', 'IBM', 2004, 'power', 'POWER4 + SMT2, 1.9 GHz class.', {
    clockMhz: 1900, issueWidth: 8, pipelineStages: 16, fetchWidth: 32, aluCount: 5, memPorts: 2,
    l1i: cache(65536, 2), l1d: cache(32768, 4), memLatency: 85, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 4500,
  }, G.ibm),
  cpu('power6', 'IBM POWER6', 'IBM', 2007, 'power', 'High-clock in-order-ish 4.7 GHz monster.', {
    clockMhz: 4700, issueWidth: 2, pipelineStages: 21, fetchWidth: 16, aluCount: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 8), memLatency: 100, predEntries: 512, mispredictPenalty: 20, staticPowerMw: 7000,
  }, G.ibm),
  cpu('power7', 'IBM POWER7', 'IBM', 2010, 'power', '8-core SMT4, 4.1 GHz, Watson / POWER7 era.', {
    clockMhz: 4100, issueWidth: 6, pipelineStages: 16, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 8), memLatency: 105, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 6500,
  }, G.ibm),
  cpu('power7p', 'IBM POWER7+', 'IBM', 2012, 'power', 'POWER7 shrink, more L3 eDRAM.', {
    clockMhz: 4200, issueWidth: 6, pipelineStages: 16, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 8), memLatency: 100, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 6000,
  }, G.ibm),
  cpu('power8', 'IBM POWER8', 'IBM', 2013, 'power', 'SMT8 server, 8-wide class, huge caches.', {
    clockMhz: 3500, issueWidth: 8, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(65536, 8), memLatency: 110, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 8000,
    ...chipDefaults(12, 96),
  }, G.ibm),
  cpu('power9', 'IBM POWER9', 'IBM', 2017, 'power', 'Summit/Sierra node CPU, refined POWER8.', {
    clockMhz: 3800, issueWidth: 8, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 100, predEntries: 8192, mispredictPenalty: 15, staticPowerMw: 7000,
    ...chipDefaults(24, 96),
  }, G.ibm),
  cpu('power10', 'IBM POWER10', 'IBM', 2021, 'power', 'Latest POWER, matrix units and deeper caches.', {
    clockMhz: 4000, issueWidth: 8, pipelineStages: 18, fetchWidth: 32, aluCount: 6, memPorts: 3,
    l1i: cache(49152, 6), l1d: cache(32768, 8), memLatency: 95, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 6500,
    ...chipDefaults(15, 120),
  }, G.ibm),
  cpu('power11', 'IBM POWER11', 'IBM', 2025, 'power', 'Power11 scale-up, energy-aware SMT.', {
    clockMhz: 4200, issueWidth: 8, pipelineStages: 18, fetchWidth: 32, aluCount: 6, memPorts: 3,
    l1i: cache(49152, 6), l1d: cache(32768, 8), memLatency: 90, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 6200,
    ...chipDefaults(16, 128),
  }, G.ibm),
  cpu('a2', 'IBM A2 (Blue Gene/Q)', 'IBM', 2011, 'power', 'In-order 4-thread A2, 1.6 GHz HPC.', {
    clockMhz: 1600, issueWidth: 1, pipelineStages: 7, fetchWidth: 16,
    l1i: cache(16384, 4), l1d: cache(16384, 8), memLatency: 40, predEntries: 64, mispredictPenalty: 6, staticPowerMw: 200,
    ...chipDefaults(1, 4),
  }, G.ibm),

  cpu('ppc-601', 'PowerPC 601', 'IBM / Motorola', 1993, 'power', 'First PowerPC, 3-issue, Macintosh/IBM.', {
    clockMhz: 80, issueWidth: 3, pipelineStages: 4, fetchWidth: 8, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 8, predEntries: 16, mispredictPenalty: 3, staticPowerMw: 40,
  }, G.ppc),
  cpu('ppc-603', 'PowerPC 603', 'IBM / Motorola', 1994, 'power', 'Low-power 3-issue, PowerBook 5300 era.', {
    clockMhz: 80, issueWidth: 2, pipelineStages: 4, fetchWidth: 8, aluCount: 1,
    l1i: cache(8192, 2), l1d: cache(8192, 2), memLatency: 8, predEntries: 16, mispredictPenalty: 3, staticPowerMw: 15,
  }, G.ppc),
  cpu('ppc-603e', 'PowerPC 603e', 'IBM / Motorola', 1995, 'power', '603 with 16 KB caches, beige Power Macs.', {
    clockMhz: 200, issueWidth: 2, pipelineStages: 4, fetchWidth: 8, aluCount: 1,
    l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 10, predEntries: 32, mispredictPenalty: 3, staticPowerMw: 25,
  }, G.ppc),
  cpu('ppc-604', 'PowerPC 604', 'IBM / Motorola', 1994, 'power', '4-issue OoO desktop.', {
    clockMhz: 180, issueWidth: 4, pipelineStages: 6, fetchWidth: 16, aluCount: 3, memPorts: 1,
    l1i: cache(16384, 4), l1d: cache(16384, 4), predEntries: 256, mispredictPenalty: 5, staticPowerMw: 80,
  }, G.ppc),
  cpu('ppc-604e', 'PowerPC 604e', 'IBM / Motorola', 1996, 'power', '604 shrink, 32 KB caches.', {
    clockMhz: 233, issueWidth: 4, pipelineStages: 6, fetchWidth: 16, aluCount: 3, memPorts: 1,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 256, mispredictPenalty: 5, staticPowerMw: 90,
  }, G.ppc),
  cpu('ppc-620', 'PowerPC 620', 'IBM / Motorola', 1996, 'power', 'First 64-bit PowerPC, rare servers.', {
    clockMhz: 133, issueWidth: 4, pipelineStages: 5, fetchWidth: 16, aluCount: 3, memPorts: 1,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 256, mispredictPenalty: 5, staticPowerMw: 120,
  }, G.ppc),
  cpu('ppc-750', 'PowerPC 750 (G3)', 'IBM / Motorola', 1997, 'power', '3-issue in-order-ish, original iMac/G3.', {
    clockMhz: 500, issueWidth: 2, pipelineStages: 4, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 20, predEntries: 64, mispredictPenalty: 4, staticPowerMw: 150,
  }, G.ppc),
  cpu('ppc-7400', 'PowerPC 7400 (G4)', 'Motorola', 1999, 'power', 'First AltiVec G4.', {
    clockMhz: 500, issueWidth: 3, pipelineStages: 4, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 128, mispredictPenalty: 4, staticPowerMw: 200,
  }, G.ppc),
  cpu('ppc-7410', 'PowerPC 7410', 'Motorola', 2000, 'power', 'G4 with 2 MB L2, Power Mac G4 Cube.', {
    clockMhz: 500, issueWidth: 3, pipelineStages: 4, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 128, mispredictPenalty: 4, staticPowerMw: 210,
  }, G.ppc),
  cpu('ppc-7450', 'PowerPC 7450 (G4)', 'Motorola', 2001, 'power', 'AltiVec G4, 7-stage, deeper than G3.', {
    clockMhz: 800, issueWidth: 3, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 256, mispredictPenalty: 7, staticPowerMw: 280,
  }, G.ppc),
  cpu('ppc-7447a', 'PowerPC 7447A', 'Freescale', 2005, 'power', 'Last G4, 1.67 GHz PowerBook.', {
    clockMhz: 1670, issueWidth: 3, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 512, mispredictPenalty: 7, staticPowerMw: 350,
  }, G.ppc),
  cpu('ppc-7457', 'PowerPC 7457', 'Motorola', 2003, 'power', 'G4 with 256 KB L2, MDD Power Mac.', {
    clockMhz: 1300, issueWidth: 3, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 256, mispredictPenalty: 7, staticPowerMw: 320,
  }, G.ppc),
  cpu('ppc-970', 'PowerPC 970 (G5)', 'IBM', 2003, 'power', 'POWER4-derived desktop, 16-stage, dual-issue+.', {
    clockMhz: 2000, issueWidth: 4, pipelineStages: 16, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 2), l1d: cache(32768, 2), memLatency: 70, predEntries: 1024, mispredictPenalty: 16, staticPowerMw: 1800,
  }, G.ppc),
  cpu('ppc-970fx', 'PowerPC 970FX', 'IBM', 2004, 'power', '90nm G5, 2.7 GHz iMac / Power Mac.', {
    clockMhz: 2700, issueWidth: 4, pipelineStages: 16, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 2), l1d: cache(32768, 2), memLatency: 70, predEntries: 1024, mispredictPenalty: 16, staticPowerMw: 2000,
  }, G.ppc),
  cpu('ppc-970mp', 'PowerPC 970MP', 'IBM', 2005, 'power', 'Dual-core G5, last Power Mac.', {
    clockMhz: 2500, issueWidth: 4, pipelineStages: 16, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 2), l1d: cache(32768, 2), memLatency: 70, predEntries: 1024, mispredictPenalty: 16, staticPowerMw: 2200,
  }, G.ppc),
  cpu('pa6t', 'P.A. Semi PWRficient PA6T', 'P.A. Semi', 2007, 'power', '64-bit low-power, later Apple acquisition.', {
    clockMhz: 2000, issueWidth: 4, pipelineStages: 10, fetchWidth: 24, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 2), l1d: cache(65536, 2), predEntries: 2048, mispredictPenalty: 10, staticPowerMw: 500,
  }, G.ppc),

  cpu('ppc-405', 'IBM PowerPC 405', 'IBM', 1998, 'power', '5-stage SoC core, Virtex / set-top.', {
    clockMhz: 400, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
    l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 10, predictor: 'static', predEntries: 32, mispredictPenalty: 3, staticPowerMw: 30,
  }, G.embed),
  cpu('ppc-440', 'IBM PowerPC 440', 'IBM', 1999, 'power', '7-stage Book-E, Blue Gene/L CPU.', {
    clockMhz: 700, issueWidth: 2, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 16, predEntries: 64, mispredictPenalty: 5, staticPowerMw: 80,
  }, G.embed),
  cpu('ppc-460', 'AMCC PowerPC 460', 'AMCC / IBM', 2006, 'power', 'Book-E embedded, 440 successor.', {
    clockMhz: 1200, issueWidth: 2, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 128, mispredictPenalty: 6, staticPowerMw: 140,
  }, G.embed),
  cpu('e300', 'Freescale e300', 'Freescale', 2004, 'power', 'G2 / 603e-class, MPC83xx.', {
    clockMhz: 400, issueWidth: 1, pipelineStages: 4, fetchWidth: 8,
    l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 12, predEntries: 32, staticPowerMw: 40,
  }, G.embed),
  cpu('e500', 'Freescale e500', 'Freescale', 2003, 'power', 'Book-E, MPC85xx communications.', {
    clockMhz: 800, issueWidth: 2, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 128, mispredictPenalty: 6, staticPowerMw: 120,
  }, G.embed),
  cpu('e500mc', 'Freescale e500mc', 'Freescale', 2010, 'power', 'Multicore e500, QorIQ P4.', {
    clockMhz: 1500, issueWidth: 2, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 256, mispredictPenalty: 6, staticPowerMw: 200,
  }, G.embed),
  cpu('e5500', 'Freescale e5500', 'Freescale', 2010, 'power', '64-bit QorIQ P5.', {
    clockMhz: 2000, issueWidth: 2, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 512, staticPowerMw: 280,
  }, G.embed),
  cpu('e6500', 'Freescale e6500', 'Freescale / NXP', 2012, 'power', 'AltiVec QorIQ T-series.', {
    clockMhz: 1800, issueWidth: 2, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 512, staticPowerMw: 320,
  }, G.embed),
  cpu('gekko', 'IBM Gekko', 'IBM', 2001, 'power', 'GameCube: 750CXe + paired singles, 485 MHz.', {
    clockMhz: 485, issueWidth: 2, pipelineStages: 4, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 16, predEntries: 64, mispredictPenalty: 4, staticPowerMw: 80,
  }, G.embed),
  cpu('broadway', 'IBM Broadway', 'IBM', 2006, 'power', 'Wii: Gekko shrink, 729 MHz.', {
    clockMhz: 729, issueWidth: 2, pipelineStages: 4, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 16, predEntries: 64, mispredictPenalty: 4, staticPowerMw: 90,
  }, G.embed),
  cpu('espresso', 'IBM Espresso', 'IBM', 2012, 'power', 'Wii U: triple-core Broadway-class, 1.24 GHz.', {
    clockMhz: 1243, issueWidth: 2, pipelineStages: 4, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 20, predEntries: 128, mispredictPenalty: 4, staticPowerMw: 180,
    ...chipDefaults(3, 3),
  }, G.embed),
  cpu('xenon', 'Xenon PPE-class', 'IBM', 2005, 'power', 'Xbox 360 CPU: 3.2 GHz, in-order, VMX128.', {
    clockMhz: 3200, issueWidth: 2, pipelineStages: 21, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 2), l1d: cache(32768, 4), memLatency: 80, predEntries: 128, mispredictPenalty: 18, staticPowerMw: 900,
    ...chipDefaults(3, 6),
  }, G.embed),
  cpu('cell-ppe', 'Cell PPE', 'IBM / Sony / Toshiba', 2006, 'power', 'PS3 PPE: 3.2 GHz in-order POWER, 7 SPEs aside.', {
    clockMhz: 3200, issueWidth: 2, pipelineStages: 23, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 2), l1d: cache(32768, 2), memLatency: 80, predEntries: 128, mispredictPenalty: 20, staticPowerMw: 1000,
    ...chipDefaults(1, 2),
  }, G.embed),
  cpu('rad750', 'BAE RAD750', 'BAE / IBM', 2001, 'power', 'Radiation-hardened 750, spacecraft CPU.', {
    clockMhz: 200, issueWidth: 2, pipelineStages: 4, fetchWidth: 8, aluCount: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 12, predEntries: 32, mispredictPenalty: 4, staticPowerMw: 10,
  }, G.embed),
]
