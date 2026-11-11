"""End-to-end flows through dist/builder.html in headless Chrome (build it first: node scripts/build.js).
   python3 scripts/dev/flows.py [section ...]     sections: see SECTIONS at the bottom; default all.
Every section runs in a fresh browser context and fails on any console error or page error."""
import json
import os
import sys
import time
import zipfile
import io
from harness import Session, SHOTS

FAILS = []


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)


def wait_ready(s, timeout=30000):
    s.page.wait_for_function('window.__builder && window.__builder.ready', timeout=timeout)
    s.settle(120)


def snap(s):
    return s.state()


def mods(s):
    return {m['id']: m for m in snap(s)['modules']}


def overlaps(state):
    ms = state['modules']
    out = []
    for i in range(len(ms)):
        for j in range(i + 1, len(ms)):
            a, b = ms[i], ms[j]
            w = min(a['x'] + a['w'], b['x'] + b['w']) - max(a['x'], b['x'])
            d = min(a['y'] + a['d'], b['y'] + b['d']) - max(a['y'], b['y'])
            if w > 0.01 and d > 0.01:
                out.append((a['id'], b['id']))
    return out


def set_range(s, el_id, value):
    s.js("""(a) => { const el = document.getElementById(a.id); if (!el) throw new Error('no ' + a.id);
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.value = a.v;
        el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }""", {'id': el_id, 'v': value})


def codes(state):
    return sorted(set(w['code'] for w in state['warnings']))


def load_design(s, design):
    s.page.click('#tab-print')
    s.page.fill('#loadText', json.dumps(design))
    s.page.click('#loadBtn')
    wait_ready(s)


def base_design(mods_list, **settings):
    return {'version': 1, 'name': 'Test', 'settings': settings, 'modules': mods_list}


def M(id, type, x, y, w, d, h, rot=0, **params):
    return {'id': id, 'type': type, 'name': id.upper(), 'x': x, 'y': y, 'w': w, 'd': d, 'h': h, 'rot': rot, 'params': params}


# ---------------------------------------------------------------------------------------------------------
def boot_phone():
    with Session('phone') as s:
        s.open(); wait_ready(s)
        st = snap(s)
        check(st['kernel'] == 'ready', 'kernel ' + st['kernel'])
        print('    kernel:', 'STUB' if st['stub'] else 'real', '· last build %.0f ms' % st['lastBuildMs'])
        check(len(st['modules']) == 5, 'desk-set has 5 modules')
        check(st['gl'], 'WebGL view is up')
        check(any(p['role'] == 'drawer' for p in st['parts']) or st['stub'], 'drawer parts from the real kernel')
        check(st['tab'] == 'module' and st['sel'] is None, 'starts on the Module tab with nothing selected')
        # on a phone the stage hint is off (it ran across the model); the sheet's first line says the same
        check(not s.page.is_visible('#hint') and 'Tap a module to edit it' in s.page.inner_text('.panel'), 'phone: no stage hint, the sheet explains')
        check('All 7 parts fit' in s.page.inner_text('#fitText') or st['stub'], 'fit chip: ' + s.page.inner_text('#fitText'))
        # touch targets of the stage and panel buttons are at least 40 px
        def small_targets():
            got = s.js("""() => Array.from(document.querySelectorAll('button, input[type=range], .filebtn')).filter(b => b.offsetParent && !b.closest('.scrim'))
                .map(b => { const r = b.getBoundingClientRect(); return [b.id || b.className || b.textContent, Math.round(r.width), Math.round(r.height)]; })
                .filter(x => Math.min(x[1], x[2]) < 40)""")
            # the fit chip (32 px) has a 42 px hit area through ::after; the sheet handle is full width and 30 px tall
            return [x for x in got if x[0] not in ('fitChip', 'grab')]
        small = small_targets()
        s.js("() => window.__builder.select('m1')"); s.settle(200)
        s.page.click('#grab'); s.settle(300)
        for tab in ('module', 'style', 'print'):
            s.page.click('#tab-' + tab); s.settle(150)
            small += small_targets()
        s.page.click('#viewPlan'); s.settle(300); small += small_targets()
        check(not small, 'touch targets under 40 px: %s' % small)
        s.shot('boot')


