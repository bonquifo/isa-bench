"""ISA-explicit gem5 25.1 O3 syscall-emulation configuration.

Statistics are scoped to the corpus ROI: they are reset when the
isa_bench_roi_begin marker first commits and dumped when isa_bench_roi_end
first commits, so process start-up and result-frame emission never count.
"""

import argparse
import sys
import m5
from m5.objects import (
    AddrRange,
    ArmO3CPU,
    Cache,
    L2XBar,
    PcCountPair,
    PcCountTracker,
    PcCountTrackerManager,
    Process,
    RiscvO3CPU,
    Root,
    SEWorkload,
    SimpleMemory,
    SrcClockDomain,
    System,
    SystemXBar,
    VoltageDomain,
    X86O3CPU,
)


class L1(Cache):
    size = "32KiB"
    assoc = 2
    tag_latency = 2
    data_latency = 2
    response_latency = 2
    mshrs = 4
    tgts_per_mshr = 20


class L2(Cache):
    size = "256KiB"
    assoc = 8
    tag_latency = 20
    data_latency = 20
    response_latency = 20
    mshrs = 16
    tgts_per_mshr = 12


parser = argparse.ArgumentParser()
parser.add_argument("--isa", choices=("x86_64", "aarch64", "riscv64"), required=True)
parser.add_argument("--binary", required=True)
parser.add_argument("--roi-begin", type=lambda value: int(value, 0), required=True)
parser.add_argument("--roi-end", type=lambda value: int(value, 0), required=True)
args = parser.parse_args()

cpu_class = {
    "x86_64": X86O3CPU,
    "aarch64": ArmO3CPU,
    "riscv64": RiscvO3CPU,
}[args.isa]

system = System()
system.clk_domain = SrcClockDomain(clock="2GHz", voltage_domain=VoltageDomain())
system.mem_mode = "timing"
system.mem_ranges = [AddrRange("512MiB")]
system.cpu = cpu_class()
system.l2bus = L2XBar()
system.membus = SystemXBar()
system.icache = L1()
system.dcache = L1()
system.l2cache = L2()
system.icache.cpu_side = system.cpu.icache_port
system.dcache.cpu_side = system.cpu.dcache_port
system.icache.mem_side = system.l2bus.cpu_side_ports
system.dcache.mem_side = system.l2bus.cpu_side_ports
system.l2cache.cpu_side = system.l2bus.mem_side_ports
system.l2cache.mem_side = system.membus.cpu_side_ports
system.memory = SimpleMemory(range=system.mem_ranges[0], latency="30ns")
system.memory.port = system.membus.mem_side_ports
system.system_port = system.membus.cpu_side_ports
system.cpu.createInterruptController()
if args.isa == "x86_64":
    system.cpu.interrupts[0].pio = system.membus.mem_side_ports
    system.cpu.interrupts[0].int_requestor = system.membus.cpu_side_ports
    system.cpu.interrupts[0].int_responder = system.membus.mem_side_ports

system.workload = SEWorkload.init_compatible(args.binary)
process = Process(executable=args.binary, cmd=[args.binary])
system.cpu.workload = process
system.cpu.createThreads()

# Each marker is a one-instruction function the adapter calls exactly once
# around isa_bench_core, so the first commit of each bounds the ROI.
roi_manager = PcCountTrackerManager()
roi_manager.targets = [PcCountPair(args.roi_begin, 1), PcCountPair(args.roi_end, 1)]
system.roi_manager = roi_manager
system.cpu.probeListener = PcCountTracker(
    targets=roi_manager.targets, core=system.cpu, ptmanager=roi_manager
)

root = Root(full_system=False, system=system)
m5.instantiate()

MARKER_CAUSE = "simpoint starting point found"


def run_to_marker(name):
    event = m5.simulate()
    cause = event.getCause()
    print(f"isa-sim {name} cause={cause} tick={m5.curTick()}")
    if cause != MARKER_CAUSE:
        # Never fall back to whole-process statistics silently. gem5's embedded
        # interpreter does not reliably flush on SystemExit, so flush first.
        print(
            f"isa-sim {name} marker did not commit before the simulation ended: {cause}",
            file=sys.stderr,
            flush=True,
        )
        sys.stdout.flush()
        sys.exit(2)


run_to_marker("roi-begin")
m5.stats.reset()
run_to_marker("roi-end")
m5.stats.dump()
event = m5.simulate()
print(f"isa-sim gem5 exit tick={m5.curTick()} cause={event.getCause()}")
