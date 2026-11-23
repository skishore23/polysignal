#!/usr/bin/env python3
"""Build the public research site from allowlisted sources and exact scenario math."""
from decimal import Decimal, localcontext
import hashlib
import html
import importlib.util
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / 'plugins/polysignal-research'
OUT = ROOT / 'dist/site'
sys.path.insert(0, str(PLUGIN / 'scripts'))
from research import scenario


def markdown(text):
    # The policy sources deliberately use only paragraphs, headings, and inline links.
    def inline(value):
        value = html.escape(value)
        value = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', lambda m: '<a href="'+m[2].replace('PRIVACY.md','privacy.html').replace('TERMS.md','terms.html').replace('SUPPORT.md','support.html').replace('README.md','index.html').replace('references/methods.md','methods.html').replace('LICENSE','license.txt')+'">'+m[1]+'</a>',value)
        value = re.sub(r'\*\*(.+?)\*\*',r'<strong>\1</strong>',value)
        return re.sub(r'`([^`]+)`',r'<code>\1</code>',value)
    blocks=[]
    for block in text.strip().split('\n\n'):
        level=len(block)-len(block.lstrip('#'))
        if level and block[level:level+1]==' ':
            blocks.append(f'<h{level}>{inline(block[level+1:])}</h{level}>')
        else: blocks.append('<p>'+inline(block.replace('\n',' '))+'</p>')
    return '\n'.join(blocks)


def build():
    OUT.mkdir(parents=True,exist_ok=True)
    subprocess.run([sys.executable,str(ROOT/'scripts/package-research-plugin.py')],check=True)
    manifest=json.loads((PLUGIN/'plugin.json').read_text())
    version=manifest['version']; archive=ROOT/'dist/plugins'/f'polysignal-research-{version}.zip'
    for name in ['index.html','styles.css','app.js','favicon.svg']:
        if name == 'index.html':
            (OUT/name).write_text((ROOT/'site'/name).read_text().replace('{{version}}',version))
        else:
            shutil.copy2(ROOT/'site'/name,OUT/name)
    # Stable download name; metadata and checksum expose the actual embedded version.
    for old in OUT.glob('polysignal-research-*.zip*'):
        old.unlink()  # Generated versioned downloads only; source packages remain in dist/plugins.
    shutil.copy2(archive,OUT/archive.name)
    shutil.copy2(archive,OUT/'polysignal-research.zip')
    digest=hashlib.sha256(archive.read_bytes()).hexdigest()
    (OUT/(archive.name+'.sha256')).write_text(f'{digest}  {archive.name}\n')
    (OUT/'polysignal-research.zip.sha256').write_text(f'{digest}  polysignal-research.zip\n')
    (OUT/'release.json').write_text(json.dumps({'version':version,'sha256':digest},indent=2)+'\n')
    shutil.copy2(PLUGIN/'LICENSE',OUT/'license.txt')
    shutil.copy2(PLUGIN/'assets/icon.png',OUT/'icon.png')
    rows={}
    with localcontext() as context:
        context.prec=60
        for asset in ['shares','cash']:
            for slip in ['0','25']:
                for cents in list(range(30,71))+[None]:
                    exit_price=None if cents is None else str(Decimal(cents)/100)
                    data={'entry':'0.5','exit':exit_price,'rate':'0.1','slippageBps':slip,'feeAsset':asset,'budget':'10'}
                    result=scenario(data)['result']
                    result['proceeds']=str(Decimal(result['spent'])+Decimal(result['pnl'])) if result['pnl'] is not None else None
                    rows[f'{asset}:{slip}:{cents if cents is not None else "missing"}']=result
    (OUT/'scenarios.json').write_text(json.dumps({'assumptions':{'entry':'0.50','budget':'10','rate':'0.10','curve':'q*p*(1-p)*rate'},'rows':rows},separators=(',',':'))+'\n')
    template=(ROOT/'site/policy.html').read_text()
    for title,source,target in [('Privacy policy','PRIVACY.md','privacy.html'),('Terms of use','TERMS.md','terms.html'),('Support','SUPPORT.md','support.html'),('Methods & limits','references/methods.md','methods.html')]:
        (OUT/target).write_text(template.replace('{{title}}',title).replace('{{content}}',markdown((PLUGIN/source).read_text())))
    (OUT/'.nojekyll').write_text('')
    print(f'Built {len(rows)} exact scenarios and public pages in {OUT}')


if __name__=='__main__': build()