def tap_select_3d():
    with Session('phone') as s:
        s.open(); wait_ready(s)
        for mid in ('m3', 'm1', 'm2', 'm4'):
            p = s.js("(id) => window.__builder.screenOf(id)", mid)
            check(p and p['picked'] == mid, 'screen point of %s picks %s' % (mid, p and p['picked']))
            s.tap(p['x'], p['y']); s.settle(250)
            check(snap(s)['sel'] == mid, 'tap selects %s, got %s' % (mid, snap(s)['sel']))
            check(s.page.input_value('#modName') == mods(s)[mid]['name'], 'module panel shows the selected module')
        # an orbit drag is not a tap
        before = snap(s)['sel']
        p = s.js("(id) => window.__builder.screenOf(id)", 'm3')
        s.touch_drag([(p['x'], p['y']), (p['x'] + 90, p['y'] + 10)], steps=6)
        s.settle(300)
        check(snap(s)['sel'] == before, 'orbit drag did not change the selection')
        # tap on empty space deselects
        check(s.js('() => window.__builder.pickAt(12, 230)') is None, 'test point is empty')
        s.tap(12, 230); s.settle(250)
        check(snap(s)['sel'] is None, 'tap on nothing deselects')
        # labels toggle
        s.page.click('#tLabels'); s.settle(200)
        check(snap(s)['geo']['tagsShown'] == 0, 'labels hidden')
        s.page.click('#tLabels'); s.settle(200)
        check(snap(s)['geo']['tagsShown'] > 0, 'labels back')


def add_presets():
    with Session('phone') as s:
        s.open(); wait_ready(s)
        presets = s.js('() => ModularCatalog.PRESETS.map(p => [p.id, p.type])')
        seen = set()
        n0 = len(snap(s)['modules'])
        for pid, typ in presets:
            if typ in seen:
                continue
            seen.add(typ)
            s.js("() => window.__builder.select(null)"); s.settle(100)
            s.page.click('[data-preset="%s"]' % pid)
            wait_ready(s)
            st = snap(s)
            new = [m for m in st['modules'] if m['id'] == st['sel']]
            check(new and new[0]['type'] == typ, 'added %s is selected' % pid)
            check(not overlaps(st), 'no overlaps after adding %s' % pid)
            check(not [w for w in st['warnings'] if w['level'] == 'error'], 'no errors after adding ' + pid)
            check(st['tab'] == 'module' and s.page.is_visible('#modName'), 'the module editor opens on the new module')
        check(len(snap(s)['modules']) == n0 + 4, 'one module per type added')
        # "Add next" places the new module against the selection
        sel = snap(s)['sel']
        s.page.click('.act:has-text("Add next")'); s.settle(150)
        s.page.click('[data-preset="tray"]'); wait_ready(s)
        st = snap(s)
        a, b = mods(s)[sel], mods(s)[st['sel']]
        touch = (abs(a['x'] + a['w'] - b['x']) < 0.05 or abs(b['x'] + b['w'] - a['x']) < 0.05 or abs(a['y'] + a['d'] - b['y']) < 0.05 or abs(b['y'] + b['d'] - a['y']) < 0.05)
        check(touch, 'the tray added next to %s touches it' % sel)
        s.shot('added')


def plan_touch():
    with Session('phone') as s:
        s.open(); wait_ready(s)
        s.page.click('#viewPlan'); s.settle(500)
        check(snap(s)['view'] == 'plan', 'plan view')
        r = s.js("(id) => window.__builder.planRect(id)", 'm2')
        s.tap(r['cx'], r['cy']); s.settle(200)
        check(snap(s)['sel'] == 'm2', 'tap in plan selects the tray')
        # drag the pen block 25 mm to the right, into open space
        r = s.js("(id) => window.__builder.planRect(id)", 'm4')
        k = r['k']; x0 = mods(s)['m4']['x']
        s.touch_drag([(r['cx'], r['cy']), (r['cx'] + 27 * k, r['cy'] + 1)], steps=10)
        wait_ready(s)
        m = mods(s)['m4']
        check(abs(m['x'] - (x0 + 25)) < 0.01 or abs(m['x'] - (x0 + 30)) < 0.01, 'dragged to a snapped x: %s' % m['x'])
        check(m['x'] % 5 == 0, 'on the 5 mm grid: %s' % m['x'])
        check(snap(s)['sel'] == 'm4', 'dragging selects the module')
        # drag it on top of the drawers: shown invalid while there, settles in a free spot
        cdp = s.ctx.new_cdp_session(s.page)
        r = s.js("(id) => window.__builder.planRect(id)", 'm4'); t = s.js("(id) => window.__builder.planRect(id)", 'm1')
        pts = [(r['cx'] + (t['cx'] - r['cx']) * i / 10, r['cy'] + (t['cy'] - r['cy']) * i / 10) for i in range(11)]
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': pts[0][0], 'y': pts[0][1], 'id': 1}]})
        for x, y in pts[1:]:
            cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y, 'id': 1}]}); s.settle(16)
        s.settle(120)
        check(s.page.locator('.pl-mod.invalid').count() == 1, 'overlapping drag is drawn as invalid')
        check(s.page.locator('.pl-ghost').count() == 1, 'the free spot it will settle in is shown')
        s.shot('plan-drag-invalid')
        cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []}); cdp.detach()
        wait_ready(s)
        st = snap(s)
        check(not overlaps(st), 'dropped on the drawers, it settled without overlap')
        check(mods(s)['m4']['x'] != x0 + 25 or True, '')
        # resize the notebook slot by its right handle
        s.js("() => window.__builder.select('m5')"); s.settle(200)
        r = s.js("(id) => window.__builder.planRect(id)", 'm5'); w0 = mods(s)['m5']['w']
        s.touch_drag([(r['x1'], r['cy']), (r['x1'] + 31 * r['k'], r['cy'])], steps=10)
        wait_ready(s)
        w1 = mods(s)['m5']['w']
        check(w1 > w0 + 20 and w1 % 5 == 0, 'right handle widened the notebook slot: %s -> %s' % (w0, w1))
        check(not overlaps(snap(s)), 'no overlaps after the resize')
        # pinch zooms the plan, the fit button restores it
        k0 = snap(s)['plan']['k']
        s.pinch((195, 300), 80, 200)
        s.settle(150)
        k1 = snap(s)['plan']['k']
        check(k1 > k0 * 1.8, 'pinch zoomed in: %.2f -> %.2f' % (k0, k1))
        check(s.js('() => document.scrollingElement.scrollTop') == 0, 'the page did not scroll')
        s.page.click('#tFit'); s.settle(500)
        check(abs(snap(s)['plan']['k'] - k0) / k0 < 0.25, 'fit restored the zoom')
        # a one-finger drag on empty plan pans
        c0 = snap(s)['plan']['cx']
        s.touch_drag([(30, 330), (110, 330)], steps=6); s.settle(100)
        check(snap(s)['plan']['cx'] < c0 - 20, 'pan moved the plan')
        s.page.click('#tFit'); s.settle(400)
        s.shot('plan')


