#!/usr/bin/env python3
"""Offline plugin boundary. JSON in/out; no networking, credentials, or execution."""
import argparse
from decimal import Decimal, InvalidOperation, localcontext
import hashlib
import json
from pathlib import Path
import re
import sys

from economics import roundtrip, sweep, complete_set_bound

MAX_JSON = 4_000_000
MAX_JOURNAL = 100_000_000
NUMBER = re.compile(r"^(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,12})?$")
HASH = re.compile(r"^[0-9a-f]{64}$")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def decode(raw):
    def reject(value):
        raise ValueError(f"Nonfinite JSON number: {value}")
    return json.loads(raw, object_pairs_hook=unique_object, parse_constant=reject)


def read_json(path):
    with Path(path).open('rb') as stream:
        raw = stream.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON:
        raise ValueError('JSON input exceeds 4 MB')
    return decode(raw)


def fields(obj, required, optional=()):
    if not isinstance(obj, dict):
        raise ValueError('Expected a JSON object')
    missing, extra = set(required) - obj.keys(), obj.keys() - set(required) - set(optional)
    if missing or extra:
        raise ValueError(f'Input fields: missing={sorted(missing)}, unexpected={sorted(extra)}')


def number(value, maximum='999999999'):
    # Decimal strings avoid JSON binary-float loss; ordinary integers are exact too.
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not NUMBER.fullmatch(str(value)):
        raise ValueError('Use nonnegative decimal strings (up to 12 places) or integers; no exponent notation')
    result = Decimal(value)
    if result > Decimal(maximum):
        raise ValueError('Numeric value exceeds supported range')
    return result


def scenario(data):
    fields(data, ('entry', 'exit', 'rate', 'slippageBps', 'feeAsset', 'budget'))
    entry = number(data['entry'], '0.999999')
    if entry < Decimal('0.000001'):
        raise ValueError('Entry must be at least 0.000001')
    exit_price = None if data['exit'] is None else number(data['exit'], '1')
    result = roundtrip(entry, exit_price, number(data['rate'], '1'),
                       number(data['slippageBps'], '1000'), data['feeAsset'], number(data['budget']))
    if Decimal(result['netShares']) < 0:
        raise ValueError('Rounded share fee exceeds acquired shares; scenario is not representable')
    return {'model': 'q*p*(1-p)*rate; fee rounded half-up to 0.00001',
            'assumptions': data, 'result': result, 'observedExecution': False,
            'interpretation': 'User-specified fee scenario, not a verified current or historical venue schedule. '
            'An exit of null preserves a value interval. Residual shares remain separate from sold-share P&L.'}


def levels(value):
    if not isinstance(value, list) or len(value) > 10000:
        raise ValueError('Expected at most 10000 price levels')
    seen, parsed = set(), []
    for level in value:
        fields(level, ('price', 'size'))
        price, size = number(level['price'], '1'), number(level['size'])
        if price in seen:
            raise ValueError('Duplicate price level: aggregate each price before analysis')
        seen.add(price)
        if size:
            parsed.append({'price': str(price), 'size': str(size)})
    return parsed


def book(data):
    fields(data, ('bids', 'asks', 'quantity', 'side'))
    bids, asks = levels(data['bids']), levels(data['asks'])
    side, quantity = data['side'], number(data['quantity'])
    if side not in ('BUY', 'SELL'):
        raise ValueError('side must be BUY or SELL')
    bid = max(bids, key=lambda x: Decimal(x['price'])) if bids else None
    ask = min(asks, key=lambda x: Decimal(x['price'])) if asks else None
    result = {'bestBid': bid, 'bestAsk': ask, 'twoSided': bool(bid and ask),
              'crossed': False, 'midpoint': None, 'spread': None, 'microprice': None}
    if bid and ask:
        bp, ap, bq, aq = map(Decimal, (bid['price'], ask['price'], bid['size'], ask['size']))
        result['crossed'] = bp > ap
        if not result['crossed']:
            result.update(midpoint=str((bp + ap)/2), spread=str(ap-bp),
                          microprice=str((ap*bq + bp*aq)/(bq+aq)))
    result['depthSweep'] = sweep(asks if side == 'BUY' else bids, quantity, side)
    filled = Decimal(result['depthSweep']['filledShares'])
    result['vwap'] = str(Decimal(result['depthSweep']['notional'])/filled) if filled else None
    result['observedExecution'] = False
    result['interpretation'] = ('Snapshot depth only; excludes fees, queue position, latency and liquidity changes. '
                               'Microprice is a size-weighted midpoint, not a forecast. Crossed books require investigation.')
    return result


