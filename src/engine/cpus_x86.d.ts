import type { HardwareProfile } from './types.ts';
export type X86Uarch = 'conroe' | 'penryn' | 'nehalem' | 'westmere' | 'sandy' | 'ivy' | 'haswell' | 'broadwell' | 'skylake' | 'rocket' | 'icelake' | 'golden' | 'raptor' | 'lion' | 'crestmont' | 'k8' | 'k10' | 'bulldozer' | 'piledriver' | 'zen1' | 'zenplus' | 'zen2' | 'zen3' | 'zen4' | 'zen4c' | 'zen5' | 'zen5c';
/** Single-thread µarch templates. Clock comes from the SKU. */
export declare const X86_UARCH: Record<X86Uarch, Partial<HardwareProfile> & Pick<HardwareProfile, 'issueWidth'>>;
export interface X86ModelSpec {
    id: string;
    name: string;
    vendor: 'Intel' | 'AMD';
    year: number;
    group: string;
    uarch: X86Uarch;
    /** Single-core boost, MHz. */
    clockMhz: number;
    blurb: string;
}
export declare const X86_MODELS: X86ModelSpec[];
//# sourceMappingURL=cpus_x86.d.ts.map