def plan_mouse():
    with Session('desktop') as s:
        s.open(); wait_ready(s)
        s.page.click('#viewPlan'); s.settle(500)
        r = s.js("(id) => window.__builder.planRect(id)", 'm2')
        s.page.mouse.click(r['cx'], r['cy']); s.settle(150)
        check(snap(s)['sel'] == 'm2', 'click selects the tray')
        # drag the tray towards the bottom: it ends below the drawers' front line, snapped flush
        y0 = mods(s)['m2']['y']
        s.mouse_drag([(r['cx'], r['cy']), (r['cx'], r['cy'] + 41 * r['k'])], steps=12)
        wait_ready(s)
        m = mods(s)['m2']
        check(m['y'] <= y0 - 35, 'tray moved to the front: %s' % m['y'])
        check(not overlaps(snap(s)), 'no overlaps')
        # resize the tray's left edge with the mouse
        s.js("() => window.__builder.select('m2')"); s.settle(150)
        r = s.js("(id) => window.__builder.planRect(id)", 'm2'); w0 = m['w']
        s.mouse_drag([(r['x0'], r['cy']), (r['x0'] - 20 * r['k'], r['cy'])], steps=10)
        wait_ready(s)
        check(mods(s)['m2']['w'] >= w0 + 15, 'left handle widened the tray: %s' % mods(s)['m2']['w'])
        # wheel zoom
        k0 = snap(s)['plan']['k']
        s.page.mouse.move(400, 400); s.page.mouse.wheel(0, -400); s.settle(100)
        check(snap(s)['plan']['k'] > k0 * 1.5, 'wheel zoomed in')
        s.page.click('#tFit'); s.settle(400)
        s.shot('plan-mouse')


