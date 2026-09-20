import { cache, cpu, type CpuModel } from './cpus_build.ts'
import { chipDefaults } from './hardware.ts'

const G = {
  little: 'Arm · Cortex-A little / mid',
  big: 'Arm · Cortex-A / X',
  neo: 'Arm · Neoverse',
  apple: 'Apple silicon',
  other: 'Arm · other silicon',
} as const

export const ARM_CPUS: CpuModel[] = [
  cpu('cortex-a5', 'Arm Cortex-A5', 'Arm', 2009, 'arm', 'Tiny in-order ARMv7, feature-cut A8/A9.', {
    clockMhz: 800, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
    l1i: cache(16384, 2), l1d: cache(16384, 4), memLatency: 24, predEntries: 64, staticPowerMw: 40,
  }, G.little),
  cpu('cortex-a7', 'Arm Cortex-A7', 'Arm', 2011, 'arm', 'In-order dual-issue, big.LITTLE little.', {
    clockMhz: 1200, issueWidth: 2, pipelineStages: 8, fetchWidth: 8, aluCount: 2,
    l1i: cache(32768, 2), l1d: cache(32768, 4), memLatency: 28, predEntries: 128, mispredictPenalty: 8, staticPowerMw: 70,
  }, G.little),
  cpu('cortex-a8', 'Arm Cortex-A8', 'Arm', 2005, 'arm', '13-stage dual-issue, first Cortex-A (Beagle/iMX).', {
    clockMhz: 1000, issueWidth: 2, pipelineStages: 13, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 30, predEntries: 512, mispredictPenalty: 13, staticPowerMw: 200,
  }, G.little),
  cpu('cortex-a9', 'Arm Cortex-A9', 'Arm', 2007, 'arm', 'OoO dual-issue, the Cortex that ran Android.', {
    clockMhz: 1400, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, mispredictPenalty: 8, staticPowerMw: 280,
  }, G.little),
  cpu('cortex-a15', 'Arm Cortex-A15', 'Arm', 2010, 'arm', 'OoO 3-wide, 15+ stage, Chromebook / Exynos 5.', {
    clockMhz: 1700, issueWidth: 3, pipelineStages: 15, fetchWidth: 16, aluCount: 2, memPorts: 1,
    l1i: cache(32768, 2), l1d: cache(32768, 2), predEntries: 2048, mispredictPenalty: 15, staticPowerMw: 600,
  }, G.little),
  cpu('cortex-a17', 'Arm Cortex-A17', 'Arm', 2014, 'arm', 'A12 successor, mid-range OoO.', {
    clockMhz: 1800, issueWidth: 2, pipelineStages: 10, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 1024, mispredictPenalty: 10, staticPowerMw: 400,
  }, G.little),
  cpu('cortex-a32', 'Arm Cortex-A32', 'Arm', 2016, 'arm', 'Smallest ARMv8-A, AArch32 only.', {
    clockMhz: 1000, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
    l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 24, predEntries: 64, staticPowerMw: 50,
  }, G.little),
  cpu('cortex-a35', 'Arm Cortex-A35', 'Arm', 2015, 'arm', 'Little in-order AArch64, 8-stage, low power.', {
    clockMhz: 1000, issueWidth: 1, pipelineStages: 8, fetchWidth: 8,
    l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 30, predEntries: 128, staticPowerMw: 90,
  }, G.little),
  cpu('cortex-a53', 'Arm Cortex-A53', 'Arm', 2012, 'arm', 'In-order dual-issue, the workhorse little core.', {
    clockMhz: 1500, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 2), l1d: cache(32768, 4), memLatency: 40, predEntries: 256, mispredictPenalty: 8, staticPowerMw: 180,
  }, G.little),
  cpu('cortex-a55', 'Arm Cortex-A55', 'Arm', 2017, 'arm', 'Updated in-order little, better predictor and prefetch.', {
    clockMhz: 1800, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, mispredictPenalty: 8, staticPowerMw: 200,
  }, G.little),
  cpu('cortex-a57', 'Arm Cortex-A57', 'Arm', 2012, 'arm', 'First 64-bit big core, 3-wide OoO (Tegra X1).', {
    clockMhz: 1900, issueWidth: 3, pipelineStages: 15, fetchWidth: 24, aluCount: 2, memPorts: 1,
    l1i: cache(49152, 3), l1d: cache(32768, 2), predEntries: 2048, mispredictPenalty: 15, staticPowerMw: 650,
  }, G.little),
  cpu('cortex-a510', 'Arm Cortex-A510', 'Arm', 2021, 'arm', 'In-order little, Armv9, merged-core pairs.', {
    clockMhz: 2000, issueWidth: 3, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 1024, mispredictPenalty: 8, staticPowerMw: 220,
  }, G.little),
  cpu('cortex-a520', 'Arm Cortex-A520', 'Arm', 2023, 'arm', 'Armv9.2 little, refined A510.', {
    clockMhz: 2200, issueWidth: 3, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 1024, mispredictPenalty: 8, staticPowerMw: 240,
  }, G.little),

  cpu('cortex-a72', 'Arm Cortex-A72', 'Arm', 2015, 'arm', '3-wide OoO (modeled 2–3 issue), phone/SoC big core.', {
    clockMhz: 2000, issueWidth: 3, pipelineStages: 15, fetchWidth: 24, aluCount: 2, memPorts: 1,
    l1i: cache(49152, 3), l1d: cache(32768, 2), predEntries: 2048, mispredictPenalty: 13, staticPowerMw: 700,
  }, G.big),
  cpu('cortex-a73', 'Arm Cortex-A73', 'Arm', 2016, 'arm', '2-wide OoO, shorter pipe than A72, efficiency play.', {
    clockMhz: 2300, issueWidth: 2, pipelineStages: 11, fetchWidth: 16, aluCount: 2,
    l1i: cache(65536, 4), l1d: cache(32768, 4), predEntries: 2048, mispredictPenalty: 11, staticPowerMw: 650,
  }, G.big),
  cpu('cortex-a75', 'Arm Cortex-A75', 'Arm', 2017, 'arm', '3-wide OoO DynamIQ, first A75/A55 pairs.', {
    clockMhz: 2500, issueWidth: 3, pipelineStages: 13, fetchWidth: 24, aluCount: 2, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 900,
  }, G.big),
  cpu('cortex-a76', 'Arm Cortex-A76', 'Arm', 2018, 'arm', '4-wide OoO, 13-stage, modern Android big core.', {
    clockMhz: 2400, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1100,
  }, G.big),
  cpu('cortex-a77', 'Arm Cortex-A77', 'Arm', 2019, 'arm', 'A76 + 50% wider frontend / Mop cache.', {
    clockMhz: 2600, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1300,
  }, G.big),
  cpu('cortex-a78', 'Arm Cortex-A78', 'Arm', 2020, 'arm', 'Refined A76-class, higher clocks and better L1.', {
    clockMhz: 2800, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 70, predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1300,
  }, G.big),
  cpu('cortex-a78c', 'Arm Cortex-A78C', 'Arm', 2021, 'arm', 'A78 with larger L3, Chromebook / compute.', {
    clockMhz: 2800, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1400,
  }, G.big),
  cpu('cortex-x1', 'Arm Cortex-X1', 'Arm', 2020, 'arm', 'First X-class, wider than A78, 5-wide rename.', {
    clockMhz: 2900, issueWidth: 5, pipelineStages: 13, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 8192, mispredictPenalty: 15, staticPowerMw: 1800,
  }, G.big),
  cpu('cortex-x2', 'Arm Cortex-X2', 'Arm', 2021, 'arm', 'Prime/X class, aggressive fetch and issue.', {
    clockMhz: 3000, issueWidth: 5, pipelineStages: 15, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2000,
  }, G.big),
  cpu('cortex-a710', 'Arm Cortex-A710', 'Arm', 2021, 'arm', 'Armv9 mid, A78 successor.', {
    clockMhz: 2600, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1200,
  }, G.big),
  cpu('cortex-a715', 'Arm Cortex-A715', 'Arm', 2022, 'arm', 'AArch64-only mid, A710 refinement.', {
    clockMhz: 2700, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1250,
  }, G.big),
  cpu('cortex-x3', 'Arm Cortex-X3', 'Arm', 2022, 'arm', '6-wide X, 2022 Android flagships.', {
    clockMhz: 3200, issueWidth: 6, pipelineStages: 15, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2200,
  }, G.big),
  cpu('cortex-a720', 'Arm Cortex-A720', 'Arm', 2023, 'arm', 'Armv9.2 mid, 2023–24 Android.', {
    clockMhz: 2800, issueWidth: 5, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1300,
  }, G.big),
  cpu('cortex-x4', 'Arm Cortex-X4', 'Arm', 2023, 'arm', '10-wide decode / 6-wide rename X-class.', {
    clockMhz: 3300, issueWidth: 6, pipelineStages: 15, fetchWidth: 32, aluCount: 5, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2400,
  }, G.big),
  cpu('cortex-a725', 'Arm Cortex-A725', 'Arm', 2024, 'arm', 'Armv9.2 mid, C1-class efficiency.', {
    clockMhz: 2900, issueWidth: 5, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1350,
  }, G.big),
  cpu('cortex-x925', 'Arm Cortex-X925', 'Arm', 2024, 'arm', 'Blackhawk X, 10-wide decode flagship.', {
    clockMhz: 3600, issueWidth: 8, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 3,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 8192, mispredictPenalty: 17, staticPowerMw: 2800,
  }, G.big),

  cpu('neoverse-e1', 'Arm Neoverse E1', 'Arm', 2019, 'arm', 'Throughput / SMT little for edge networking.', {
    clockMhz: 2200, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 300,
  }, G.neo),
  cpu('neoverse-n1', 'Arm Neoverse N1', 'Arm', 2019, 'arm', 'Server A76 derivative (Graviton2 / Altra class).', {
    clockMhz: 2500, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 90, predEntries: 4096, staticPowerMw: 1400,
  }, G.neo),
  cpu('neoverse-n2', 'Arm Neoverse N2', 'Arm', 2020, 'arm', 'Armv9 N-class (Siena / Cobalt 100).', {
    clockMhz: 2800, issueWidth: 5, pipelineStages: 13, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 95, predEntries: 4096, mispredictPenalty: 14, staticPowerMw: 1700,
  }, G.neo),
  cpu('neoverse-n3', 'Arm Neoverse N3', 'Arm', 2024, 'arm', 'N-class efficiency, 2024 server.', {
    clockMhz: 3000, issueWidth: 5, pipelineStages: 13, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 95, predEntries: 8192, mispredictPenalty: 14, staticPowerMw: 1800,
  }, G.neo),
  cpu('neoverse-v1', 'Arm Neoverse V1', 'Arm', 2020, 'arm', 'Zeus wide server (Graviton3).', {
    clockMhz: 2600, issueWidth: 5, pipelineStages: 15, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 100, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2200,
  }, G.neo),
  cpu('neoverse-v2', 'Arm Neoverse V2', 'Arm', 2022, 'arm', 'Wide server core (Grace / Graviton4 class).', {
    clockMhz: 3200, issueWidth: 5, pipelineStages: 15, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 100, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2400,
  }, G.neo),
  cpu('neoverse-v3', 'Arm Neoverse V3', 'Arm', 2024, 'arm', 'Latest V-class, Armv9.2 server.', {
    clockMhz: 3400, issueWidth: 6, pipelineStages: 15, fetchWidth: 32, aluCount: 5, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 100, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2600,
  }, G.neo),

  cpu('apple-swift', 'Apple Swift', 'Apple', 2012, 'arm', 'A6: first Apple-designed ARMv7s.', {
    clockMhz: 1200, issueWidth: 3, pipelineStages: 12, fetchWidth: 16, aluCount: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 1024, mispredictPenalty: 12, staticPowerMw: 400,
  }, G.apple),
  cpu('apple-cyclone', 'Apple Cyclone', 'Apple', 2013, 'arm', 'A7: first 64-bit phone CPU.', {
    clockMhz: 1300, issueWidth: 6, pipelineStages: 16, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 2048, mispredictPenalty: 16, staticPowerMw: 700,
  }, G.apple),
  cpu('apple-typhoon', 'Apple Typhoon', 'Apple', 2014, 'arm', 'A8: Cyclone shrink, better clocks.', {
    clockMhz: 1400, issueWidth: 6, pipelineStages: 16, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 2048, mispredictPenalty: 16, staticPowerMw: 750,
  }, G.apple),
  cpu('apple-twister', 'Apple Twister', 'Apple', 2015, 'arm', 'A9: wider / faster Cyclone family.', {
    clockMhz: 1850, issueWidth: 6, pipelineStages: 16, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 900,
  }, G.apple),
  cpu('apple-hurricane', 'Apple Hurricane', 'Apple', 2016, 'arm', 'A10 Fusion P-core.', {
    clockMhz: 2340, issueWidth: 6, pipelineStages: 16, fetchWidth: 32, aluCount: 5, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 1100,
  }, G.apple),
  cpu('apple-monsoon', 'Apple Monsoon', 'Apple', 2017, 'arm', 'A11 P-core, first Apple big.LITTLE.', {
    clockMhz: 2390, issueWidth: 7, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 17, staticPowerMw: 1300,
  }, G.apple),
  cpu('apple-vortex', 'Apple Vortex', 'Apple', 2018, 'arm', 'A12 P-core.', {
    clockMhz: 2490, issueWidth: 7, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 3,
    l1i: cache(131072, 4), l1d: cache(65536, 4), predEntries: 8192, mispredictPenalty: 17, staticPowerMw: 1500,
  }, G.apple),
  cpu('apple-lightning', 'Apple Lightning', 'Apple', 2019, 'arm', 'A13 P-core.', {
    clockMhz: 2650, issueWidth: 7, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 3,
    l1i: cache(131072, 4), l1d: cache(131072, 4), predEntries: 8192, mispredictPenalty: 17, staticPowerMw: 1700,
  }, G.apple),
  cpu('apple-firestorm', 'Apple Firestorm', 'Apple', 2020, 'arm', 'A14 / M1 P-core: very wide decode and issue.', {
    clockMhz: 3200, issueWidth: 8, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 3,
    l1i: cache(196608, 6), l1d: cache(131072, 8), memLatency: 60, predEntries: 8192, mispredictPenalty: 18, staticPowerMw: 2800,
    ...chipDefaults(8, 8),
  }, G.apple),
  cpu('apple-avalanche', 'Apple Avalanche', 'Apple', 2022, 'arm', 'A16 / M2 P-core.', {
    clockMhz: 3500, issueWidth: 8, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 3,
    l1i: cache(196608, 6), l1d: cache(131072, 8), memLatency: 58, predEntries: 8192, mispredictPenalty: 18, staticPowerMw: 3000,
    ...chipDefaults(8, 8),
  }, G.apple),
  cpu('apple-everest', 'Apple Everest', 'Apple', 2023, 'arm', 'A17 / M3 P-core.', {
    clockMhz: 4100, issueWidth: 8, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 3,
    l1i: cache(196608, 6), l1d: cache(131072, 8), memLatency: 55, predEntries: 8192, mispredictPenalty: 18, staticPowerMw: 3200,
    ...chipDefaults(8, 8),
  }, G.apple),
  cpu('apple-m4p', 'Apple M4 P-core', 'Apple', 2024, 'arm', 'M4 / A18-class P-core, 4nm.', {
    clockMhz: 4400, issueWidth: 8, pipelineStages: 16, fetchWidth: 32, aluCount: 6, memPorts: 3,
    l1i: cache(196608, 6), l1d: cache(131072, 8), memLatency: 52, predEntries: 8192, mispredictPenalty: 18, staticPowerMw: 3300,
    ...chipDefaults(10, 10),
  }, G.apple),

  cpu('krait', 'Qualcomm Krait', 'Qualcomm', 2012, 'arm', 'S4 / Snapdragon 600–800 custom ARMv7.', {
    clockMhz: 1900, issueWidth: 3, pipelineStages: 11, fetchWidth: 16, aluCount: 2,
    l1i: cache(16384, 4), l1d: cache(16384, 4), predEntries: 1024, mispredictPenalty: 11, staticPowerMw: 500,
  }, G.other),
  cpu('kryo', 'Qualcomm Kryo', 'Qualcomm', 2016, 'arm', 'Custom 64-bit (821 / 835-era Kryo).', {
    clockMhz: 2450, issueWidth: 4, pipelineStages: 14, fetchWidth: 24, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 2048, mispredictPenalty: 14, staticPowerMw: 900,
  }, G.other),
  cpu('oryon', 'Qualcomm Oryon', 'Qualcomm', 2023, 'arm', 'Snapdragon X Elite / 8 Elite Nuvia core.', {
    clockMhz: 3400, issueWidth: 6, pipelineStages: 14, fetchWidth: 32, aluCount: 5, memPorts: 2,
    l1i: cache(196608, 6), l1d: cache(98304, 6), memLatency: 70, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2600,
    ...chipDefaults(12, 12),
  }, G.other),
  cpu('denver', 'NVIDIA Denver', 'NVIDIA', 2014, 'arm', 'Tegra K1-64, dual-issue + optimizer.', {
    clockMhz: 2300, issueWidth: 2, pipelineStages: 15, fetchWidth: 16, aluCount: 2,
    l1i: cache(131072, 4), l1d: cache(65536, 4), predEntries: 2048, mispredictPenalty: 18, staticPowerMw: 800,
  }, G.other),
  cpu('carmel', 'NVIDIA Carmel', 'NVIDIA', 2018, 'arm', 'Xavier 8-wide decode Carmel.', {
    clockMhz: 2260, issueWidth: 4, pipelineStages: 14, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(131072, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 15, staticPowerMw: 1200,
    ...chipDefaults(8, 8),
  }, G.other),
  cpu('a64fx', 'Fujitsu A64FX', 'Fujitsu', 2019, 'arm', 'Fugaku HPC, SVE-512, HBM2.', {
    clockMhz: 2200, issueWidth: 4, pipelineStages: 18, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 40, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 2800,
    ...chipDefaults(48, 48),
  }, G.other),
  cpu('thunderx2', 'Marvell ThunderX2', 'Marvell / Cavium', 2018, 'arm', 'Vulcan-derived 4-wide server.', {
    clockMhz: 2500, issueWidth: 4, pipelineStages: 16, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 8), l1d: cache(32768, 8), memLatency: 100, predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 2000,
    ...chipDefaults(32, 32),
  }, G.other),
  cpu('xgene3', 'AppliedMicro X-Gene 3', 'Ampere / APM', 2017, 'arm', 'Custom 64-bit server, pre-Altra.', {
    clockMhz: 3000, issueWidth: 4, pipelineStages: 16, fetchWidth: 24, aluCount: 3, memPorts: 2,
    l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 95, predEntries: 2048, mispredictPenalty: 16, staticPowerMw: 1800,
  }, G.other),
  cpu('altra', 'Ampere Altra', 'Ampere', 2020, 'arm', '80× Neoverse N1, 3.0 GHz cloud.', {
    clockMhz: 3000, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 90, predEntries: 4096, staticPowerMw: 1400,
    ...chipDefaults(80, 80),
  }, G.other),
  cpu('ampereone', 'AmpereOne', 'Ampere', 2023, 'arm', 'Custom cloud core, 192× class.', {
    clockMhz: 3000, issueWidth: 4, pipelineStages: 12, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 95, predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1100,
    ...chipDefaults(192, 192),
  }, G.other),
  cpu('graviton2', 'AWS Graviton2', 'Amazon', 2019, 'arm', '64× Neoverse N1, the Arm cloud breakout.', {
    clockMhz: 2500, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 90, predEntries: 4096, staticPowerMw: 1400,
    ...chipDefaults(64, 64),
  }, G.other),
  cpu('graviton3', 'AWS Graviton3', 'Amazon', 2021, 'arm', '64× Neoverse V1 + DDR5 / 2× SIMD.', {
    clockMhz: 2600, issueWidth: 5, pipelineStages: 15, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 95, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2200,
    ...chipDefaults(64, 64),
  }, G.other),
  cpu('graviton4', 'AWS Graviton4', 'Amazon', 2023, 'arm', '96× Neoverse V2.', {
    clockMhz: 2800, issueWidth: 5, pipelineStages: 15, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 100, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2400,
    ...chipDefaults(96, 96),
  }, G.other),
  cpu('kunpeng-920', 'Huawei Kunpeng 920', 'Huawei', 2019, 'arm', 'TaiShan v110, 64-core server.', {
    clockMhz: 2600, issueWidth: 4, pipelineStages: 12, fetchWidth: 32, aluCount: 3, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), memLatency: 90, predEntries: 2048, mispredictPenalty: 13, staticPowerMw: 1600,
    ...chipDefaults(64, 64),
  }, G.other),
  cpu('mongoose-m3', 'Samsung Mongoose M3', 'Samsung', 2017, 'arm', 'Exynos 9810 custom big core.', {
    clockMhz: 2700, issueWidth: 6, pipelineStages: 13, fetchWidth: 32, aluCount: 4, memPorts: 2,
    l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 1800,
  }, G.other),
]
