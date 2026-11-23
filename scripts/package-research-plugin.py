#!/usr/bin/env python3
"""Build a reproducible, explicitly allowlisted standalone research plugin ZIP."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT/'plugins/polysignal-research'
FILES = (
    'plugin.json', '.codex-plugin/plugin.json', 'README.md', 'DISTRIBUTION.md',
    'LICENSE', 'PROVENANCE.json', 'PRIVACY.md', 'TERMS.md', 'SUPPORT.md',
    'assets/icon.png', 'assets/GENERATION.md',
    'scripts/research.py', 'scripts/economics.py', 'tests/test_plugin.py',
    'examples/scenario.json', 'examples/book.json', 'examples/bound.json',
    'examples/events.jsonl', 'examples/manifest.json', 'references/methods.md',
    'skills/evaluate-scenario/SKILL.md', 'skills/analyze-depth/SKILL.md',
    'skills/verify-evidence/SKILL.md',
)


def build():
    portable = json.loads((PLUGIN/'plugin.json').read_text())
    compat = json.loads((PLUGIN/'.codex-plugin/plugin.json').read_text())
    for key in ('name','version','description','license','author'):
        if portable[key] != compat[key]:
            raise ValueError(f'Manifest mismatch: {key}')
    interface = portable['extensions']['com.openai']['interface']
    # Older Codex overlay schema lacks supportURL; retain it in the portable manifest.
    compatible_interface = {key: value for key, value in interface.items() if key != 'supportURL'}
    if compatible_interface != compat['interface'] or len(interface['shortDescription']) > 30:
        raise ValueError('Invalid or inconsistent presentation metadata')
    for manifest in (portable, compat):
        if manifest.get('apps') is not None or manifest.get('extensions', {}).get('com.openai', {}).get('apps') is not None:
            raise ValueError('Public source archive must not include app bindings')
    provenance = json.loads((PLUGIN/'PROVENANCE.json').read_text())
    pinned = provenance['files'][0]
    if hashlib.sha256((PLUGIN/pinned['bundled']).read_bytes()).hexdigest() != pinned['sha256']:
        raise ValueError('Extracted economics no longer matches pinned source')
    for path in PLUGIN.rglob('*'):
        relative = path.relative_to(PLUGIN)
        if path.is_symlink():
            raise ValueError(f'Symlink is not distributable: {relative}')
        if path.is_file() and '__pycache__' not in relative.parts and str(relative) not in FILES:
            raise ValueError(f'Unlisted plugin file: {relative}')
    payload = {name:(PLUGIN/name).read_bytes() for name in FILES}
    hashes = {name:hashlib.sha256(data).hexdigest() for name,data in payload.items()}
    payload['CONTENTS.sha256.json'] = (json.dumps(hashes,sort_keys=True,indent=2)+'\n').encode()
    out = ROOT/'dist/plugins'; out.mkdir(parents=True,exist_ok=True)
    archive = out/f"{portable['name']}-{portable['version']}.zip"
    with zipfile.ZipFile(archive,'w',compression=zipfile.ZIP_DEFLATED) as z:
        for name,data in sorted(payload.items()):
            info = zipfile.ZipInfo(f"{portable['name']}/{name}",date_time=(2026,1,1,0,0,0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info,data)
    with zipfile.ZipFile(archive) as z:
        if z.testzip() is not None or len(z.namelist()) != len(payload):
            raise ValueError('Archive integrity failed')
        for name,data in payload.items():
            if z.read(f"{portable['name']}/{name}") != data:
                raise ValueError(f'Archive differs from source: {name}')
    checksum = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{checksum}  {archive.name}\n')
    print(json.dumps({'archive':str(archive),'files':len(payload),'sha256':checksum,
                      'publicSubmissionReady':False,'remaining':'Developer verification and portal review; see DISTRIBUTION.md'},indent=2))


if __name__ == '__main__':
    build()
