import hashlib
import json
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import unittest
from decimal import Decimal, localcontext

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT/'scripts'))
from research import scenario, book, bound, journal, decode


class PluginTests(unittest.TestCase):
    def fixture(self, name):
        return json.loads((ROOT/'examples'/f'{name}.json').read_text())

    def test_hand_calculated_share_fee(self):
        r = scenario(self.fixture('scenario'))['result']
        self.assertEqual(Decimal(r['grossShares']), 20)
        self.assertEqual(Decimal(r['netShares']), 19)
        self.assertEqual(Decimal(r['pnl']), Decimal('.944'))

    def test_missing_exit_is_not_zero(self):
        data = self.fixture('scenario')
        missing = scenario(dict(data, exit=None))['result']
        zero = scenario(dict(data, exit='0'))['result']
        self.assertIsNone(missing['pnl'])
        self.assertEqual(Decimal(missing['upperPnl']), 9)
        self.assertEqual(Decimal(zero['pnl']), -10)

    def test_fee_rounding_at_half_unit(self):
        from economics import fee
        self.assertEqual(fee('1', '.5', '.00002'), Decimal('.00001'))

    def test_cash_budget_and_share_conservation(self):
        rng = random.Random(1907)
        with localcontext() as context:
            context.prec = 60
            for _ in range(250):
                for asset in ('cash', 'shares'):
                    data = dict(self.fixture('scenario'), entry=f'0.{rng.randint(10,85)}',
                                exit=f'0.{rng.randint(10,85)}', feeAsset=asset, slippageBps='25')
                    r = scenario(data)['result']
                    self.assertLessEqual(Decimal(r['spent']), 10)
                    self.assertEqual(Decimal(r['sellShares'])+Decimal(r['residualShares']), Decimal(r['netShares']))
                    self.assertLessEqual(Decimal(r['lowerPnl']), Decimal(r['upperPnl']))

    def test_input_rejection(self):
        for bad in ('NaN', 'Infinity', '-1', '1e100', '.5', '0.1234567890123', True, 0.5):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                scenario(dict(self.fixture('scenario'), entry=bad))
        for field in ('rate', 'feeAsset'):
            data = self.fixture('scenario'); del data[field]
            with self.assertRaises(ValueError): scenario(data)
        with self.assertRaises(ValueError):
            scenario(dict(self.fixture('scenario'), extra='ignored?'))
        with self.assertRaises(ValueError):
            scenario(dict(self.fixture('scenario'), entry='0.99', slippageBps='1000'))

    def test_tiny_share_fee_rejected(self):
        with self.assertRaisesRegex(ValueError, 'exceeds acquired'):
            scenario(dict(self.fixture('scenario'), budget='0.000006', entry='0.000001', rate='1', exit=None))

    def test_partial_depth_and_weighted_midpoint(self):
        r = book(self.fixture('book'))
        self.assertFalse(r['depthSweep']['complete'])
        self.assertEqual(Decimal(r['depthSweep']['notional']), Decimal('2.57'))
        self.assertEqual(Decimal(r['depthSweep']['unfilledShares']), 1)
        self.assertEqual(Decimal(r['vwap']), Decimal('.514'))
        self.assertLessEqual(Decimal('.48'), Decimal(r['microprice']))
        self.assertLessEqual(Decimal(r['microprice']), Decimal('.51'))

    def test_sell_sorting_and_empty_book(self):
        r = book(dict(self.fixture('book'), side='SELL', quantity='3',
                      bids=[{'price':'0.3','size':'2'}, {'price':'0.7','size':'2'}]))
        self.assertEqual(Decimal(r['depthSweep']['notional']), Decimal('1.7'))
        r = book(dict(self.fixture('book'), asks=[]))
        self.assertEqual(Decimal(r['depthSweep']['filledShares']), 0)
        self.assertIsNone(r['vwap']); self.assertIsNone(r['microprice'])

    def test_crossed_and_duplicate_levels(self):
        data = self.fixture('book')
        r = book(dict(data, bids=[{'price':'0.9','size':'1'}]))
        self.assertTrue(r['crossed']); self.assertIsNone(r['microprice'])
        with self.assertRaises(ValueError):
            book(dict(data, asks=data['asks']+data['asks']))

    def test_complete_set_is_conditional(self):
        data = self.fixture('bound'); r = bound(data)
        self.assertEqual(Decimal(r['lowerBound']), Decimal('.18'))
        self.assertTrue(r['conditionalArithmeticPass'])
        self.assertFalse(r['venueEvidenceAuthenticated'])
        del data['legs'][0]['receiptRef']
        self.assertFalse(bound(data)['conditionalArithmeticPass'])
        data['legs'][0]['conditionId'] = 'other'
        with self.assertRaises(ValueError): bound(data)

    def test_trusted_journal_and_tamper(self):
        expected = self.fixture('manifest')['rootHash']
        r = journal(ROOT/'examples/events.jsonl', ROOT/'examples/manifest.json', expected)
        self.assertTrue(r['matchesSuppliedRoot'])
        self.assertFalse(r['venueEvidenceAuthenticated'])
        with self.assertRaises(ValueError):
            journal(ROOT/'examples/events.jsonl', ROOT/'examples/manifest.json', 'a'*64)
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)/'events.jsonl'
            p.write_text((ROOT/'examples/events.jsonl').read_text().replace('0.5', '0.6'))
            with self.assertRaises(ValueError): journal(p, ROOT/'examples/manifest.json')

    def test_rewritten_chain_needs_external_root(self):
        original = self.fixture('manifest')['rootHash']
        event = json.loads((ROOT/'examples/events.jsonl').read_text())
        del event['hash']; event['payload']['price'] = '0.6'
        digest = hashlib.sha256(json.dumps(event, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        event['hash'] = digest
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp); (p/'e').write_text(json.dumps(event)+'\n')
            (p/'m').write_text(json.dumps({'records':1,'rootHash':digest}))
            self.assertTrue(journal(p/'e',p/'m')['chainVerified'])
            with self.assertRaises(ValueError): journal(p/'e',p/'m', original)

    def test_strict_json(self):
        for raw in ('{"a":1,"a":2}', '{"a":NaN}'):
            with self.assertRaises(ValueError): decode(raw)

    def test_cli_in_unrelated_working_directory(self):
        with tempfile.TemporaryDirectory() as tmp:
            for command in ('scenario','book','bound'):
                proc = subprocess.run([sys.executable, str(ROOT/'scripts/research.py'), command,
                                       '--input', str(ROOT/'examples'/f'{command}.json')],
                                      cwd=tmp, capture_output=True, text=True)
                self.assertEqual(proc.returncode, 0, proc.stderr)
                self.assertTrue(json.loads(proc.stdout)['ok'])
            proc = subprocess.run([sys.executable, str(ROOT/'scripts/research.py'), 'scenario',
                                   '--input', str(Path(tmp)/'missing')], capture_output=True, text=True)
            self.assertEqual(proc.returncode, 2); self.assertEqual(proc.stdout, '')
            self.assertFalse(json.loads(proc.stderr)['ok'])


if __name__ == '__main__':
    unittest.main()
