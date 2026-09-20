import { type HardwareProfile, type IsaId, type IsaTiming } from './types.ts';
export declare function chipDefaults(cores: number, threads: number): Pick<HardwareProfile, 'cores' | 'threads' | 'l2' | 'l3' | 'l2Latency' | 'l3Latency' | 'memChannels' | 'dramIssueInterval' | 'coherenceLatency'>;
export declare function normalizeHw(hw: HardwareProfile): HardwareProfile;
/** Validates a complete replay/profile snapshot before it can drive the model. */
export declare function validateHardwareProfile(hw: HardwareProfile): HardwareProfile;
export declare const HARDWARE_PROFILES: HardwareProfile[];
export declare const DEFAULT_PROFILE_ID = "equal-inorder";
export declare function profileById(id: string): HardwareProfile;
export declare function isaTiming(isa: IsaId): IsaTiming;
export declare function overlayCustom(base: HardwareProfile, patch: Partial<HardwareProfile>): HardwareProfile;
//# sourceMappingURL=hardware.d.ts.map