def bound(data):
    fields(data, ('legs', 'totalCost', 'remainingCostCap'))
    if not isinstance(data['legs'], list) or len(data['legs']) != 2:
        raise ValueError('Require exactly two legs')
    for leg in data['legs']:
        fields(leg, ('outcome', 'conditionId', 'collateralAsset', 'tokenId', 'netShares'),
               ('finality', 'receiptRef', 'partitionVerified'))
        for key in ('outcome', 'conditionId', 'collateralAsset', 'tokenId'):
            if not isinstance(leg[key], str) or not leg[key].strip():
                raise ValueError(f'{key} must be a nonempty string')
        for key in ('finality', 'receiptRef'):
            if key in leg and (not isinstance(leg[key], str) or not leg[key].strip()):
                raise ValueError(f'{key} must be a nonempty string when supplied')
        if 'partitionVerified' in leg and not isinstance(leg['partitionVerified'], bool):
            raise ValueError('partitionVerified must be a boolean')
        number(leg['netShares'])
    return complete_set_bound(data['legs'], number(data['totalCost']), number(data['remainingCostCap']))


def journal(path, manifest_path, expected_root=None):
    manifest = read_json(manifest_path)
    if not isinstance(manifest, dict) or not isinstance(manifest.get('rootHash'), str) or not HASH.fullmatch(manifest['rootHash']):
        raise ValueError('Manifest requires a SHA-256 rootHash')
    if type(manifest.get('records')) is not int or manifest['records'] < 0:
        raise ValueError('Manifest requires a nonnegative integer record count')
    if expected_root is not None and not HASH.fullmatch(expected_root):
        raise ValueError('Expected root must be a lowercase SHA-256 hash')
    head, count, total = '0'*64, 0, 0
    with Path(path).open('rb') as stream:
        while True:
            raw = stream.readline(MAX_JSON+1)
            if not raw:
                break
            total += len(raw)
            if len(raw) > MAX_JSON or total > MAX_JOURNAL:
                raise ValueError('Journal exceeds 4 MB per record or 100 MB total')
            event = decode(raw)
            if not isinstance(event, dict):
                raise ValueError('Journal record must be an object')
            digest = event.pop('hash', None)
            count += 1
            canonical = json.dumps(event, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
            if (type(event.get('sequence')) is not int or event['sequence'] != count or
                    event.get('previousHash') != head or hashlib.sha256(canonical).hexdigest() != digest):
                raise ValueError(f'Invalid journal chain at record {count}')
            head = digest
    if count != manifest['records'] or head != manifest['rootHash']:
        raise ValueError('Journal does not match manifest root/count')
    if expected_root is not None and head != expected_root:
        raise ValueError('Journal does not match independently supplied root')
    return {'chainVerified': True, 'records': count, 'rootHash': head,
            'matchesSuppliedRoot': expected_root is not None,
            'venueEvidenceAuthenticated': False,
            'interpretation': 'Internal integrity only. Trust depends on an independently retained root. '
            'A rewritten journal plus rewritten manifest can pass. This does not establish coverage, causality, or fills.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('scenario', 'book', 'bound'):
        sub.add_parser(name).add_argument('--input', type=Path, required=True)
    audit = sub.add_parser('journal')
    audit.add_argument('--events', type=Path, required=True)
    audit.add_argument('--manifest', type=Path, required=True)
    audit.add_argument('--expected-root')
    args = parser.parse_args()
    try:
        with localcontext() as context:
            context.prec = 60
            if args.command == 'journal':
                result = journal(args.events, args.manifest, args.expected_root)
            else:
                result = {'scenario': scenario, 'book': book, 'bound': bound}[args.command](read_json(args.input))
        print(json.dumps({'ok': True, 'command': args.command, 'data': result}, indent=2, allow_nan=False))
        return 0
    except (ValueError, KeyError, TypeError, InvalidOperation, OSError, RecursionError) as error:
        print(json.dumps({'ok': False, 'error': str(error)}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