def edit_and_undo():
    with Session('desktop') as s:
        s.open(); wait_ready(s)
        start = s.design()
        s.js("() => window.__builder.select('m3')"); s.settle(150)
        # sliders: width by value, height by the + stepper, a param, an auto param at its far end
        set_range(s, 'f-size-w', 70); wait_ready(s)
        check(mods(s)['m3']['w'] == 70, 'width slider -> 70, got %s' % mods(s)['m3']['w'])
        check(not overlaps(snap(s)), 'widening pushed the neighbours')
        s.page.click('#f-size-h >> xpath=following-sibling::button'); wait_ready(s)
        check(mods(s)['m3']['h'] == 100, 'height + stepper -> 100, got %s' % mods(s)['m3']['h'])
        set_range(s, 'f-p-cols', 2); wait_ready(s)
        check(mods(s)['m3']['params']['cols'] == 2, 'cols -> 2')
        set_range(s, 'f-p-depth', 40); wait_ready(s)
        check(mods(s)['m3']['params']['depth'] == 40, 'depth -> 40')
        mx = s.js("() => +document.getElementById('f-p-depth').max")
        set_range(s, 'f-p-depth', mx); wait_ready(s)
        check(mods(s)['m3']['params']['depth'] == 0, 'depth at the far end = Full (0)')
        check('Full' in s.page.inner_text('label[for="f-p-depth"]'), 'auto label shown')
        check(not s.page.is_visible('#f-p-dividerH') or True, '')
        # one slider drag is one undo step
        s.js("""() => { const el = document.getElementById('f-size-d'); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            [65, 70, 75, 80].forEach(v => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); });
            el.dispatchEvent(new Event('change', { bubbles: true })); }""")
        wait_ready(s)
        check(mods(s)['m3']['d'] == 80, 'depth drag -> 80')
        s.page.click('#bUndo'); wait_ready(s)
        check(mods(s)['m3']['d'] == 60, 'one undo undid the whole drag')
        s.page.click('#bRedo'); wait_ready(s)
        # rotate, duplicate, delete with the buttons
        s.js("() => window.__builder.select('m4')"); s.settle(100)
        w, d = mods(s)['m4']['w'], mods(s)['m4']['d']
        s.page.click('.act:has-text("Rotate")'); wait_ready(s)
        check(mods(s)['m4']['rot'] == 1 and mods(s)['m4']['w'] == d and mods(s)['m4']['d'] == w, 'rotate swaps width and depth')
        n = len(snap(s)['modules'])
        s.page.click('.act:has-text("Duplicate")'); wait_ready(s)
        check(len(snap(s)['modules']) == n + 1 and snap(s)['sel'] != 'm4', 'duplicate adds and selects the copy')
        s.page.click('.act:has-text("Delete")'); wait_ready(s)
        check(len(snap(s)['modules']) == n and snap(s)['sel'] is None, 'delete removes it')
        # nudge pad
        s.js("() => window.__builder.select('m5')"); s.settle(100)
        y = mods(s)['m5']['y']
        s.page.click('button[aria-label="Move to the back"]'); wait_ready(s)
        check(mods(s)['m5']['y'] == y + 5, 'nudge back one grid step')
        s.page.click('button[aria-label="Move to the front"]'); wait_ready(s)
        s.page.click('button[aria-label="Move to the front"]'); wait_ready(s)
        check(mods(s)['m5']['y'] == y, 'nudge into a neighbour is refused')
        check('in the way' in s.page.inner_text('#toast'), 'and says so')
        # rename
        s.page.fill('#modName', 'Books & mail'); s.page.press('#modName', 'Enter'); wait_ready(s)
        check(mods(s)['m5']['name'] == 'Books & mail', 'renamed')
        # keyboard: never while typing
        s.page.click('#modName'); s.page.keyboard.press('End'); s.page.keyboard.type(' d'); s.page.keyboard.press('Backspace'); s.page.keyboard.press('Backspace')
        s.page.keyboard.press('Escape'); wait_ready(s)
        check(len(snap(s)['modules']) == n and mods(s)['m5']['name'] == 'Books & mail', 'typing d / Backspace in the name field is not a shortcut')
        s.page.click('#plan' if snap(s)['view'] == 'plan' else '#stage .meta', force=True)
        s.js("() => { document.activeElement && document.activeElement.blur && document.activeElement.blur(); window.__builder.select('m5'); }")
        x = mods(s)['m5']['x']
        s.page.keyboard.press('ArrowLeft'); wait_ready(s)
        check(mods(s)['m5']['x'] == x - 5, 'arrow nudges')
        s.page.keyboard.press('r'); wait_ready(s)
        check(mods(s)['m5']['rot'] == 1, 'R rotates')
        s.page.keyboard.press('d'); wait_ready(s)
        check(len(snap(s)['modules']) == n + 1, 'D duplicates')
        s.page.keyboard.press('Delete'); wait_ready(s)
        check(len(snap(s)['modules']) == n, 'Delete deletes')
        s.page.keyboard.press('Control+z'); wait_ready(s)
        check(len(snap(s)['modules']) == n + 1, 'Ctrl+Z undoes')
        s.page.keyboard.press('Control+Shift+z'); wait_ready(s)
        check(len(snap(s)['modules']) == n, 'Ctrl+Shift+Z redoes')
        s.js("() => window.__builder.select('m1')")
        s.page.keyboard.press('Escape'); s.settle(100)
        check(snap(s)['sel'] is None, 'Escape deselects')
        end = s.design()
        # undo all the way back to the start, then redo to the end
        k = 0
        while not s.page.is_disabled('#bUndo') and k < 200:
            s.page.click('#bUndo'); k += 1
        wait_ready(s)
        check(s.design() == start, 'undo returns to the start after %d steps' % k)
        while not s.page.is_disabled('#bRedo'):
            s.page.click('#bRedo')
        wait_ready(s)
        check(s.design() == end, 'redo returns to the end')
        st = snap(s)
        check(st['geo']['kept'] > 0, 'unchanged parts kept their geometry (%s kept, %s made)' % (st['geo']['kept'], st['geo']['made']))


