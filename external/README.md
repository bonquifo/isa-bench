# External adapters

All adapters consume content-addressed artifacts; host paths and arbitrary commands are not accepted.
Runtime containers are non-root, networkless, read-only, capability-free, and never receive the Docker socket.
Containers execute by immutable locked image ID, never by a mutable tag. The capability lock binds
the image lock and the adapter, parser, configuration, contracts, runtime, and native-corpus index.

## `microtrace-v1`

The import format for a future locked x86-64 producer/converter is the ChampSim 2026-04
`input_instr` record, exactly 64 little-endian bytes:

- `0..7`: `ip`, unsigned 64-bit instruction address.
- `8`: `is_branch`, exactly `0` or `1`.
- `9`: `branch_taken`, exactly `0` or `1`; it cannot be set for a non-branch.
- `10..11`: two destination-register IDs.
- `12..15`: four source-register IDs.
- `16..31`: two unsigned 64-bit destination-memory addresses.
- `32..63`: four unsigned 64-bit source-memory addresses.

Register IDs are the exact ChampSim 2026-04 x86 mapping (`0..67`). Unused register and memory
slots are zero. The manifest fixes the producer executable hash, trace hash, exact decimal record,
warmup and simulation counts, ROI hash, mapping/version, committed-path semantics, and
`truncated: false`. Unknown manifest fields, non-canonical or oversized decimals, malformed flags,
hash/count mismatch, truncation, and traces over 256 MiB are rejected. This format records only
committed instructions and therefore does not model wrong-path semantic execution.

ChampSim is currently **import-only/unsupported**, including x86-64. No first-party dynamic trace
producer is locked or allowlisted, so hand-fabricated records are not accepted as execution
evidence and do not create an execute capability. Authenticated uploads must pass the dedicated
trace-corpus validation endpoint before they can be retained.

## gem5 profile

The executable gem5 profile uses an ISA-specific O3 CPU, a 2 GHz clock, 32 KiB two-way instruction
and data caches, a 256 KiB eight-way L2, and `SimpleMemory` with 30 ns latency over 512 MiB.
The emitted `config.json`, adapter configuration, and immutable image ID are hashed into each result.
The profile makes no DDR3 claim.
