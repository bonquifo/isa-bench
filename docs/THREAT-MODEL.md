# Threat model

ISA Bench treats compilers, guest binaries, imported archives, and browser
clients as untrusted. The trusted computing base for local lab operation is
the operator workstation, the pinned container images, the loopback job
server, and the operator's enrolled runner keys.

## Assets

- Content-addressed artifacts and job results under `.isa-bench-data/`
- Signed empirical evidence bundles and calibration datasets
- Docker image locks and capability locks
- Session tokens for the loopback API
- Runner Ed25519 enrollment keys and leases

## Trust boundaries

1. **Desktop or browser UI to loopback server.** The packaged desktop app and
   the development web UI are viewers and job submitters. They cannot invent
   capability tiers. The desktop shell starts the backend on `127.0.0.1` and
   loads that origin. Mutating routes require a short-lived session token,
   loopback Origin/CORS, and an explicit confirmation for administrative
   empirical actions. The desktop renderer has `nodeIntegration` disabled and
   talks to the backend over HTTP like the browser UI.
2. **Server to Docker.** Untrusted compilation and simulation run only through
   `DockerExecutor`: allowlisted immutable image IDs, argv without a shell, no
   network, read-only root, dropped capabilities, no-new-privileges, no Docker
   socket, and bounded PID/CPU/memory/tmpfs/output/time. Job labels allow
   force-removal of the entire process tree on cancel, timeout, or worker
   failure.
3. **Host to guest.** Native corpus and toolchain binaries execute inside those
   containers, not directly on the host. WSL is only a trusted-development
   probe. Empirical measurement, when a runner is enrolled, executes an
   already-hashed eligible binary under the helper's containment and restores
   requested controls afterward.
4. **Import to catalog.** Uploaded archives are quarantined. Path traversal,
   absolute paths, reserved Windows names, nested archives, and decompression
   bombs are rejected before any production table is written. Production
   import requires a valid signature from a currently approved, unexpired
   runner whose capability manifest still matches the job.

## Adversary capabilities

- Submit arbitrary IR, Guest C, or job JSON through the UI or CLI
- Attempt to pass host paths or extra argv to toolchain/external workers
- Upload malformed or hostile zip/tar/JSONL evidence
- Replay an old lease, nonce, or revoked runner key
- Change a lane tab or reload the UI while a job is running
- Craft a result envelope that mixes metric domains

## Controls

- Requests accept only content-addressed artifact IDs; host paths are rejected
- Capability locks bind image IDs and executable semantic hashes; stale locks fail closed
- Worker results are schema-validated before persistence; empty or foreign envelopes fail the job
- Cancel and failure reap every container with the job/server label before the terminal state is stored
- Empirical finish is accepted only after the signed bundle hash is stored
- Calibration fitting uses server-derived domains and frozen splits; client labels cannot turn time features into energy
- UI badges `SIGNED` and `ATTESTED` appear only after strict proof fields validate
- Spreadsheet CSV export prefixes formula-injection characters

## Residual risk

A local operator can still read `.isa-bench-data/`, replace unlocked Docker
images on the host, or run the server with `--allow-remote`. Those are
operator-trusted actions and are not a remote attack surface in the default
loopback configuration. Container escape remains a residual risk of any local
Docker installation; the sandbox reduces accidental execution and resource
abuse, it does not claim a hardened multi-tenant cloud boundary.

Empirical energy and PMU adapters report `unsupported` when the sensor or
privilege is absent. That absence is evidence, not a zero joule or zero-count
measurement.
