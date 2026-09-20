#!/usr/bin/env python3
import argparse
import json
import subprocess
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--trace", required=True)
parser.add_argument("--warmup-instructions", required=True, type=int)
parser.add_argument("--simulation-instructions", required=True, type=int)
parser.add_argument("--json", action="store_true", required=True)
args = parser.parse_args()

if args.warmup_instructions < 0 or args.simulation_instructions <= 0:
    raise SystemExit("invalid warmup/simulation count")

output_path = "/tmp/champsim-result.json"
command = [
    "/opt/champsim/bin/champsim",
    "--hide-heartbeat",
    "--warmup-instructions", str(args.warmup_instructions),
    "--simulation-instructions", str(args.simulation_instructions),
    "--json", output_path,
    args.trace,
]
completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, check=False, text=True)
if completed.returncode != 0:
    sys.stderr.write(completed.stdout)
    sys.stderr.write(completed.stderr)
    raise SystemExit(completed.returncode)

with open(output_path, "r", encoding="utf-8") as source:
    raw = json.load(source)
if not isinstance(raw, list) or not raw:
    raise SystemExit("ChampSim JSON did not contain phase statistics")

phase = next((item for item in raw if item.get("name") == "Simulation"), raw[-1])
roi = phase.get("roi", {})
cores = roi.get("cores", [])
if len(cores) != 1:
    raise SystemExit("expected exactly one ChampSim core")
core = cores[0]
instructions = int(core["instructions"])
cycles = int(core["cycles"])
if instructions <= 0 or cycles <= 0:
    raise SystemExit("ChampSim returned empty simulation statistics")

def total_numbers(value):
    if isinstance(value, bool):
        return 0
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, list):
        return sum(total_numbers(item) for item in value)
    if isinstance(value, dict):
        return sum(total_numbers(item) for item in value.values())
    return 0

def cache_misses(name):
    cache = roi.get(name)
    if not isinstance(cache, dict):
        return None
    return int(sum(total_numbers(value.get("miss", []))
                   for value in cache.values() if isinstance(value, dict)))

result = {
    "instructions": instructions,
    "cycles": cycles,
    "ipc": instructions / cycles,
    "warmupInstructions": args.warmup_instructions,
    "simulationInstructions": args.simulation_instructions,
    "branchMispredictions": int(total_numbers(core.get("mispredict", {}))),
    "raw": raw,
}
for output_name, candidates in (
    ("l1dMisses", ("cpu0_L1D", "L1D")),
    ("l2Misses", ("cpu0_L2C", "L2C")),
    ("llcMisses", ("LLC",)),
):
    for candidate in candidates:
        count = cache_misses(candidate)
        if count is not None:
            result[output_name] = count
            break
dram = roi.get("DRAM")
if isinstance(dram, list):
    result["dramAccesses"] = int(sum(
        total_numbers({key: value for key, value in channel.items()
                       if "ROW_BUFFER_" in key})
        for channel in dram if isinstance(channel, dict)
    ))

json.dump(result, sys.stdout, sort_keys=True, separators=(",", ":"))
sys.stdout.write("\n")
