import { type CpuModel } from './cpus_build.ts';
import { type IsaId } from './types.ts';
export type { CpuModel } from './cpus_build.ts';
export declare const CPU_CATALOG: CpuModel[];
export declare const DEFAULT_CPU_ID: Record<IsaId, string>;
export declare function cpuById(id: string): CpuModel;
export declare function cpusForIsa(isa: IsaId): CpuModel[];
export declare function groupCpus(cpus: CpuModel[]): {
    group: string;
    items: CpuModel[];
}[];
export declare function cpuSupportsIsa(cpu: CpuModel, isa: IsaId): boolean;
export declare function defaultCpuByIsa(): Record<IsaId, string>;
export declare function assertCpuCatalog(): void;
//# sourceMappingURL=cpus.d.ts.map