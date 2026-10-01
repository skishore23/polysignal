#!/usr/bin/env python3
"""Check deployed inputs, local links, mathematical examples, and download integrity."""
from decimal import Decimal
from fractions import Fraction
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit, unquote
import hashlib
import json
import zipfile

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'dist/site'
class Links(HTMLParser):
    def __init__(self): super().__init__(); self.links=[]; self.ids=set()
    def handle_starttag(self,tag,attrs):
        attrs=dict(attrs)
        if 'id' in attrs:self.ids.add(attrs['id'])
        for key in ['href','src']:
            if key in attrs:self.links.append(attrs[key])

pages={}
for path in OUT.glob('*.html'):
    parser=Links();parser.feed(path.read_text());pages[path.name]=parser
for name,parser in pages.items():
    for link in parser.links:
        u=urlsplit(link)
        if u.scheme or u.netloc:continue
        target=unquote(u.path) or name
        if target in ['./','/']:target='index.html'
        assert (OUT/target).exists(),(name,link)
        if u.fragment and target in pages:assert u.fragment in pages[target].ids,(name,link)
data=json.loads((OUT/'scenarios.json').read_text())['rows']
assert len(data)==168
assert Decimal(data['shares:0:60']['pnl'])==Decimal('.944')
assert data['shares:0:missing']['pnl'] is None
assert Decimal(data['shares:0:missing']['lowerPnl'])==-10
assert Decimal(data['shares:0:missing']['upperPnl'])==9
for row in data.values():
    assert Decimal(row['spent'])<=10
    assert Fraction(row['sellShares'])+Fraction(row['residualShares'])==Fraction(row['netShares'])
release=json.loads((OUT/'release.json').read_text())
assert hashlib.sha256((OUT/'polysignal-research.zip').read_bytes()).hexdigest()==release['sha256']
with zipfile.ZipFile(OUT/'polysignal-research.zip') as z:
    assert z.testzip() is None
    manifest=json.loads(z.read('polysignal-research/plugin.json'))
    assert manifest['version']==release['version']
assert not any(p.is_symlink() for p in OUT.iterdir())
print(f'Passed: {len(pages)} pages and local links; 168 scenarios; hand P&L/bounds; budget/share invariants; downloadable ZIP/checksum.')
