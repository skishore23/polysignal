"""Synthetic offline transport/selection checks; no source admission or network."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "scripts/research/maker_metadata_phase_a.py"
spec = importlib.util.spec_from_file_location("metadata", SOURCE)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
NOW = 1_800_000_060_000


def row(**changes):
    x = {"id": "1", "slug": "btc-updown-5m-1800000000", "conditionId": "0x" + "1" * 64,
         "active": True, "closed": False, "archived": False, "acceptingOrders": True, "negRisk": False,
         "eventStartTime": "2027-01-15T08:00:00Z", "endDate": "2027-01-15T08:05:00Z",
         "question": "Synthetic Bitcoin Up or Down", "description": "Synthetic rules, not observed.",
         "clobTokenIds": '["123", "456"]', "outcomes": '["Down", "Up"]'}
    x.update(changes)
    return x


class Response:
    def __init__(self, raw, status=200, headers=None):
        self.raw, self.status = raw, status
        self.headers = {"Content-Type": "application/json", **(headers or {})}
    def getheader(self, k, default=None):
        return self.headers.get(k, default)
    def read1(self, n):
        data, self.raw = self.raw[:n], self.raw[n:]
        return data


class Connection:
    sock = None
    def __init__(self, response):
        self.response, self.requests, self.closed = response, [], False
    def request(self, *a, **kw):
        self.requests.append((a, kw))
    def getresponse(self):
        return self.response
    def close(self):
        self.closed = True


class Selection(unittest.TestCase):
    def select(self, rows, now=NOW):
        return m.select(json.dumps(rows).encode(), now)
    def test_preserves_original_outcome_order_rules_and_identity(self):
        result = self.select([row()])
        self.assertEqual(result["selected"]["outcomes"], [{"label": "Down", "token_id": "123"}, {"label": "Up", "token_id": "456"}])
        self.assertFalse(result["selected"]["semantic_admission"])
        self.assertFalse(result["quote_phase_admitted"])
        self.assertIsNone(result["fee_bound"])
    def test_lexical_identity_tie_break_not_volume(self):
        second = row(id="2", conditionId="0x" + "2" * 64, slug="btc-updown-5m-1800000000", clobTokenIds=["777", "888"])
        # Same slug is ambiguous, including when one row has greater volume.
        with self.assertRaisesRegex(ValueError, "duplicate_slug"):
            self.select([row(volume=0), second])
    def test_missing_or_false_flags_not_inferred(self):
        for k in ("active", "closed", "archived", "acceptingOrders", "negRisk"):
            for v in (None, "false", 0, 1):
                with self.subTest(k=k, v=v):
                    self.assertIsNone(self.select([row(**{k: v})])["selected"])
    def test_tokens_and_labels_never_guessed(self):
        for change in ({"clobTokenIds": ["123", "123"]}, {"outcomes": ["A", "B"]},
                       {"clobTokenIds": [True, "456"]}, {"outcomes": ["Yes"]}, {"description": ""}):
            self.assertIsNone(self.select([row(**change)])["selected"])
    def test_current_lifetime_exact_boundary(self):
        self.assertIsNotNone(self.select([row()], NOW + 180_000)["selected"])
        for now in (NOW - 60_001, NOW + 180_001):
            self.assertIsNone(self.select([row()], now)["selected"])
    def test_start_end_slug_must_agree(self):
        for change in ({"endDate": "2027-01-15T08:06:00Z"}, {"eventStartTime": None},
                       {"slug": "btc-updown-5m-1800000001"}, {"eventStartTime": "2027-01-15T08:00:00"}):
            self.assertIsNone(self.select([row(**change)])["selected"])
    def test_duplicate_eligible_identity_fails(self):
        with self.assertRaisesRegex(ValueError, "ambiguous_duplicate"):
            self.select([row(), row()])
    def test_top_level_and_page_bound(self):
        for raw in (b"{}", b"null", b"[" + b"{}," * 100 + b"{}]"):
            with self.assertRaises(ValueError):
                m.select(raw, NOW)


class Transport(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        (self.root / "reports/evidence").mkdir(parents=True)
        protocol = self.root / "protocol.json"
        protocol.write_bytes(m.PROTOCOL.read_bytes())
        now = int(time.time() * 1000)
        self.admission = {"schema": "ADR_POLY003_PHASE_A_INDEPENDENT_ADMISSION_V1",
                          "execution_admitted": True, "protocol_sha256": m.digest(protocol.read_bytes()),
                          "source_sha256": m.digest(SOURCE.read_bytes()), "scope": "ONE_METADATA_READ_ONLY",
                          "not_before_utc_ms": now - 1000, "expires_utc_ms": now + 10_000,
                          "run_name": "maker-phase-a-SYNTHETIC-TEST"}
        self.path = self.root / "synthetic-admission.json"
        self.path.write_text(json.dumps(self.admission))
        self.out = self.root / "reports/evidence" / self.admission["run_name"]
        self.addCleanup(patch.stopall)
        patch.object(m, "REPO", self.root).start()
        patch.object(m, "PROTOCOL", protocol).start()
        self.conn = Connection(Response(b"[]"))
        self.factory = patch.object(m.http.client, "HTTPSConnection", return_value=self.conn).start()
    def saved(self):
        return json.loads((self.out / "receipt.json").read_text())
    def test_single_direct_request_retains_bytes_and_remaining_original_budget(self):
        result = m.run(self.path)
        self.assertEqual(result["status"], "NO_ELIGIBLE_MARKET")
        self.assertEqual(len(self.conn.requests), 1)
        self.assertEqual(self.conn.requests[0][0], ("GET", m.TARGET))
        self.assertEqual((self.out / "raw-body.bin").read_bytes(), b"[]")
        self.assertEqual(self.saved()["remaining_shared_reads"], 2)
        self.assertEqual(self.saved()["remaining_shared_body_bytes"], 8388606)
        self.assertTrue(self.conn.closed)
        with self.assertRaises(FileExistsError):
            m.run(self.path)
        self.assertEqual(len(self.conn.requests), 1)
    def test_admission_source_hash_and_window_before_network(self):
        for change in ({"execution_admitted": False}, {"source_sha256": "0" * 64},
                       {"expires_utc_ms": 0}, {"run_name": "../../escape"}):
            d = copy.deepcopy(self.admission); d.update(change)
            self.path.write_text(json.dumps(d))
            with self.assertRaises(ValueError):
                m.run(self.path)
            self.factory.assert_not_called()
    def test_no_redirect_or_retry_and_failure_retained(self):
        self.conn.response = Response(b"denied", status=302, headers={"Location": "https://other.example"})
        with self.assertRaisesRegex(ValueError, "http_status"):
            m.run(self.path)
        self.assertEqual(len(self.conn.requests), 1)
        self.assertEqual(self.saved()["status"], "FAILED_NO_RETRY")
        self.assertEqual((self.out / "raw-body.bin").read_bytes(), b"denied")
    def test_body_cap_no_extra_byte_read(self):
        self.conn.response = Response(b"x" * (m.BODY_LIMIT + 100))
        with self.assertRaisesRegex(ValueError, "body_limit"):
            m.run(self.path)
        self.assertEqual((self.out / "raw-body.bin").stat().st_size, m.BODY_LIMIT)
        self.assertEqual(self.saved()["body_bytes"], m.BODY_LIMIT)
        self.assertEqual(len(self.conn.requests), 1)
    def test_compression_or_non_json_rejected(self):
        self.conn.response = Response(b"[]", headers={"Content-Encoding": "gzip"})
        with self.assertRaisesRegex(ValueError, "content_encoding"):
            m.run(self.path)
        self.assertFalse((self.out / "selection.json").exists())
    def test_timeout_retained_no_retry(self):
        self.conn.getresponse = lambda: (_ for _ in ()).throw(TimeoutError("synthetic_timeout"))
        with self.assertRaises(TimeoutError):
            m.run(self.path)
        self.assertEqual(self.saved()["status"], "FAILED_NO_RETRY")
        self.assertEqual(len(self.conn.requests), 1)
    def test_expiry_during_local_evidence_setup_prevents_network(self):
        # Disk work consumes the same fixed window; it must not renew the clock.
        wall = self.admission["not_before_utc_ms"] + 1000
        clocks = {"wall": wall / 1000, "mono": 100.0}
        original_write = Path.write_text
        def slow_receipt(path, *args, **kwargs):
            result = original_write(path, *args, **kwargs)
            if path.name == "receipt.json":
                clocks["wall"] += 11
                clocks["mono"] += 11
            return result
        with patch.object(m.time, "time", side_effect=lambda: clocks["wall"]), \
             patch.object(m.time, "monotonic", side_effect=lambda: clocks["mono"]), \
             patch.object(Path, "write_text", slow_receipt):
            with self.assertRaisesRegex(ValueError, "request_deadline"):
                m.run(self.path)
        self.factory.assert_not_called()
        self.assertEqual(self.conn.requests, [])
        self.assertEqual(self.saved()["status"], "FAILED_NO_RETRY")
    def test_clock_jump_during_local_setup_prevents_network(self):
        clocks = {"wall": (self.admission["not_before_utc_ms"] + 1000) / 1000,
                  "mono": 100.0}
        original_write = Path.write_text
        def jumping_clock(path, *args, **kwargs):
            result = original_write(path, *args, **kwargs)
            if path.name == "receipt.json":
                clocks["wall"] += 0.5
            return result
        with patch.object(m.time, "time", side_effect=lambda: clocks["wall"]), \
             patch.object(m.time, "monotonic", side_effect=lambda: clocks["mono"]), \
             patch.object(Path, "write_text", jumping_clock):
            with self.assertRaisesRegex(ValueError, "clock_disagreement"):
                m.run(self.path)
        self.factory.assert_not_called()
        self.assertEqual(self.saved()["status"], "FAILED_NO_RETRY")
    def test_connection_constructor_failure_retains_terminal_receipt(self):
        self.factory.side_effect = OSError("synthetic_constructor_failure")
        with self.assertRaisesRegex(OSError, "synthetic_constructor_failure"):
            m.run(self.path)
        self.assertEqual(self.saved()["status"], "FAILED_NO_RETRY")
        self.assertEqual(self.saved()["failure"], "synthetic_constructor_failure")
        self.assertEqual(self.saved()["http_requests_started"], 0)
        with self.assertRaises(FileExistsError):
            m.run(self.path)
        self.assertEqual(self.factory.call_count, 1)
    def test_absolute_deadline_interrupts_slow_headers(self):
        now = int(time.time() * 1000)
        self.admission.update(not_before_utc_ms=now, expires_utc_ms=now + 100)
        self.path.write_text(json.dumps(self.admission))
        def stalled_headers():
            time.sleep(1)
            return self.conn.response
        self.conn.getresponse = stalled_headers
        with self.assertRaisesRegex(TimeoutError, "absolute_request_deadline"):
            m.run(self.path)
        self.assertLess(self.saved()["elapsed_seconds"], 0.75)
        self.assertEqual(self.saved()["status"], "FAILED_NO_RETRY")


if __name__ == "__main__":
    unittest.main()
