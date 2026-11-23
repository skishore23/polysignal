"""Offline research arithmetic. No order submission, credentials, or DB mutations."""
from decimal import Decimal, ROUND_DOWN, ROUND_HALF_UP

D = Decimal
SHARE = D('0.000001')


def decimal(value, *, minimum=None, maximum=None):
    result = D(str(value))
    if not result.is_finite() or (minimum is not None and result < D(str(minimum))) or (
        maximum is not None and result > D(str(maximum))
    ):
        raise ValueError('Invalid finite decimal or out-of-range value')
    return result


def fee(shares, price, rate):
    q, p, r = decimal(shares, minimum=0), decimal(price, minimum=0, maximum=1), decimal(rate, minimum=0, maximum=1)
    return (q * p * (1 - p) * r).quantize(D('.00001'), rounding=ROUND_HALF_UP)


def roundtrip(entry, exit_price, rate='.10', slippage_bps=25, fee_asset='shares', budget=10):
    """Budget is all-in for cash fees; missing exit retains [0, net shares] value."""
    if fee_asset not in ('shares', 'cash'):
        raise ValueError('Unsupported fee asset')
    slip = decimal(slippage_bps, minimum=0, maximum=1000) / 10000
    rate, budget = decimal(rate, minimum=0, maximum=1), decimal(budget, minimum=0)
    p = decimal(entry, minimum='.000001', maximum='.999999') * (1 + slip)
    if p >= 1:
        raise ValueError('Slippage makes entry price invalid')
    per_share = p + (rate * p * (1 - p) if fee_asset == 'cash' else 0)
    q = (budget / per_share).quantize(SHARE, rounding=ROUND_DOWN)
    buy_fee = fee(q, p, rate)
    spent = q * p + (buy_fee if fee_asset == 'cash' else 0)
    # Exact posted fee rounding can put the initial sizing just above the cap.
    while spent > budget and q > 0:
        q -= SHARE
        buy_fee = fee(q, p, rate)
        spent = q * p + (buy_fee if fee_asset == 'cash' else 0)
    net = q - (buy_fee / p if fee_asset == 'shares' else 0)
    sell_q = net.quantize(SHARE, rounding=ROUND_DOWN)
    residual = net - sell_q
    ep = decimal(exit_price, minimum=0, maximum=1) * (1 - slip) if exit_price is not None else None
    sell_fee = fee(sell_q, ep, rate) if ep is not None else None
    pnl = sell_q * ep - sell_fee - spent if ep is not None else None
    return {k: str(v) if v is not None else None for k, v in {
        'entryPrice': p, 'exitPrice': ep, 'grossShares': q, 'netShares': net,
        'sellShares': sell_q, 'residualShares': residual, 'spent': spent,
        'buyFeeEquivalent': buy_fee, 'sellFee': sell_fee, 'pnl': pnl,
        'lowerPnl': pnl if pnl is not None else -spent,
        'upperPnl': pnl + residual if pnl is not None else net - spent,
    }.items()}


def sweep(levels, quantity, side):
    """Consume full price levels; never extrapolate liquidity past retained depth."""
    if side not in ('BUY', 'SELL'):
        raise ValueError('Invalid side')
    quantity = decimal(quantity, minimum=0)
    parsed = [(decimal(x['price'], minimum=0, maximum=1), decimal(x['size'], minimum=0)) for x in levels]
    parsed.sort(key=lambda x: x[0], reverse=side == 'SELL')
    remaining, value, fills = quantity, D(0), []
    for price, available in parsed:
        size = min(remaining, available)
        if size > 0:
            fills.append({'price': str(price), 'size': str(size)})
            value += price * size
            remaining -= size
        if remaining == 0:
            break
    return {'complete': remaining == 0, 'filledShares': str(quantity - remaining),
            'unfilledShares': str(remaining), 'notional': str(value), 'fills': fills}


def complete_set_bound(legs, total_cost, remaining_cost_cap):
    """Conditional arithmetic certificate; caller assertions are not venue authentication.

    Costs must include the entire acquisition basis of these balances. Completeness and
    authenticity of supplied receipts require a separate importer/reconciliation process.
    """
    if len(legs) != 2 or {x.get('outcome') for x in legs} != {'YES', 'NO'}:
        raise ValueError('Require both complementary outcomes')
    conditions = {x.get('conditionId') for x in legs}
    collateral = {x.get('collateralAsset') for x in legs}
    if len(conditions) != 1 or not next(iter(conditions)) or len(collateral) != 1 or not next(iter(collateral)):
        raise ValueError('Condition/collateral mismatch or missing identity')
    if len({x.get('tokenId') for x in legs}) != 2 or any(not x.get('tokenId') for x in legs):
        raise ValueError('Distinct token identities required')
    balances = [decimal(x['netShares'], minimum=0) for x in legs]
    cost, cap = decimal(total_cost, minimum=0), decimal(remaining_cost_cap, minimum=0)
    matched = min(balances).quantize(SHARE, rounding=ROUND_DOWN)
    lower = matched - cost - cap
    reasons = []
    if any(x.get('finality') != 'CONFIRMED' or not x.get('receiptRef') for x in legs):
        reasons.append('missing_confirmed_receipts')
    if any(x.get('partitionVerified') is not True for x in legs):
        reasons.append('complementary_partition_unverified')
    if lower <= 0:
        reasons.append('nonpositive_bound')
    return {'matchedNetShares': str(matched), 'lowerBound': str(lower),
            'conditionalArithmeticPass': not reasons, 'reasons': reasons,
            'venueEvidenceAuthenticated': False,
            'scope': 'Conditional on supplied identities, receipts, complete cost basis and bounded remaining costs'}
