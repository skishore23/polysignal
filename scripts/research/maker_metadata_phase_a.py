"""ADR-POLY-003 preparation: one reviewed public metadata read, never quotes.

No fresh execution is authorized by this source or its synthetic tests. The
existing parent must obtain an independent exact-hash source review first.
"""
from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import http.client
import json
from pathlib import Path
import re
import signal
import time

REPO = Path(__file__).resolve().parents[2]
PROTOCOL = REPO / "configs/research/maker-metadata-phase-a.json"
HOST = "gamma-api.polymarket.com"
TARGET = "/markets?active=true&closed=false&limit=100&order=endDate&ascending=true"
URL = "https://" + HOST + TARGET
BODY_LIMIT = 2 * 1024 * 1024


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def timestamp(value: object) -> int:
    if not isinstance(value, str) or not value.endswith("Z"):
        raise ValueError("explicit_UTC_timestamp_required")
    t = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    milliseconds = t.timestamp() * 1000
    if not milliseconds.is_integer():
        raise ValueError("submillisecond_timestamp")
    return int(milliseconds)


def array(value: object) -> list:
    if isinstance(value, str):
        value = json.loads(value)
    if not isinstance(value, list):
        raise ValueError("array_required")
    return value


def select(raw: bytes, receipt_utc_ms: int) -> dict:
    """Structural discovery only. Output preserves labels; it certifies no rules."""
    rows = json.loads(raw)
    if not isinstance(rows, list) or len(rows) > 100:
        raise ValueError("single_page_schema")
    candidates, rejected = [], []
    for index, row in enumerate(rows):
        try:
            if not isinstance(row, dict):
                raise ValueError("row_object_required")
            for k, expected in {"active": True, "closed": False, "archived": False,
                                "acceptingOrders": True, "negRisk": False}.items():
                if row.get(k) is not expected:
                    raise ValueError("unsupported_or_missing_" + k)
            mid, slug, condition = row.get("id"), row.get("slug"), row.get("conditionId")
            if not isinstance(mid, str) or not re.fullmatch(r"[0-9]+", mid):
                raise ValueError("market_id")
            if not isinstance(slug, str) or not re.fullmatch(r"btc-updown-5m-[0-9]{10}", slug):
                raise ValueError("product_slug")
            if not isinstance(condition, str) or not re.fullmatch(r"0x[0-9a-fA-F]{64}", condition):
                raise ValueError("condition_id")
            start, end = timestamp(row.get("eventStartTime")), timestamp(row.get("endDate"))
            if start != int(slug.rsplit("-", 1)[1]) * 1000 or end - start != 300_000:
                raise ValueError("five_minute_identity")
            if not start <= receipt_utc_ms <= end - 60_000:
                raise ValueError("not_current_or_less_than_60_seconds")
            question, rules = row.get("question"), row.get("description")
            if not isinstance(question, str) or not question.strip() or not isinstance(rules, str) or not rules.strip():
                raise ValueError("original_question_rules_required")
            tokens, labels = array(row.get("clobTokenIds")), array(row.get("outcomes"))
            if len(tokens) != 2 or any(not isinstance(x, str) or not re.fullmatch(r"[0-9]{1,80}", x) for x in tokens) or tokens[0] == tokens[1]:
                raise ValueError("two_original_tokens_required")
            if len(labels) != 2 or any(not isinstance(x, str) for x in labels) or set(labels) not in ({"Yes", "No"}, {"Up", "Down"}):
                raise ValueError("unsupported_original_outcomes")
            candidates.append({"market_id": mid, "slug": slug, "condition_id": condition,
                               "start_utc_ms": start, "end_utc_ms": end,
                               "question": question, "rules": rules,
                               "outcomes": [{"label": label, "token_id": token} for label, token in zip(labels, tokens)],
                               "raw_row_index": index, "semantic_admission": False})
        except (ValueError, TypeError, OverflowError) as exc:
            rejected.append({"row_index": index, "reason": str(exc)})
    # Conflicting/duplicated eligible identity is ambiguous, never select around it.
    for key in ("market_id", "condition_id", "slug"):
        if len({c[key] for c in candidates}) != len(candidates):
            raise ValueError("ambiguous_duplicate_" + key)
    all_tokens = [x["token_id"] for c in candidates for x in c["outcomes"]]
    if len(set(all_tokens)) != len(all_tokens):
        raise ValueError("ambiguous_duplicate_token")
    candidates.sort(key=lambda c: (c["end_utc_ms"], c["market_id"]))
    return {"selected": candidates[0] if candidates else None, "eligible_count": len(candidates),
            "rejections": rejected, "raw_body_sha256": digest(raw),
            "status": "STRUCTURAL_METADATA_ONLY" if candidates else "NO_ELIGIBLE_MARKET",
            "quote_phase_admitted": False, "fee_bound": None, "profit": None}


