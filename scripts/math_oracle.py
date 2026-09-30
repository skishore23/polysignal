"""Independent Decimal reference for the bounded paper-economics differential gate.

Input is a JSON array on stdin. Output is a JSON array of decimal strings on
stdout. This module imports no PolySignal implementation or fixtures.
"""

import json
import sys
from decimal import Decimal, ROUND_HALF_UP, getcontext

getcontext().prec = 50
D = Decimal
TEN_THOUSAND = D("10000")


def evaluate(case):
    kind = case["kind"]
    if kind == "fee":
        q, rate, p = map(D, (case["shares"], case["rate"], case["price"]))
        fee = (q * rate * p * (D(1) - p)).quantize(D("0.00001"), rounding=ROUND_HALF_UP)
        return {"fee": str(fee)}
    if kind == "trade":
        side = D(1) if case["side"] == "BUY" else D(-1)
        q, v, p, mid, fee = map(D, (case["shares"], case["value"], case["price"], case["mid"], case["cash_fee"]))
        gross = side * q * (v - p)
        net = gross - fee
        return {"gross": str(gross), "net": str(net), "bps": str(TEN_THOUSAND * net / (q * mid))}
    if kind == "score":
        spread, distance, size, multiplier = map(D, (case["spread_cents"], case["distance_cents"], case["shares"], case["multiplier"]))
        score = ((spread - distance) / spread) ** 2 * size * multiplier
        return {"score": str(score)}
    if kind == "position":
        entry_size, close_size, entry, exit_price, mark = map(D, (
            case["entry_size"], case["close_size"], case["entry_price"],
            case["exit_price"], case["mark"]
        ))
        remaining = entry_size - close_size
        return {
            "remaining": str(remaining),
            "basis": str(entry if remaining else D(0)),
            "realized": str(close_size * (exit_price - entry)),
            "unrealized": str(remaining * (mark - entry)),
        }
    raise ValueError("unsupported oracle case")


def main():
    cases = json.load(sys.stdin)
    if not isinstance(cases, list) or not cases:
        raise ValueError("oracle requires nonempty case array")
    json.dump([evaluate(case) for case in cases], sys.stdout, separators=(",", ":"))


if __name__ == "__main__":
    main()
