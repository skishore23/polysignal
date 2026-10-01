#!/usr/bin/env python3
"""Publish only verified dist/site files to the dedicated GitHub Pages artifact branch.

Run explicitly after site/build.py and review. Does not merge or alter the source
branch/index. Remote push is fast-forward only. Pages must use gh-pages / as source.
"""
import os
from pathlib import Path
import subprocess
import sys

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'dist/site'
EXPECTED={'.nojekyll','index.html','styles.css','app.js','favicon.svg','icon.png','scenarios.json',
          'release.json','polysignal-research.zip','polysignal-research.zip.sha256',
          'privacy.html','terms.html','support.html','methods.html','license.txt'}

def git(*args,input=None):
    return subprocess.check_output(['git',*args],cwd=ROOT,input=input).decode().strip()


def main():
    subprocess.run([sys.executable,str(ROOT/'site/verify.py')],check=True)
    if {p.name for p in OUT.iterdir()}!=EXPECTED:raise ValueError('Unexpected file in site output')
    source=git('rev-parse','HEAD')
    if git('status','--porcelain','--','site','plugins/polysignal-research','scripts/package-research-plugin.py'):
        raise ValueError('Commit source changes before publishing')
    remote=git('ls-remote','origin','refs/heads/gh-pages')
    parent=[]
    if remote:
        git('fetch','origin','gh-pages')
        parent=['-p',remote.split()[0]]
    entries=[]
    for p in sorted(OUT.iterdir()):
        if not p.is_file() or p.is_symlink():raise ValueError('Only regular public artifacts may be published')
        blob=git('hash-object','-w','--stdin',input=p.read_bytes())
        entries.append(f'100644 blob {blob}\t{p.name}\n')
    tree=git('mktree',input=''.join(entries).encode())
    commit=git('commit-tree',tree,*parent,'-m',f'Publish PolySignal Research site from {source}')
    subprocess.run(['git','push','origin',f'{commit}:refs/heads/gh-pages'],cwd=ROOT,check=True)
    print(f'Published Pages artifact commit {commit}')


if __name__=='__main__':main()