def run(admission_path: Path) -> dict:
    admission_raw = admission_path.read_bytes()
    admission = json.loads(admission_raw)
    protocol_raw = PROTOCOL.read_bytes()
    protocol = json.loads(protocol_raw)
    # Protocol constants cannot silently drift independently of the executable.
    expected = {"schema": "ADR_POLY003_PHASE_A_PROTOCOL_V1", "url": URL,
                "max_attempts": 1, "max_body_bytes": BODY_LIMIT,
                "request_deadline_seconds": 10, "shared_wall_seconds": 300,
                "shared_public_reads": 3, "shared_body_bytes": 8388608}
    if protocol != expected:
        raise ValueError("protocol_constants_mismatch")
    start_mono = time.monotonic()
    now = int(time.time() * 1000)
    if (admission.get("schema") != "ADR_POLY003_PHASE_A_INDEPENDENT_ADMISSION_V1"
            or admission.get("execution_admitted") is not True
            or admission.get("protocol_sha256") != digest(protocol_raw)
            or admission.get("source_sha256") != digest(Path(__file__).read_bytes())
            or admission.get("scope") != "ONE_METADATA_READ_ONLY"):
        raise ValueError("independent_exact_hash_admission_required")
    begin, deadline = admission.get("not_before_utc_ms"), admission.get("expires_utc_ms")
    if (type(begin) is not int or type(deadline) is not int
            or not begin <= now < deadline or not 0 < deadline - begin <= 300_000):
        raise ValueError("finite_admission_window_required")
    name = admission.get("run_name")
    if not isinstance(name, str) or not re.fullmatch(r"maker-phase-a-[a-zA-Z0-9_-]{1,80}", name):
        raise ValueError("isolated_run_name_required")
    base = (REPO / "reports/evidence").resolve()
    if base != REPO / "reports/evidence":
        raise ValueError("symlinked_evidence_root")
    if signal.getitimer(signal.ITIMER_REAL) != (0.0, 0.0):
        raise ValueError("existing_process_alarm")
    out = base / name
    out.mkdir(exist_ok=False)  # Persistent single-use claim before network I/O.
    (out / "admission.json").write_bytes(admission_raw)
    (out / "protocol.json").write_bytes(protocol_raw)
    (out / "executable.py").write_bytes(Path(__file__).read_bytes())
    request_end = start_mono + min(10, (deadline - now) / 1000)
    receipt = {"url": URL, "attempts_consumed": 1, "market_subscriptions_consumed": 0,
               "http_requests_started": 0,
               "shared_start_utc_ms": now, "shared_deadline_utc_ms": deadline,
               "admission_sha256": digest(admission_raw), "status": "REQUEST_CLAIMED",
               "body_bytes": 0, "wire_bytes": None, "actual_account_charge_USD": None,
               "quote_phase_admitted": False}
    def persist():
        (out / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
    persist()
    connection = None
    previous_alarm = signal.getsignal(signal.SIGALRM)
    def timeout(_signum, _frame):
        raise TimeoutError("absolute_request_deadline")
    def check_before_network():
        current_mono = time.monotonic()
        current_wall = int(time.time() * 1000)
        if current_mono >= request_end or current_wall >= deadline:
            raise ValueError("request_deadline_before_network")
        if abs(current_wall - now - (current_mono - start_mono) * 1000) > 100:
            raise ValueError("wall_monotonic_clock_disagreement")
    try:
        # Local evidence writes consume the original window, never renew it.
        check_before_network()
        signal.signal(signal.SIGALRM, timeout)
        signal.setitimer(signal.ITIMER_REAL, request_end - time.monotonic())
        connection = http.client.HTTPSConnection(HOST, timeout=max(0.001, request_end - time.monotonic()))
        check_before_network()
        # Direct TLS, no environment proxies, auth, cookies, redirects or retries.
        receipt["http_requests_started"] = 1
        connection.request("GET", TARGET, headers={"Accept": "application/json", "Accept-Encoding": "identity"})
        response = connection.getresponse()
        receipt.update(http_status=response.status, http_date=response.getheader("Date"))
        with (out / "raw-body.bin").open("xb") as body:
            while True:
                remaining = request_end - time.monotonic()
                if remaining <= 0:
                    raise ValueError("request_deadline")
                if connection.sock is not None:
                    connection.sock.settimeout(remaining)
                chunk = response.read1(min(65536, BODY_LIMIT - receipt["body_bytes"]))
                if not chunk:
                    break
                body.write(chunk)
                receipt["body_bytes"] += len(chunk)
                if receipt["body_bytes"] >= BODY_LIMIT:
                    raise ValueError("response_body_limit")
        receipt["received_utc_ms"] = int(time.time() * 1000)
        elapsed_ms = (time.monotonic() - start_mono) * 1000
        if elapsed_ms > 10_000 or receipt["received_utc_ms"] >= deadline:
            raise ValueError("request_deadline")
        if abs(receipt["received_utc_ms"] - now - elapsed_ms) > 100:
            raise ValueError("wall_monotonic_clock_disagreement")
        if response.status != 200:
            raise ValueError("http_status_no_retry_or_redirect")
        if response.getheader("Content-Encoding", "identity") != "identity":
            raise ValueError("unsupported_content_encoding")
        if response.getheader("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
            raise ValueError("json_content_type_required")
        result = select((out / "raw-body.bin").read_bytes(), receipt["received_utc_ms"])
        (out / "selection.json").write_text(json.dumps(result, indent=2) + "\n")
        receipt["status"] = result["status"]
        return receipt
    except Exception as exc:
        receipt.update(status="FAILED_NO_RETRY", failure=str(exc))
        raise
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous_alarm)
        if connection is not None:
            connection.close()
        receipt["elapsed_seconds"] = time.monotonic() - start_mono
        if (out / "raw-body.bin").exists():
            receipt["body_sha256"] = digest((out / "raw-body.bin").read_bytes())
        receipt["remaining_shared_reads"] = 2
        receipt["remaining_shared_body_bytes"] = 8388608 - receipt["body_bytes"]
        receipt["new_economic_labels"] = 0
        persist()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--independent-admission", type=Path, required=True)
    print(json.dumps(run(parser.parse_args().independent_admission)))
