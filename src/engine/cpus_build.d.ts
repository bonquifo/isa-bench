import { type HardwareProfile, type IsaId } from './types.ts';
export interface CpuModel {
    id: string;
    name: string;
    vendor: string;
    year: number;
    /** Associated pseudo-backend target for this illustrative parameter preset. */
    isa: IsaId;
    blurb: string;
    profile: HardwareProfile;
    /** Dropdown optgroup. Unset = flat list. */
    group?: string;
}
export declare const cache: (sizeBytes: number, ways: number, lineBytes?: number) => HardwareProfile["l1i"];
export declare function cpu(id: string, name: string, vendor: string, year: number, isa: IsaId, blurb: string, hw: Partial<HardwareProfile> & Pick<HardwareProfile, 'clockMhz' | 'issueWidth'>, group?: string): CpuModel;
//# sourceMappingURL=cpus_build.d.ts.map