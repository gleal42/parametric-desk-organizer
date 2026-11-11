"""Shared Playwright helpers for driving dist/builder.html in headless Chrome.

Test-only: the page itself loads three.js and the fonts from the CDN. Where the
sandbox blocks those hosts, the requests are answered from node_modules (three)
and, when present, from font files unpacked under $BUILDER_FONTS (default
/tmp/fonts, see fonts() below). The page is never modified.

    from harness import Session
    with Session('phone') as s:        # 'phone' | 'desktop', dark=True for the dark theme
        s.open()                       # loads dist/builder.html and waits for the app
        s.page.click('#tab-print')
        s.shot('print')                # -> $BUILDER_SHOTS/print.png (default /tmp/shots)
    # leaving the block fails the run if the page logged an error
"""
import glob
import json
import os
import sys
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
PAGE = 'file://' + os.path.join(ROOT, 'dist', 'builder.html')
SHOTS = os.environ.get('BUILDER_SHOTS', '/tmp/shots')
FONTS = os.environ.get('BUILDER_FONTS', '/tmp/fonts')
THREE = os.path.join(ROOT, 'node_modules', 'three')
CHROME_ARGS = ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist']
SIZES = {
    'phone': dict(viewport={'width': 390, 'height': 844}, has_touch=True, is_mobile=True, device_scale_factor=3),
    'small': dict(viewport={'width': 360, 'height': 640}, has_touch=True, is_mobile=True, device_scale_factor=2),
    'desktop': dict(viewport={'width': 1280, 'height': 800}, device_scale_factor=1),
}


def fonts():
    """(css, {url-suffix: path}) for the two families, from @fontsource packages unpacked under FONTS."""
    css, files = [], {}
    for family, pkg, weights in (('Familjen Grotesk', 'familjen-grotesk', (400, 500, 600, 700)), ('DM Mono', 'dm-mono', (400, 500))):
        for w in weights:
            hit = glob.glob(os.path.join(FONTS, '*', 'package', 'files', '%s-latin-%d-normal.woff2' % (pkg, w)))
            if not hit:
                continue
            name = os.path.basename(hit[0])
            files[name] = hit[0]
            css.append("@font-face{font-family:'%s';font-style:normal;font-weight:%d;font-display:block;"
                       "src:url(https://fonts.gstatic.com/local/%s) format('woff2');}" % (family, w, name))
    return '\n'.join(css), files