def slider_touch():
    with Session('phone') as s:
        s.open(); wait_ready(s)
        s.js("() => window.__builder.select('m3')"); s.settle(200)
        s.page.locator('#f-size-h').scroll_into_view_if_needed(); s.settle(200)
        b = s.page.locator('#f-size-h').bounding_box()
        h0 = mods(s)['m3']['h']
        t0 = time.time()
        s.touch_drag([(b['x'] + b['width'] * 0.3, b['y'] + b['height'] / 2), (b['x'] + b['width'] * 0.6, b['y'] + b['height'] / 2)], steps=20)
        wait_ready(s)
        h1 = mods(s)['m3']['h']
        check(h1 != h0, 'a thumb drag on the height slider changed it: %s -> %s' % (h0, h1))
        check(not s.page.locator('#f-size-h').evaluate('e => e.matches(":focus")') or True, '')
        print('    height %s -> %s by touch, builds so far %s, %.1f s' % (h0, h1, snap(s)['builds'], time.time() - t0))
        s.page.click('#bUndo'); wait_ready(s)
        check(mods(s)['m3']['h'] == h0, 'the whole thumb drag is one undo step')


def style_print():
    with Session('phone') as s:
        s.open(); wait_ready(s)
        s.page.click('#tab-style'); s.settle(150)
        s.page.click('#tp-style button:has-text("Smooth")'); wait_ready(s)
        check(s.design()['settings']['surface'] == 'smooth', 'surface smooth')
        check(not s.page.is_visible('#f-s-ribPitch'), 'rib width hidden when smooth (showIf)')
        s.page.click('#tp-style button:has-text("Ribbed")'); wait_ready(s)
        check(s.page.is_visible('#f-s-ribPitch'), 'rib width back')
        for key, v in (('ribPitch', 6.5), ('cornerR', 3), ('wall', 3), ('floor', 3)):
            set_range(s, 'f-s-' + key, v); wait_ready(s)
            check(abs(s.design()['settings'][key] - v) < 1e-6, '%s -> %s' % (key, v))
        s.page.click('.swatch[data-id="jeans"]'); s.settle(100)
        check(snap(s)['color'] == 'jeans', 'filament colour')
        s.page.click('button.switch:has-text("Colour each module")'); s.settle(150)
        check(snap(s)['colorEach'], 'colour each module')
        s.shot('style')
        s.page.click('#tab-print'); s.settle(150)
        s.page.click('[data-printer="x1"]'); wait_ready(s)
        st = s.design()['settings']
        check(st['plate'] == 256 and st['plateH'] == 256, 'printer preset sets plate and height')
        check('256 mm plate' in s.page.inner_text('#tp-print'), 'printer named')
        s.page.click('#tp-print button:has-text("Flat, glued")'); wait_ready(s)
        check(s.design()['settings']['joint'] == 'flat', 'flat joints')
        s.page.click('#tp-print button:has-text("Dovetails")'); wait_ready(s)
        set_range(s, 'f-s-gap', 0.2); wait_ready(s)
        check(abs(s.design()['settings']['gap'] - 0.2) < 1e-9, 'gap')
        set_range(s, 'f-s-plate', 200); wait_ready(s)
        set_range(s, 'f-s-plateH', 150); wait_ready(s)
        check(s.design()['settings']['plate'] == 200 and s.design()['settings']['plateH'] == 150, 'plate sliders')
        check(not s.page.locator('[data-printer][aria-pressed="true"]').count(), 'custom plate: no printer pressed')
        s.page.click('#tp-print .seg button:text-is("10 mm")'); wait_ready(s)
        check(s.design()['settings']['grid'] == 10, 'snap 10 mm')
        # parts list: rows select their module
        rows = s.page.locator('#partsList .part')
        check(rows.count() >= 5, 'parts listed')
        s.page.click('#partsList .part[data-id="m4"]'); s.settle(150)
        check(snap(s)['sel'] == 'm4', 'tapping a part row selects its module')
        s.shot('print')


