/*
 * The shared freestanding programs, for a machine with no registers.
 *
 * Every other target's copy of this declares a dump structure the guest
 * fills with its architectural state, because that is what the reference
 * can be compared against. Here the comparison is the module's whole
 * linear memory, byte for byte, which the engine hands over directly --
 * so the dump has nothing to add and the structure exists only to give
 * the programs the `isa_dump.scratch` they write their results into.
 *
 * The register array stays, unread, so that the shared sources compile
 * unchanged. That is the point of them: what each target emits for the
 * same C is the thing being compared, and a source edited per target
 * would not be the same C.
 */
#ifndef ISA_HARNESS_H
#define ISA_HARNESS_H

#define ISA_SCRATCH_BYTES 1024

struct IsaDump {
  unsigned long long r[32];
  unsigned char scratch[ISA_SCRATCH_BYTES];
};

extern struct IsaDump isa_dump;

long kernel(void);

#endif