class Session:
    def __init__(self, size='phone', dark=False, cdn='local', reduced_motion=False, init=None, storage=True, ignore=()):
        self.size, self.dark, self.cdn, self.init, self.ignore = size, dark, cdn, init, tuple(ignore)
        self.reduced_motion, self.storage = reduced_motion, storage
        self.errors, self.logs = [], []

    def __enter__(self):
        self.pw = sync_playwright().start()
        self.browser = self.pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=CHROME_ARGS)
        opts = dict(SIZES[self.size])
        opts['color_scheme'] = 'dark' if self.dark else 'light'
        if self.reduced_motion:
            opts['reduced_motion'] = 'reduce'
        self.ctx = self.browser.new_context(**opts)
        self.page = self.new_page()
        return self

    def new_page(self):
        page = self.ctx.new_page()
        css, files = fonts()

        def route(r):
            url = r.request.url
            if self.cdn == 'block':
                return r.abort()
            if 'cdn.jsdelivr.net/npm/three@0.147.0/' in url:
                path = os.path.join(THREE, url.split('three@0.147.0/')[1])
                return r.fulfill(path=path, content_type='application/javascript')
            if 'fonts.googleapis.com' in url:
                return r.fulfill(body=css, content_type='text/css')
            if 'fonts.gstatic.com/local/' in url:
                name = url.rsplit('/', 1)[1]
                if name in files:
                    return r.fulfill(path=files[name], content_type='font/woff2')
            return r.abort()

        page.route(lambda u: u.startswith('http'), route)
        page.on('console', lambda m: (self.logs.append('[%s] %s' % (m.type, m.text[:400])),
                                      self.errors.append('console: ' + m.text[:400]) if m.type == 'error' and not any(i in m.text for i in self.ignore) else None))
        page.on('pageerror', lambda e: self.errors.append('pageerror: ' + str(e)[:600]))
        if self.init:
            page.add_init_script(self.init)
        return page

    def open(self, wait=True, page=None):
        page = page or self.page
        page.goto(PAGE)
        if wait:
            page.wait_for_function('window.__builder && window.__builder.ready', timeout=30000)
            page.wait_for_timeout(350)
        return page

    # -- small conveniences ---------------------------------------------------
    def js(self, expr, arg=None):
        return self.page.evaluate(expr, arg)

    def design(self):
        return self.js('() => window.__builder.design()')

    def state(self):
        return self.js('() => window.__builder.snapshot()')

    def settle(self, ms=450):
        self.page.wait_for_timeout(ms)

    def shot(self, name, full=False):
        os.makedirs(SHOTS, exist_ok=True)
        path = os.path.join(SHOTS, '%s-%s%s.png' % (name, self.size, '-dark' if self.dark else ''))
        self.page.screenshot(path=path, full_page=full)
        return path

    def tap(self, x, y):
        if SIZES[self.size].get('has_touch'):
            self.page.touchscreen.tap(x, y)
        else:
            self.page.mouse.click(x, y)

    def touch_drag(self, pts, steps=8, hold=0):
        """One-finger drag through pts [(x, y), ...] using raw touch events (CDP)."""
        cdp = self.ctx.new_cdp_session(self.page)
        x0, y0 = pts[0]
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x0, 'y': y0, 'id': 1}]})
        if hold:
            self.page.wait_for_timeout(hold)
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            for i in range(1, steps + 1):
                t = i / steps
                cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': ax + (bx - ax) * t, 'y': ay + (by - ay) * t, 'id': 1}]})
                self.page.wait_for_timeout(16)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        cdp.detach()

    def pinch(self, centre, d0, d1, steps=8):
        """Two-finger pinch about centre, finger distance d0 -> d1 (px)."""
        cdp = self.ctx.new_cdp_session(self.page)
        cx, cy = centre

        def pts(d):
            return [{'x': cx - d / 2, 'y': cy, 'id': 1}, {'x': cx + d / 2, 'y': cy, 'id': 2}]
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': pts(d0)})
        for i in range(1, steps + 1):
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': pts(d0 + (d1 - d0) * i / steps)})
            self.page.wait_for_timeout(16)
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})
        cdp.detach()

    def mouse_drag(self, pts, steps=8):
        x0, y0 = pts[0]
        self.page.mouse.move(x0, y0)
        self.page.mouse.down()
        for (ax, ay), (bx, by) in zip(pts, pts[1:]):
            self.page.mouse.move(bx, by, steps=steps)
        self.page.mouse.up()

    def check(self, cond, message):
        if not cond:
            raise AssertionError(message)

    def __exit__(self, et, ev, tb):
        try:
            self.browser.close()
        finally:
            self.pw.stop()
        if et is None and self.errors:
            raise AssertionError('page errors:\n  ' + '\n  '.join(self.errors[:12]))
        return False


if __name__ == '__main__':
    # quick look: python3 scripts/dev/harness.py [phone|desktop] [dark] [file-url]
    size = sys.argv[1] if len(sys.argv) > 1 else 'phone'
    dark = 'dark' in sys.argv[2:]
    with Session(size, dark=dark) as s:
        url = [a for a in sys.argv[2:] if a.startswith('file:')]
        if url:
            s.page.goto(url[0]); s.page.wait_for_timeout(2500)
        else:
            s.open()
        print(s.shot('look'))
        print(json.dumps(s.logs[:20], indent=1))