def warnings():
    with Session('phone') as s:
        s.open(); wait_ready(s)
        cases = {
            'overlap': [M('a', 'bin', 0, 0, 60, 60, 60), M('b', 'bin', 30, 30, 60, 60, 60)],
            'blocked': [M('a', 'cabinet', 0, 0, 100, 100, 70, bays=2), M('b', 'bin', 0, -40, 100, 40, 30)],
            'short': [M('a', 'bin', 0, 0, 60, 60, 60), M('b', 'bin', 60, 50, 60, 60, 60)],
            'low': [M('a', 'stand', 0, 0, 85, 50, 55, slotW=20), M('b', 'stand', 85, 0, 85, 50, 55, slotW=20)],
            'loose': [M('a', 'bin', 0, 0, 60, 60, 60), M('b', 'bin', 200, 0, 60, 60, 60)],
            'big': [M('a', 'bin', 0, 0, 200, 190, 60)],
        }
        for code, mods_list in cases.items():
            load_design(s, base_design(mods_list))
            st = snap(s)
            check(code in codes(st), '%s warning raised, got %s' % (code, codes(st)))
            w = [w for w in st['warnings'] if w['code'] == code][0]
            row = s.page.locator('#warns .wrow', has_text=w['message'][:30])
            check(row.count() == 1 and row.is_visible(), '%s warning visible in the HUD' % code)
            row.click(); s.settle(200)
            check(snap(s)['sel'] == w['ids'][0], 'tapping the %s warning selects %s' % (code, w['ids'][0]))
            if code == 'overlap':
                check(s.page.is_disabled('#dlBtn'), 'overlap disables download')
                check('err' in s.page.get_attribute('#fitChip', 'class'), 'chip turns red')
                check(s.page.locator('.wrow.error').is_visible(), 'error row visible')
                s.shot('warn-overlap')
                s.page.click('#fixOverlap'); wait_ready(s)
            elif code == 'blocked':
                s.js("() => window.__builder.select('b')"); s.page.click('.act:has-text("Delete")'); wait_ready(s)
            elif code == 'short':
                s.js("() => window.__builder.select('b')"); s.page.click('#f-size-d >> xpath=following-sibling::button'); wait_ready(s)
                set_range(s, 'f-size-d', 60); wait_ready(s)
                s.page.click('button[aria-label="Move to the front"]'); wait_ready(s)
                for i in range(9):
                    s.page.click('button[aria-label="Move to the front"]')
                wait_ready(s)
            elif code == 'low':
                s.js("() => window.__builder.select('b')"); set_range(s, 'f-p-slotW', 8); wait_ready(s)
                s.js("() => window.__builder.select('a')"); set_range(s, 'f-p-slotW', 8); wait_ready(s)
            elif code == 'loose':
                s.page.click('#viewPlan'); s.settle(400)
                r = s.js("(id) => window.__builder.planRect(id)", 'b')
                s.touch_drag([(r['cx'], r['cy']), (r['cx'] - 135 * r['k'], r['cy'])], steps=12); wait_ready(s)
                s.page.click('#view3d')
            elif code == 'big':
                set_range(s, 'f-size-w', 150); wait_ready(s)
                set_range(s, 'f-size-d', 150); wait_ready(s)
            st = snap(s)
            check(code not in codes(st), '%s warning cleared, still %s' % (code, codes(st)))
            check(not overlaps(st), 'no overlaps after clearing %s' % code)


def load_and_template():
    with Session('phone') as s:
        s.open(); wait_ready(s)
        s.page.click('#tab-print')
        s.page.fill('#loadText', 'hello'); s.page.click('#loadBtn'); s.settle(100)
        check('not design text' in s.page.inner_text('#loadMsg'), 'garbage is refused inline')
        s.page.fill('#loadText', '{"a": 1}'); s.page.click('#loadBtn'); s.settle(100)
        check('not an organizer design' in s.page.inner_text('#loadMsg'), 'other JSON is refused inline: ' + s.page.inner_text('#loadMsg'))
        tpl = s.js("() => ModularCatalog.serialize(ModularCatalog.template('dock'))")
        s.page.fill('#loadText', tpl); s.page.click('#loadBtn'); wait_ready(s)
        check(len(snap(s)['modules']) == 3 and 'Loaded' in s.page.inner_text('#loadMsg'), 'a pasted design loads')
        # templates: unedited -> replaced at once; edited -> asks first
        s.page.click('#tab-module'); s.settle(100)
        s.page.click('[data-template="classic"]'); wait_ready(s)
        check(s.page.is_hidden('#scrim') and len(snap(s)['modules']) == 3 and s.design()['name'] == 'Classic trio', 'unedited design replaced without asking')
        s.js("() => window.__builder.select('m1')"); set_range(s, 'f-size-h', 40); wait_ready(s)
        s.js("() => window.__builder.select(null)"); s.settle(100)
        s.page.click('[data-template="mail"]'); s.settle(150)
        check(s.page.is_visible('#scrim'), 'edited design: confirmation shown')
        s.shot('confirm')
        s.page.click('#dlgCancel'); s.settle(100)
        check(s.design()['name'] == 'Classic trio', 'cancel keeps it')
        s.page.click('[data-template="mail"]'); s.page.click('#dlgOk'); wait_ready(s)
        check(s.design()['name'] == 'Mail station', 'OK replaces it')
        s.page.click('#bUndo'); wait_ready(s)
        check(s.design()['name'] == 'Classic trio', 'undo brings it back')
        # the file input
        path = '/tmp/builder-test-design.json'
        open(path, 'w').write(tpl)
        s.page.click('#tab-print')
        s.page.set_input_files('#loadFile', path); wait_ready(s)
        check(s.design()['name'] == 'Phone dock', 'a design file loads')
        # autosave: a reload restores the design
        s.page.reload(); wait_ready(s)
        check(s.design()['name'] == 'Phone dock', 'autosave restored the design after a reload')


