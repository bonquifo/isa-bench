import { cache, cpu } from './cpus_build.ts';
import { chipDefaults } from './hardware.ts';
const G = {
    open: 'RISC-V · open / MCU',
    sifive: 'RISC-V · SiFive',
    andes: 'RISC-V · Andes / Alibaba',
    cn: 'RISC-V · T-Head / XiangShan',
    srv: 'RISC-V · application / server',
};
export const RISCV_CPUS = [
    cpu('picorv32', 'PicoRV32', 'Claire Wolf', 2015, 'riscv', 'Size-optimized RV32I MCU, 2–3 cyc/op.', {
        clockMhz: 250, issueWidth: 1, pipelineStages: 2, fetchWidth: 4,
        l1i: cache(2048, 1, 16), l1d: cache(2048, 1, 16), memLatency: 3,
        predictor: 'none', predEntries: 4, mispredictPenalty: 1, staticPowerMw: 2, aluCount: 1, memPorts: 1,
    }, G.open),
    cpu('vexriscv', 'VexRiscv', 'SpinalHDL', 2018, 'riscv', 'FPGA-friendly RV32IM, 2-stage option.', {
        clockMhz: 160, issueWidth: 1, pipelineStages: 2, fetchWidth: 4,
        l1i: cache(4096, 1, 16), l1d: cache(4096, 1, 16), memLatency: 4,
        predictor: 'static', predEntries: 8, mispredictPenalty: 2, staticPowerMw: 3,
    }, G.open),
    cpu('ibex', 'lowRISC Ibex', 'lowRISC', 2018, 'riscv', 'RV32 MCU, 2-stage, tiny tightly-coupled memories.', {
        clockMhz: 200, issueWidth: 1, pipelineStages: 2, fetchWidth: 4,
        l1i: cache(4096, 1, 16), l1d: cache(4096, 1, 16), memLatency: 4,
        predictor: 'none', predEntries: 8, mispredictPenalty: 2, staticPowerMw: 4, aluCount: 1, memPorts: 1,
    }, G.open),
    cpu('cv32e40p', 'OpenHW CV32E40P', 'OpenHW / ETH', 2016, 'riscv', 'RI5CY: 4-stage RV32IMCF, PULP workhorse.', {
        clockMhz: 360, issueWidth: 1, pipelineStages: 4, fetchWidth: 8,
        l1i: cache(8192, 2), l1d: cache(8192, 2), memLatency: 6,
        predictor: 'static', predEntries: 16, mispredictPenalty: 3, staticPowerMw: 10,
    }, G.open),
    cpu('cv32e40x', 'OpenHW CV32E40X', 'OpenHW', 2021, 'riscv', '4-stage RV32, extensible eXtension interface.', {
        clockMhz: 400, issueWidth: 1, pipelineStages: 4, fetchWidth: 8,
        l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 8,
        predictor: 'bimodal', predEntries: 32, mispredictPenalty: 3, staticPowerMw: 14,
    }, G.open),
    cpu('swerv-el2', 'WD SweRV EL2', 'Western Digital', 2019, 'riscv', 'Tiny 4-stage RV32IMC embedded core.', {
        clockMhz: 400, issueWidth: 1, pipelineStages: 4, fetchWidth: 8,
        l1i: cache(8192, 2), l1d: cache(4096, 2), memLatency: 6,
        predictor: 'bimodal', predEntries: 32, mispredictPenalty: 3, staticPowerMw: 8,
    }, G.open),
    cpu('swerv-eh1', 'WD SweRV EH1', 'Western Digital', 2018, 'riscv', '9-stage dual-issue RV32IMC (SweRV).', {
        clockMhz: 1000, issueWidth: 2, pipelineStages: 9, fetchWidth: 16, aluCount: 2,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 12, predEntries: 256, mispredictPenalty: 8, staticPowerMw: 80,
    }, G.open),
    cpu('swerv-eh2', 'WD SweRV EH2', 'Western Digital', 2020, 'riscv', 'Dual-thread EH1-class, storage controllers.', {
        clockMhz: 1200, issueWidth: 2, pipelineStages: 9, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 14, predEntries: 256, mispredictPenalty: 8, staticPowerMw: 110,
    }, G.open),
    cpu('rocket', 'Berkeley Rocket', 'UC Berkeley', 2014, 'riscv', '5-stage in-order RV64, the original Rocket Chip.', {
        clockMhz: 1000, issueWidth: 1, pipelineStages: 5, fetchWidth: 16,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 20, predEntries: 64, staticPowerMw: 90,
    }, G.open),
    cpu('cva6', 'OpenHW CVA6', 'OpenHW / ETH', 2017, 'riscv', '6-stage single-issue application core (Ariane).', {
        clockMhz: 1200, issueWidth: 1, pipelineStages: 6, fetchWidth: 16,
        l1i: cache(16384, 4), l1d: cache(32768, 4), memLatency: 30, predEntries: 128, staticPowerMw: 180,
    }, G.open),
    cpu('boom-small', 'Berkeley BOOM (small)', 'UC Berkeley', 2017, 'riscv', 'Open-source OoO, 2-wide SonicBOOM-class.', {
        clockMhz: 1200, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2, memPorts: 1,
        l1i: cache(16384, 4), l1d: cache(16384, 4), predEntries: 512, mispredictPenalty: 10, staticPowerMw: 400,
    }, G.open),
    cpu('boom-med', 'Berkeley BOOM (med)', 'UC Berkeley', 2019, 'riscv', 'Open-source OoO, modeled as a 3-wide machine.', {
        clockMhz: 1500, issueWidth: 3, pipelineStages: 10, fetchWidth: 24, aluCount: 2, memPorts: 2,
        l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 900,
    }, G.open),
    cpu('boom-large', 'Berkeley BOOM (large)', 'UC Berkeley', 2020, 'riscv', 'SonicBOOM 4-wide research core.', {
        clockMhz: 1600, issueWidth: 4, pipelineStages: 11, fetchWidth: 32, aluCount: 3, memPorts: 2,
        l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 4096, mispredictPenalty: 13, staticPowerMw: 1400,
    }, G.open),
    cpu('sifive-e20', 'SiFive E20', 'SiFive', 2017, 'riscv', '2-stage 32-bit microcontroller core.', {
        clockMhz: 200, issueWidth: 1, pipelineStages: 2, fetchWidth: 4,
        l1i: cache(2048, 1, 16), l1d: cache(2048, 1, 16), memLatency: 3,
        predictor: 'none', predEntries: 4, mispredictPenalty: 1, staticPowerMw: 3,
    }, G.sifive),
    cpu('sifive-e21', 'SiFive E21', 'SiFive', 2018, 'riscv', '2-stage MCU with more TCM than E20.', {
        clockMhz: 250, issueWidth: 1, pipelineStages: 2, fetchWidth: 4,
        l1i: cache(4096, 1, 16), l1d: cache(4096, 1, 16), memLatency: 4,
        predictor: 'none', predEntries: 8, mispredictPenalty: 2, staticPowerMw: 4,
    }, G.sifive),
    cpu('sifive-e24', 'SiFive E24', 'SiFive', 2018, 'riscv', '3-stage RV32IMC with FPU option.', {
        clockMhz: 300, issueWidth: 1, pipelineStages: 3, fetchWidth: 8,
        l1i: cache(8192, 2), l1d: cache(8192, 2), memLatency: 6,
        predictor: 'static', predEntries: 16, mispredictPenalty: 2, staticPowerMw: 8,
    }, G.sifive),
    cpu('sifive-e31', 'SiFive E31', 'SiFive', 2017, 'riscv', 'Embedded 32-bit core, 3-stage, no FPU-class luxury.', {
        clockMhz: 320, issueWidth: 1, pipelineStages: 3, fetchWidth: 8,
        l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 8,
        predictor: 'static', predEntries: 32, mispredictPenalty: 3, staticPowerMw: 12,
    }, G.sifive),
    cpu('sifive-e51', 'SiFive E51', 'SiFive', 2018, 'riscv', '64-bit 3-stage embedded (FE310-class sibling).', {
        clockMhz: 320, issueWidth: 1, pipelineStages: 3, fetchWidth: 8,
        l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 8,
        predictor: 'static', predEntries: 32, mispredictPenalty: 3, staticPowerMw: 14,
    }, G.sifive),
    cpu('sifive-s51', 'SiFive S51', 'SiFive', 2018, 'riscv', '64-bit 5-stage real-time / Linux-capable.', {
        clockMhz: 800, issueWidth: 1, pipelineStages: 5, fetchWidth: 16,
        l1i: cache(16384, 4), l1d: cache(16384, 4), memLatency: 20, predEntries: 64, staticPowerMw: 80,
    }, G.sifive),
    cpu('sifive-s54', 'SiFive S54', 'SiFive', 2019, 'riscv', '5-stage 64-bit with FPU, mid-range SoC.', {
        clockMhz: 1000, issueWidth: 1, pipelineStages: 5, fetchWidth: 16,
        l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 24, predEntries: 128, staticPowerMw: 140,
    }, G.sifive),
    cpu('sifive-u54', 'SiFive U54', 'SiFive', 2018, 'riscv', 'Application-class 5-stage in-order (FU540).', {
        clockMhz: 1400, issueWidth: 1, pipelineStages: 5, fetchWidth: 16,
        l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 40, predEntries: 256, staticPowerMw: 220,
    }, G.sifive),
    cpu('sifive-u74', 'SiFive U74', 'SiFive', 2020, 'riscv', 'Dual-issue in-order application core (FU740).', {
        clockMhz: 1800, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 50, predEntries: 512, mispredictPenalty: 9, staticPowerMw: 480,
    }, G.sifive),
    cpu('sifive-p270', 'SiFive P270', 'SiFive', 2021, 'riscv', 'In-order vector (RVV) application core.', {
        clockMhz: 1600, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 550,
    }, G.sifive),
    cpu('sifive-p550', 'SiFive P550', 'SiFive', 2021, 'riscv', '13-stage triple-issue OoO (Intel Horse Creek).', {
        clockMhz: 2000, issueWidth: 3, pipelineStages: 13, fetchWidth: 24, aluCount: 3, memPorts: 2,
        l1i: cache(32768, 8), l1d: cache(32768, 8), predEntries: 2048, mispredictPenalty: 13, staticPowerMw: 1100,
    }, G.sifive),
    cpu('sifive-p670', 'SiFive P670', 'SiFive', 2023, 'riscv', 'Quad-issue OoO Performance family.', {
        clockMhz: 2400, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 8), l1d: cache(65536, 8), predEntries: 4096, mispredictPenalty: 14, staticPowerMw: 1600,
    }, G.sifive),
    cpu('sifive-p870', 'SiFive P870', 'SiFive', 2024, 'riscv', '6-wide Performance core, server/client class.', {
        clockMhz: 2800, issueWidth: 6, pipelineStages: 14, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(65536, 8), l1d: cache(65536, 8), memLatency: 80, predEntries: 8192, mispredictPenalty: 15, staticPowerMw: 2200,
    }, G.sifive),
    cpu('sifive-x280', 'SiFive X280', 'SiFive', 2021, 'riscv', 'Intelligence family: U74-class + RVV 256-bit.', {
        clockMhz: 1500, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 700,
    }, G.sifive),
    cpu('andes-n25f', 'Andes N25F', 'Andes', 2017, 'riscv', '5-stage RV32IMAFD embedded.', {
        clockMhz: 800, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 12, predEntries: 64, staticPowerMw: 40,
    }, G.andes),
    cpu('andes-a25', 'Andes A25', 'Andes', 2018, 'riscv', '5-stage Linux-capable 32-bit application.', {
        clockMhz: 1000, issueWidth: 1, pipelineStages: 5, fetchWidth: 16,
        l1i: cache(32768, 4), l1d: cache(32768, 4), memLatency: 20, predEntries: 128, staticPowerMw: 90,
    }, G.andes),
    cpu('andes-ax45', 'Andes AX45', 'Andes', 2019, 'riscv', '8-stage dual-issue 64-bit application core.', {
        clockMhz: 1500, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 400,
    }, G.andes),
    cpu('andes-ax45mp', 'Andes AX45MP', 'Andes', 2020, 'riscv', 'AX45 with coherent multicore / Linux.', {
        clockMhz: 1600, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 450,
    }, G.andes),
    cpu('andes-ax65', 'Andes AX65', 'Andes', 2023, 'riscv', '13-stage OoO 64-bit, high-end Andes.', {
        clockMhz: 2200, issueWidth: 4, pipelineStages: 13, fetchWidth: 32, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 8), l1d: cache(65536, 8), predEntries: 4096, mispredictPenalty: 14, staticPowerMw: 1500,
    }, G.andes),
    cpu('nuclei-n300', 'Nuclei N300', 'Nuclei', 2019, 'riscv', 'Chinese MCU-class RV32, GD32V sibling.', {
        clockMhz: 144, issueWidth: 1, pipelineStages: 3, fetchWidth: 4,
        l1i: cache(4096, 1, 16), l1d: cache(4096, 1, 16), memLatency: 4,
        predictor: 'static', predEntries: 8, mispredictPenalty: 2, staticPowerMw: 4,
    }, G.andes),
    cpu('nuclei-nx900', 'Nuclei NX900', 'Nuclei', 2021, 'riscv', '64-bit application / Linux class.', {
        clockMhz: 1200, issueWidth: 2, pipelineStages: 7, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 256, staticPowerMw: 280,
    }, G.andes),
    cpu('bumblebee', 'T-Head Bumblebee', 'Alibaba / GigaDevice', 2019, 'riscv', 'GD32VF103 MCU core (RV32IMAC).', {
        clockMhz: 108, issueWidth: 1, pipelineStages: 2, fetchWidth: 4,
        l1i: cache(4096, 1, 16), l1d: cache(4096, 1, 16), memLatency: 3,
        predictor: 'none', predEntries: 4, mispredictPenalty: 1, staticPowerMw: 3,
    }, G.andes),
    cpu('thead-e902', 'T-Head XuanTie E902', 'Alibaba T-Head', 2020, 'riscv', '2-stage ultra-low-power RV32E.', {
        clockMhz: 200, issueWidth: 1, pipelineStages: 2, fetchWidth: 4,
        l1i: cache(2048, 1, 16), l1d: cache(2048, 1, 16), memLatency: 3,
        predictor: 'none', predEntries: 4, mispredictPenalty: 1, staticPowerMw: 2,
    }, G.cn),
    cpu('thead-e906', 'T-Head XuanTie E906', 'Alibaba T-Head', 2020, 'riscv', '5-stage RV32IMC embedded.', {
        clockMhz: 600, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 10, predEntries: 64, staticPowerMw: 25,
    }, G.cn),
    cpu('thead-c906', 'T-Head XuanTie C906', 'Alibaba T-Head', 2019, 'riscv', '5-stage RV64GC, Allwinner D1 / Nezha.', {
        clockMhz: 1000, issueWidth: 1, pipelineStages: 5, fetchWidth: 16,
        l1i: cache(32768, 2), l1d: cache(32768, 4), memLatency: 30, predEntries: 256, staticPowerMw: 180,
    }, G.cn),
    cpu('thead-c908', 'T-Head XuanTie C908', 'Alibaba T-Head', 2022, 'riscv', '12-stage dual-issue, RVV 1.0.', {
        clockMhz: 1800, issueWidth: 2, pipelineStages: 12, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 1024, mispredictPenalty: 11, staticPowerMw: 600,
    }, G.cn),
    cpu('thead-c910', 'T-Head XuanTie C910', 'Alibaba T-Head', 2020, 'riscv', '12-stage triple-issue OoO (Wujian 910).', {
        clockMhz: 2000, issueWidth: 3, pipelineStages: 12, fetchWidth: 24, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 2048, mispredictPenalty: 13, staticPowerMw: 1200,
    }, G.cn),
    cpu('thead-c920', 'T-Head XuanTie C920', 'Alibaba T-Head', 2021, 'riscv', 'C910 + RVV, Sophon SG2042 cluster.', {
        clockMhz: 2000, issueWidth: 3, pipelineStages: 12, fetchWidth: 24, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 4), l1d: cache(65536, 4), predEntries: 2048, mispredictPenalty: 13, staticPowerMw: 1300,
        ...chipDefaults(64, 64),
    }, G.cn),
    cpu('xiangshan-nanhu', 'XiangShan Nanhu', 'ICT CAS', 2022, 'riscv', 'Open 6-wide OoO research/server core.', {
        clockMhz: 2000, issueWidth: 6, pipelineStages: 12, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(65536, 8), l1d: cache(65536, 8), predEntries: 4096, mispredictPenalty: 14, staticPowerMw: 2000,
    }, G.cn),
    cpu('xiangshan-kunminghu', 'XiangShan Kunminghu', 'ICT CAS', 2024, 'riscv', '2nd-gen XiangShan, wider / deeper.', {
        clockMhz: 2400, issueWidth: 6, pipelineStages: 14, fetchWidth: 32, aluCount: 5, memPorts: 2,
        l1i: cache(65536, 8), l1d: cache(65536, 8), memLatency: 85, predEntries: 8192, mispredictPenalty: 15, staticPowerMw: 2600,
    }, G.cn),
    cpu('spacemit-x60', 'SpacemiT X60', 'SpacemiT', 2024, 'riscv', 'K1/M1 octa application core (Banana Pi class).', {
        clockMhz: 1600, issueWidth: 2, pipelineStages: 8, fetchWidth: 16, aluCount: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 512, staticPowerMw: 350,
        ...chipDefaults(8, 8),
    }, G.cn),
    cpu('kendryte-k210', 'Kendryte K210', 'Canaan', 2018, 'riscv', 'Dual RV64 + KPU, AI hobby SoC.', {
        clockMhz: 400, issueWidth: 1, pipelineStages: 5, fetchWidth: 8,
        l1i: cache(16384, 2), l1d: cache(16384, 2), memLatency: 10, predEntries: 32, staticPowerMw: 40,
        ...chipDefaults(2, 2),
    }, G.cn),
    cpu('veyron', 'Ventana Veyron V1', 'Ventana', 2023, 'riscv', 'Server-class wide RISC-V, high fetch/issue.', {
        clockMhz: 2800, issueWidth: 4, pipelineStages: 14, fetchWidth: 32, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 8), l1d: cache(65536, 8), memLatency: 90, predEntries: 4096, mispredictPenalty: 15, staticPowerMw: 2200,
    }, G.srv),
    cpu('veyron-v2', 'Ventana Veyron V2', 'Ventana', 2024, 'riscv', '2nd-gen Veyron, wider server core.', {
        clockMhz: 3200, issueWidth: 5, pipelineStages: 15, fetchWidth: 32, aluCount: 4, memPorts: 2,
        l1i: cache(65536, 8), l1d: cache(65536, 8), memLatency: 95, predEntries: 8192, mispredictPenalty: 16, staticPowerMw: 2800,
    }, G.srv),
    cpu('ascalon', 'Tenstorrent Ascalon', 'Tenstorrent', 2024, 'riscv', 'High-performance RISC-V (Jim Keller era).', {
        clockMhz: 2500, issueWidth: 8, pipelineStages: 12, fetchWidth: 32, aluCount: 6, memPorts: 3,
        l1i: cache(65536, 8), l1d: cache(65536, 8), memLatency: 85, predEntries: 8192, mispredictPenalty: 14, staticPowerMw: 3000,
    }, G.srv),
    cpu('et-minion', 'Esperanto ET-Minion', 'Esperanto', 2021, 'riscv', 'Energy-efficient RV64 array (ET-SoC-1).', {
        clockMhz: 1000, issueWidth: 1, pipelineStages: 4, fetchWidth: 8,
        l1i: cache(16384, 2), l1d: cache(8192, 2), memLatency: 12, predEntries: 64, staticPowerMw: 30,
    }, G.srv),
    cpu('atrevido', 'Semidynamics Atrevido', 'Semidynamics', 2022, 'riscv', 'Configurable OoO + Gazzillion misses.', {
        clockMhz: 1800, issueWidth: 3, pipelineStages: 10, fetchWidth: 24, aluCount: 2, memPorts: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 900,
    }, G.srv),
    cpu('codasip-l31', 'Codasip L31', 'Codasip', 2019, 'riscv', '3-stage low-power embedded.', {
        clockMhz: 300, issueWidth: 1, pipelineStages: 3, fetchWidth: 8,
        l1i: cache(8192, 2), l1d: cache(8192, 2), memLatency: 6,
        predictor: 'static', predEntries: 16, mispredictPenalty: 2, staticPowerMw: 8,
    }, G.srv),
    cpu('codasip-a730', 'Codasip A730', 'Codasip', 2023, 'riscv', 'Application-class 64-bit, mid OoO.', {
        clockMhz: 1800, issueWidth: 3, pipelineStages: 10, fetchWidth: 24, aluCount: 2, memPorts: 2,
        l1i: cache(32768, 4), l1d: cache(32768, 4), predEntries: 2048, mispredictPenalty: 12, staticPowerMw: 800,
    }, G.srv),
    cpu('mips-p8700', 'MIPS eVocore P8700', 'MIPS', 2023, 'riscv', 'Deeply OoO RISC-V (MIPS Inc. reboot).', {
        clockMhz: 2200, issueWidth: 4, pipelineStages: 16, fetchWidth: 32, aluCount: 3, memPorts: 2,
        l1i: cache(65536, 8), l1d: cache(65536, 8), predEntries: 4096, mispredictPenalty: 16, staticPowerMw: 1800,
    }, G.srv),
];
//# sourceMappingURL=cpus_riscv.js.map