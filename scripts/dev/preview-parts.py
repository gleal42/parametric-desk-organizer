"""Dev tool: screenshots the pages written by preview-parts.js.
Usage: python3 scripts/dev/preview-parts.py <dir with .html> [name ...]   ->  <dir>/<name>.png"""
import glob
import os
import sys
from playwright.sync_api import sync_playwright

d = sys.argv[1]
names = sys.argv[2:] or [os.path.basename(f)[:-5] for f in sorted(glob.glob(os.path.join(d, '*.html')))]
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist', '--allow-file-access-from-files'])
    for n in names:
        pg = b.new_page(viewport={'width': 1400, 'height': 1000})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto('file://' + os.path.abspath(os.path.join(d, n + '.html')))
        pg.wait_for_function("document.title === 'done'", timeout=60000)
        pg.locator('canvas').screenshot(path=os.path.join(d, n + '.png'))
        print(n, 'ok' if not errs else errs)
        pg.close()
    b.close()