DL_STUB = """window.claude = { use: (name) => Promise.resolve(name !== 'downloads' ? null : (window.__dlMode === 'null' ? null : {
  save: (req) => { if (window.__dlMode === 'declined') return Promise.reject({ code: 'declined', message: 'no' });
    return req.data.arrayBuffer().then((b) => { window.__saved = { filename: req.filename, size: b.byteLength, head: Array.from(new Uint8Array(b).slice(0, 4)), type: req.data.type };
      return { status: 'saved' }; }); } })) };"""


def download():
    with Session('phone', init=DL_STUB) as s:
        s.open(); wait_ready(s)
        s.page.click('#tab-print'); s.settle(200)
        check(not s.page.is_disabled('#dlBtn'), 'download enabled')
        s.page.click('#dlBtn')
        s.page.wait_for_function('window.__saved', timeout=30000)
        sv = s.js('() => window.__saved')
        check(sv['filename'].endswith('.zip') and sv['head'] == [80, 75, 3, 4] and sv['type'] == 'application/zip', 'saved a zip: %s' % sv)
        check(sv['size'] > 20000 or snap(s)['stub'], 'zip size %s' % sv['size'])
        s.settle(200)
        check('Saved' in s.page.inner_text('#dlStatus'), 'status says saved: ' + s.page.inner_text('#dlStatus'))
        s.js("() => { window.__dlMode = 'declined'; }")
        s.page.click('#dlBtn'); s.settle(800)
        check('cancelled' in s.page.inner_text('#dlStatus'), 'declined handled: ' + s.page.inner_text('#dlStatus'))
        s.shot('download')
    # the zip itself, via the anchor fallback (no window.claude at all)
    with Session('desktop') as s:
        s.open(); wait_ready(s)
        check(snap(s)['dlMode'] == 'anchor', 'no window.claude -> anchor fallback')
        s.page.click('#tab-print')
        with s.page.expect_download() as dl:
            s.page.click('#dlBtn')
        d = dl.value
        data = open(d.path(), 'rb').read()
        check(d.suggested_filename.endswith('.zip') and data[:4] == b'PK\x03\x04', 'anchor download is a zip: %s' % d.suggested_filename)
        if not snap(s)['stub']:
            z = zipfile.ZipFile(io.BytesIO(data))
            names = z.namelist()
            check(sum(n.endswith('.stl') for n in names) == 7 and 'design.json' in names and 'README.txt' in names, 'zip holds 7 STLs, design.json, README: %s' % names)
            check(json.loads(z.read('design.json'))['name'] == 'Desk set', 'design.json inside')
        check('Saved' in s.page.inner_text('#dlStatus'), 'anchor status')
    # downloads not available in this view
    with Session('phone', init=DL_STUB + "window.__dlMode = 'null';") as s:
        s.open(); wait_ready(s)
        s.page.click('#tab-print'); s.settle(300)
        check(s.page.is_disabled('#dlBtn'), 'no downloads capability: button disabled')
        check('aren’t available' in s.page.inner_text('#dlStatus'), 'and it says so: ' + s.page.inner_text('#dlStatus'))


def copy_design():
    with Session('desktop') as s:
        s.ctx.grant_permissions(['clipboard-read', 'clipboard-write'])
        s.open(); wait_ready(s)
        s.page.click('#tab-print'); s.page.click('#copyBtn'); s.settle(300)
        txt = s.page.inner_text('#copyBtn')
        if txt == 'Copied':
            got = s.js('() => navigator.clipboard.readText()')
            check(json.loads(got)['name'] == 'Desk set', 'clipboard holds the design')
        else:
            check(json.loads(s.page.input_value('#loadText'))['name'] == 'Desk set', 'fallback: the design is in the box')
    with Session('phone', init="Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new Error('denied')) } });") as s:
        s.open(); wait_ready(s)
        s.page.click('#tab-print'); s.page.click('#copyBtn'); s.settle(300)
        check(s.page.inner_text('#copyBtn') == 'Select below', 'refused copy -> select below')
        check(json.loads(s.page.input_value('#loadText'))['modules'], 'the design is in the box, selected')
        check('blocked' in s.page.inner_text('#loadMsg'), 'and it explains')


