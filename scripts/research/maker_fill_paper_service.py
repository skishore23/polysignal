"""Single-owner counterfactual paper account; reuses existing closed public capture."""
import argparse
import fcntl
import json
import os
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--admission', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    admission_path = args.admission.resolve()
    admission = json.loads(admission_path.read_text())
    if admission['schema'] != 'CONSERVING_PAPER_FOLLOWER_ADMISSION_V1':
        raise ValueError('Wrong paper account scope')
    output = Path(admission['outputDirectory'])
    allowed = root / 'reports/evidence'
    if not output.is_relative_to(allowed) or any(p.is_symlink() for p in (output, *output.parents)):
        raise ValueError('Paper account output scope')
    allowed.mkdir(parents=True, exist_ok=True)
    lock = allowed / 'maker-fill-paper-account.lock'
    if lock.is_symlink():
        raise ValueError('Symlink paper account lock')
    fd = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.set_inheritable(fd, True)
    os.environ['PAPER_FILL_LOCK_FD'] = str(fd)
    os.environ['PAPER_FILL_LOCK_PATH'] = str(lock)
    node = Path.home() / '.nvm/versions/node/v20.14.0/bin/node'
    os.chdir(root)
    os.execv(node, [str(node), '--import', 'tsx', 'scripts/research/maker_fill_paper.ts', '--follow', '--admission', str(admission_path)])


if __name__ == '__main__':
    main()
