from pathlib import Path
p = Path("/mnt/c/ISA_SIM/scripts/wsl-linux-pack.sh")
p.write_bytes(p.read_bytes().replace(b"\r\n", b"\n").replace(b"\r", b"\n"))
