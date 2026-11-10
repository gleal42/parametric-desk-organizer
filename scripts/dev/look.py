"""Screenshots of the main states, for looking at: python3 scripts/dev/look.py [phone|desktop|small] [dark]"""
import sys
from harness import Session

size = sys.argv[1] if len(sys.argv) > 1 else 'phone'
dark = 'dark' in sys.argv[2:]
with Session(size, dark=dark) as s:
    s.open()
    s.shot('3d')
    s.js("() => window.__builder.select('m3')"); s.settle(600)
    s.shot('3d-selected')
    s.page.click('#viewPlan'); s.settle(600)
    s.shot('plan-selected')
    s.js("() => window.__builder.select(null)"); s.settle(300)
    s.shot('plan')
    s.page.click('#view3d')
    s.page.click('#tab-style'); s.settle(400)
    s.shot('style')
    s.page.click('#tab-print'); s.settle(400)
    s.shot('print')
    if size != 'desktop':
        s.page.click('#grab'); s.settle(500)
        s.shot('print-max')
    print('\n'.join(s.errors) or 'no errors')
