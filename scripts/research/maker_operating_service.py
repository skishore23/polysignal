"""Kernel single-owner launcher; exec replaces this process, retaining its flock."""
import argparse
import fcntl
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--admission", type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    admission_path = args.admission.resolve()
    admission = json.loads(admission_path.read_text())
    name = admission["runName"]
    if not name.startswith("maker-operating-") or "/" in name or ".." in name:
        raise ValueError("Invalid isolated run name")
    folder = root / "reports/evidence" / name
    for component in (folder, *folder.parents):
        if component.is_symlink():
            raise ValueError("Symlink service path")
        if component == root:
            break
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = root / "reports/evidence/maker-operating-account.lock"
    if lock.is_symlink():
        raise ValueError("Symlink lock")
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BaseException:
        os.close(fd)
        raise
    os.set_inheritable(fd, True)
    os.environ["PAPER_MAKER_LOCK_FD"] = str(fd)
    os.environ["PAPER_MAKER_LOCK_PATH"] = str(lock)
    node = Path.home() / ".nvm/versions/node/v20.14.0/bin/node"
    os.chdir(root)
    os.execv(node, [str(node), "--import", "tsx", "scripts/research/maker_operating.ts", "--admission", str(admission_path)])


if __name__ == "__main__":
    main()