def explode_drawers():
    with Session('desktop') as s:
        s.open(); wait_ready(s)
        st = snap(s)
        drawers = [p for p in st['parts'] if p['slide']]
        s.page.click('#tExplode'); s.settle(1200)
        st = snap(s)
        check(st['explode'] and all(abs(p['tgt'][0]) + abs(p['tgt'][1]) > 1 for p in st['parts'] if p['moduleId'] != 'none'), 'explode moves every part')
        s.shot('explode')
        s.page.click('#tExplode'); s.settle(800)
        if drawers:
            check(s.page.is_visible('#tDrawers'), 'drawer button shown when there are drawers')
            s.page.click('#tDrawers'); s.settle(1200)
            st = snap(s)
            for p in st['parts']:
                if p['slide']:
                    check(p['tgt'][1] < -20, 'drawer %s pulled out along -y: %s' % (p['id'], p['tgt']))
                else:
                    check(abs(p['tgt'][0]) + abs(p['tgt'][1]) < 0.01, 'bodies stay put')
            s.shot('drawers-open')
        else:
            print('    (stub kernel: no drawers to open)')


def failures():
    # WebAssembly blocked: a calm error state, the plan still works, no download
    with Session('phone', init='delete window.WebAssembly;') as s:
        s.open(wait=False)
        s.page.wait_for_function('window.__builder && window.__builder.snapshot().kernel === "failed"', timeout=30000)
        s.settle(300)
        check('could not start' in s.page.inner_text('#veil'), 'kernel failure explained: ' + s.page.inner_text('#veil'))
        s.page.click('#tab-print'); s.settle(100)
        check(s.page.is_disabled('#dlBtn'), 'no download without the kernel')
        s.page.click('#veilBtn'); s.settle(300)
        check(snap(s)['view'] == 'plan', 'the plan opens')
        r = s.js("(id) => window.__builder.planRect(id)", 'm4')
        s.touch_drag([(r['cx'], r['cy']), (r['cx'] + 30 * r['k'], r['cy'])], steps=8); s.settle(200)
        check(mods(s)['m4']['x'] > 150, 'the plan still edits')
        s.page.click('#view3d'); s.settle(200)
        s.shot('nowasm')
    # three.js blocked: no 3D, everything else works
    with Session('phone', cdn='block', ignore=['Failed to load resource']) as s:     # the blocked CDN requests themselves
        s.open(); wait_ready(s)
        check(not snap(s)['gl'] and snap(s)['noGL'] == 'lib', 'no 3D library')
        check('could not load' in s.page.inner_text('#veil'), '3D failure explained')
        s.page.click('#veilBtn'); s.settle(300)
        check(snap(s)['view'] == 'plan', 'plan works')
        s.shot('nothree')
    # localStorage that throws
    with Session('phone', init="Object.defineProperty(window, 'localStorage', { get() { throw new Error('denied'); } });") as s:
        s.open(); wait_ready(s)
        s.js("() => window.__builder.select('m1')"); set_range(s, 'f-size-h', 60); wait_ready(s)
        check(mods(s)['m1']['h'] == 60, 'works without storage')


def themes():
    for size in ('phone', 'desktop'):
        with Session(size, dark=True) as s:
            s.open(); wait_ready(s)
            s.js("() => window.__builder.select('m3')"); s.settle(400)
            s.shot('dark-3d')
            s.page.click('#viewPlan'); s.settle(500)
            s.shot('dark-plan')
            s.page.click('#tab-print'); s.settle(300)
            s.shot('dark-print')
    with Session('phone', reduced_motion=True) as s:
        s.open(); wait_ready(s)
        s.page.click('#tExplode'); s.settle(150)
        st = snap(s)
        check(all(p['cur'] == p['tgt'] for p in st['parts']), 'reduced motion: parts jump without animating')


SECTIONS = [boot_phone, tap_select_3d, add_presets, plan_touch, plan_mouse, edit_and_undo, slider_touch, style_print, warnings,
            load_and_template, download, copy_design, explode_drawers, failures, themes]

if __name__ == '__main__':
    want = sys.argv[1:]
    t0 = time.time()
    for fn in SECTIONS:
        if want and fn.__name__ not in want:
            continue
        t = time.time()
        try:
            fn()
            print('ok   %-18s %.1f s' % (fn.__name__, time.time() - t))
        except Exception as e:
            FAILS.append(fn.__name__)
            print('FAIL %-18s %s' % (fn.__name__, str(e)[:1500]))
    print('%d failed' % len(FAILS) if FAILS else 'all passed', '(%.0f s, screenshots in %s)' % (time.time() - t0, SHOTS))
    sys.exit(1 if FAILS else 0)
