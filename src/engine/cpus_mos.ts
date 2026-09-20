import { cache, cpu, type CpuModel } from './cpus_build.ts'

const G = {
  nmos: '6502 · NMOS / Commodore',
  cmos: '6502 · CMOS / WDC',
  game: '6502 · consoles / clones',
} as const

const tiny = {
  issueWidth: 1 as const,
  pipelineStages: 1,
  fetchWidth: 1,
  predictor: 'none' as const,
  predEntries: 1,
  mispredictPenalty: 0,
  mulLatency: 20,
  divLatency: 40,
  forwarding: false,
  complexDecodeBytes: 4,
}

export const MOS_CPUS: CpuModel[] = [
  cpu('mos-6501', 'MOS 6501', 'MOS Technology', 1975, 'mos', '6502 pin-compatible with 6800; withdrawn after lawsuit.', {
    clockMhz: 1, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.5,
  }, G.nmos),
  cpu('mos-6502', 'MOS 6502', 'MOS Technology', 1975, 'mos', 'NMOS 8-bit, Apple II / PET / early Atari.', {
    clockMhz: 1, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.5,
  }, G.nmos),
  cpu('mos-6502a', 'MOS 6502A', 'MOS Technology', 1977, 'mos', '2 MHz rated 6502 (Apple II+ / some PET).', {
    clockMhz: 2, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.6,
  }, G.nmos),
  cpu('mos-6502b', 'MOS 6502B', 'MOS Technology', 1979, 'mos', '3 MHz bin, later Apple IIe option.', {
    clockMhz: 3, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.7,
  }, G.nmos),
  cpu('mos-6507', 'MOS 6507', 'MOS Technology', 1976, 'mos', 'Atari 2600: 13-address-pin 6502, 1.19 MHz.', {
    clockMhz: 1, ...tiny,
    l1i: cache(128, 1, 8), l1d: cache(128, 1, 8), memLatency: 1, staticPowerMw: 0.4,
  }, G.nmos),
  cpu('mos-6510', 'MOS 6510', 'MOS Technology', 1982, 'mos', 'C64 CPU: 6502 plus on-chip I/O port, ~1 MHz.', {
    clockMhz: 1, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.6,
  }, G.nmos),
  cpu('csg-8502', 'CSG 8502', 'Commodore', 1985, 'mos', 'C128 CPU: 6510-like, 1 or 2 MHz.', {
    clockMhz: 2, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.7,
  }, G.nmos),
  cpu('sally', 'Atari SALLY (6502C)', 'Atari / MOS', 1979, 'mos', 'Atari 8-bit: 6502C with HALT for ANTIC DMA.', {
    clockMhz: 2, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.5,
  }, G.nmos),
  cpu('r6502', 'Rockwell R6502', 'Rockwell', 1976, 'mos', 'Second-source NMOS 6502.', {
    clockMhz: 2, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.5,
  }, G.nmos),
  cpu('sy6502', 'Synertek SY6502', 'Synertek', 1976, 'mos', 'Second-source used in Apple II and Atari.', {
    clockMhz: 1, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.5,
  }, G.nmos),

  cpu('wdc-65c02', 'WDC 65C02', 'WDC', 1982, 'mos', 'CMOS 6502 with extra instructions, Apple IIc / IIe enhanced.', {
    clockMhz: 4, ...tiny, mulLatency: 16, divLatency: 32,
    l1i: cache(512, 1, 8), l1d: cache(512, 1, 8), memLatency: 1, staticPowerMw: 0.3,
  }, G.cmos),
  cpu('g65sc02', 'GTE G65SC02', 'GTE / CMD', 1984, 'mos', 'Static CMOS 65C02, popular in upgrades.', {
    clockMhz: 4, ...tiny, mulLatency: 16, divLatency: 32,
    l1i: cache(512, 1, 8), l1d: cache(512, 1, 8), memLatency: 1, staticPowerMw: 0.3,
  }, G.cmos),
  cpu('65ce02', 'CSG 65CE02', 'Commodore', 1988, 'mos', 'C65 / unreleased: 65C02 plus extra regs, 3.5 MHz class.', {
    clockMhz: 4, ...tiny, mulLatency: 14, divLatency: 28,
    l1i: cache(512, 1, 8), l1d: cache(512, 1, 8), memLatency: 1, staticPowerMw: 0.4,
  }, G.cmos),
  cpu('wdc-65c816', 'WDC 65C816', 'WDC', 1985, 'mos', '16-bit 6502 descendant (Apple IIgs / SNES core).', {
    clockMhz: 8, issueWidth: 1, pipelineStages: 1, fetchWidth: 2,
    l1i: cache(1024, 1, 8), l1d: cache(1024, 1, 8), memLatency: 1,
    predictor: 'none', predEntries: 1, mispredictPenalty: 0,
    mulLatency: 12, divLatency: 24, forwarding: false, staticPowerMw: 0.5, complexDecodeBytes: 4,
  }, G.cmos),
  cpu('wdc-65c02s', 'WDC 65C02S', 'WDC', 2003, 'mos', 'Modern static 65C02, 14 MHz parts exist.', {
    clockMhz: 14, ...tiny, mulLatency: 16, divLatency: 32,
    l1i: cache(512, 1, 8), l1d: cache(512, 1, 8), memLatency: 1, staticPowerMw: 0.2,
  }, G.cmos),

  cpu('ricoh-2a03', 'Ricoh 2A03', 'Ricoh', 1983, 'mos', 'NES CPU: 6502 minus decimal mode, 1.79 MHz NTSC.', {
    clockMhz: 2, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.4,
  }, G.game),
  cpu('ricoh-2a07', 'Ricoh 2A07', 'Ricoh', 1986, 'mos', 'PAL NES: 1.66 MHz 2A03 variant.', {
    clockMhz: 2, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.4,
  }, G.game),
  cpu('ricoh-5a22', 'Ricoh 5A22', 'Ricoh', 1990, 'mos', 'SNES: 65C816-based, 3.58 MHz peaks.', {
    clockMhz: 4, issueWidth: 1, pipelineStages: 1, fetchWidth: 2,
    l1i: cache(1024, 1, 8), l1d: cache(1024, 1, 8), memLatency: 1,
    predictor: 'none', predEntries: 1, mispredictPenalty: 0,
    mulLatency: 12, divLatency: 24, forwarding: false, staticPowerMw: 0.6, complexDecodeBytes: 4,
  }, G.game),
  cpu('huc6280', 'Hudson HuC6280', 'Hudson Soft', 1987, 'mos', 'PC Engine: 65C02-like at 1.79/7.16 MHz.', {
    clockMhz: 7, issueWidth: 1, pipelineStages: 1, fetchWidth: 2,
    l1i: cache(512, 1, 8), l1d: cache(512, 1, 8), memLatency: 1, predictor: 'static', predEntries: 4, mispredictPenalty: 1,
    mulLatency: 16, divLatency: 32, forwarding: false, staticPowerMw: 0.8, complexDecodeBytes: 4,
  }, G.game),
  cpu('um6502', 'UMC UM6502', 'UMC', 1988, 'mos', 'Taiwanese 6502 clone, famiclone / arcade.', {
    clockMhz: 2, ...tiny,
    l1i: cache(256, 1, 8), l1d: cache(256, 1, 8), memLatency: 1, staticPowerMw: 0.4,
  }, G.game),
]
