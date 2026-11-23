"""Real kernel lock and argv checks; exec is intercepted before Node/source startup."""
import fcntl
import json
import os
from pathlib import Path
import runpy
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch


class ExecIntercept(Exception):
    pass


class OperatingLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve() / "repo"
        self.script = self.root / "scripts/research/maker_operating_service.py"
        self.script.parent.mkdir(parents=True)
        shutil.copyfile(Path(__file__).resolve().parents[2] / "scripts/research/maker_operating_service.py", self.script)
        self.admission = Path(self.temp.name).resolve() / "admission.json"
        self.admission.write_text(json.dumps({"runName": "maker-operating-test"}))
        self.initial = Path.cwd()
        self.fds = []
        self.calls = []
        self.environment = patch.dict(os.environ, {}, clear=False)
        self.environment.start()

    def tearDown(self):
        os.chdir(self.initial)
        for fd in self.fds:
            try:
                os.close(fd)
            except OSError:
                pass
        self.environment.stop()
        self.temp.cleanup()

    def invoke(self, admission):
        def fake_exec(node, argv):
            fd = int(os.environ["PAPER_MAKER_LOCK_FD"])
            self.fds.append(fd)
            self.calls.append((node, argv, Path.cwd(), os.environ["PAPER_MAKER_LOCK_PATH"], os.get_inheritable(fd)))
            raise ExecIntercept()
        with patch.object(sys, "argv", [str(self.script), "--admission", str(admission)]), patch("os.execv", fake_exec):
            runpy.run_path(str(self.script), run_name="__main__")

    def test_relative_admission_resolved_before_chdir_and_lock_inherited(self):
        os.chdir(self.admission.parent)
        with self.assertRaises(ExecIntercept):
            self.invoke(Path("admission.json"))
        _, argv, cwd, lock, inheritable = self.calls[0]
        self.assertEqual(argv[-1], str(self.admission))
        self.assertEqual(cwd, self.root)
        self.assertEqual(lock, str(self.root / "reports/evidence/maker-operating-account.lock"))
        self.assertTrue(inheritable)

    def test_global_kernel_lock_rejects_second_run_name(self):
        with self.assertRaises(ExecIntercept):
            self.invoke(self.admission)
        self.admission.write_text(json.dumps({"runName": "maker-operating-other"}))
        with self.assertRaises(BlockingIOError):
            self.invoke(self.admission)
        self.assertEqual(len(self.calls), 1)
        os.close(self.fds.pop())
        with self.assertRaises(ExecIntercept):
            self.invoke(self.admission)

    def test_path_escape_rejected_before_exec(self):
        self.admission.write_text(json.dumps({"runName": "maker-operating-../../escape"}))
        with self.assertRaises(ValueError):
            self.invoke(self.admission)
        self.assertEqual(self.calls, [])

    def test_lock_symlink_rejected(self):
        evidence = self.root / "reports/evidence"
        evidence.mkdir(parents=True)
        target = Path(self.temp.name) / "foreign"
        target.write_text("unchanged")
        (evidence / "maker-operating-account.lock").symlink_to(target)
        with self.assertRaises(ValueError):
            self.invoke(self.admission)
        self.assertEqual(target.read_text(), "unchanged")
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
