export const OOO_MODEL_VERSION = 'ooo-1.2.0';
export const OOO_ENERGY_MODEL_VERSION = 'ooo-energy-1.2.0-uncalibrated';
export const DEFAULT_OOO_PROFILE = {
    id: 'ooo-default',
    name: 'Controlled 4-wide OoO',
    modelVersion: OOO_MODEL_VERSION,
    fetchWidth: 4,
    decodeWidth: 4,
    renameWidth: 4,
    dispatchWidth: 4,
    issueWidth: 4,
    retireWidth: 4,
    robEntries: 128,
    physicalRegisters: 128,
    rsEntries: { alu: 32, mul: 12, div: 8, ld: 24, st: 16, br: 16, fp: 20, mov: 16, nop: 8 },
    loadQueueEntries: 48,
    storeQueueEntries: 32,
    storeBufferEntries: 16,
    checkpoints: 16,
    recoveryCycles: 8,
    speculateConditionalBranches: true,
    fu: {
        alu: { count: 4, latency: 1, initiationInterval: 1 },
        mul: { count: 2, latency: 3, initiationInterval: 1 },
        div: { count: 1, latency: 16, initiationInterval: 8 },
        ld: { count: 2, latency: 4, initiationInterval: 1 },
        st: { count: 2, latency: 1, initiationInterval: 1 },
        br: { count: 2, latency: 1, initiationInterval: 1 },
        fp: { count: 2, latency: 4, initiationInterval: 1 },
        mov: { count: 2, latency: 1, initiationInterval: 1 },
        nop: { count: 4, latency: 1, initiationInterval: 1 },
    },
};
export const WIDTH_ONE_OOO_PROFILE = {
    ...DEFAULT_OOO_PROFILE,
    id: 'ooo-width-one',
    name: 'Width-one no-speculation compatibility',
    fetchWidth: 1,
    decodeWidth: 1,
    renameWidth: 1,
    dispatchWidth: 1,
    issueWidth: 1,
    retireWidth: 1,
    robEntries: 32,
    physicalRegisters: 96,
    speculateConditionalBranches: false,
    checkpoints: 1,
    fu: Object.fromEntries(Object.entries(DEFAULT_OOO_PROFILE.fu).map(([key, value]) => [
        key,
        { ...value, count: 1, initiationInterval: Math.max(1, value.initiationInterval) },
    ])),
};
export function validateOoOProfile(profile) {
    if (profile.modelVersion !== OOO_MODEL_VERSION) {
        throw new Error(`OoO profile modelVersion must be ${OOO_MODEL_VERSION}`);
    }
    const positive = [
        ['fetchWidth', profile.fetchWidth], ['decodeWidth', profile.decodeWidth],
        ['renameWidth', profile.renameWidth], ['dispatchWidth', profile.dispatchWidth],
        ['issueWidth', profile.issueWidth], ['retireWidth', profile.retireWidth],
        ['robEntries', profile.robEntries], ['physicalRegisters', profile.physicalRegisters],
        ['loadQueueEntries', profile.loadQueueEntries], ['storeQueueEntries', profile.storeQueueEntries],
        ['storeBufferEntries', profile.storeBufferEntries], ['checkpoints', profile.checkpoints],
    ];
    for (const [name, value] of positive) {
        if (!Number.isSafeInteger(value) || value <= 0)
            throw new Error(`OoO ${name} must be a positive integer`);
    }
    if (profile.physicalRegisters < 64)
        throw new Error('OoO physicalRegisters must be at least 64');
    if (profile.robEntries < profile.retireWidth)
        throw new Error('OoO ROB must hold at least one retire group');
    if (!Number.isSafeInteger(profile.recoveryCycles) || profile.recoveryCycles < 0) {
        throw new Error('OoO recoveryCycles must be a non-negative integer');
    }
    for (const cls of Object.keys(profile.rsEntries)) {
        if (!Number.isSafeInteger(profile.rsEntries[cls]) || profile.rsEntries[cls] <= 0) {
            throw new Error(`OoO ${cls} reservation station must be positive`);
        }
        const fu = profile.fu[cls];
        if (!fu || !Number.isSafeInteger(fu.count) || fu.count <= 0 ||
            !Number.isSafeInteger(fu.latency) || fu.latency <= 0 ||
            !Number.isSafeInteger(fu.initiationInterval) || fu.initiationInterval <= 0) {
            throw new Error(`OoO ${cls} FU profile is invalid`);
        }
    }
    return structuredClone(profile);
}
export function decodeProgram(insts) {
    return insts.map((op, pc) => ({
        pc,
        address: op.addr,
        op,
        srcRegs: [op.srcA, op.srcB, op.memBase, op.memIndex].filter((reg, index, all) => reg >= 0 && all.indexOf(reg) === index),
        dstReg: op.dst,
        resourceReads: op.resourceReads,
        resourceWrites: op.resourceWrites,
        uops: Math.max(1, op.uops),
        bytes: op.bytes,
        fuClass: op.cls,
    }));
}
//# sourceMappingURL=ooo-types.js.map