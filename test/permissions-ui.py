"""Browser regression checks against test/fixtures/permissions-ui.mjs only.

Start the fixture (`node test/fixtures/permissions-ui.mjs`, port 7913), then run
`uv run --no-project --with playwright python test/permissions-ui.py`.
Set DESKPORT_TEST_CHROMIUM to reuse a browser.
Optional screenshots are written to --screenshots (never to the repository).
"""
import argparse
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

args = argparse.ArgumentParser()
args.add_argument("--url", default="http://127.0.0.1:7913")
args.add_argument("--screenshots")
opts = args.parse_args()
base = opts.url.rstrip("/")
screenshots = Path(opts.screenshots) if opts.screenshots else None
if screenshots:
    screenshots.mkdir(parents=True, exist_ok=True)


def context(browser, email="admin@example.com", **kwargs):
    ctx = browser.new_context(**kwargs)
    ctx.add_cookies([{"name": "deskport-test-user", "value": email, "url": base}])
    return ctx


def person(page, email="editor@example.com"):
    return page.locator(f'.pp-person[data-email="{email}"]')


def checkbox(page, machine, level, email="editor@example.com"):
    return person(page, email).locator(f'input[data-machine="{machine}"][data-level="{level}"]')


def save(page, control, checked):
    with page.expect_response(lambda r: "/api/admin/people/" in r.url and r.request.method == "PUT"):
        control.set_checked(checked)
    expect(person(page)).to_have_attribute("aria-busy", "false")


def grant(ctx, email, machines, reads, add=True):
    res = ctx.request.put(f"{base}/api/admin/people/{email}",
                          data={"machines": machines, "readMachines": reads, "addMachines": add},
                          headers={"Origin": base})
    assert res.ok, res.text()


def open_people(page):
    page.goto(base)
    page.wait_for_load_state("networkidle")
    page.locator("#people-open").click()
    expect(person(page)).to_be_visible()


def capture(page, name):
    if screenshots:
        page.screenshot(path=str(screenshots / f"{name}.png"))


def contrast(page):
    colors = page.evaluate("""() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d');
      const rgb = color => { ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const pair = document.querySelector('#people .pp-perm');
      const label = pair.querySelector('.pp-check span');
      const note = document.querySelector('#people .pp-note');
      const box = document.querySelector('#people input:checked[data-level]');
      return [[rgb(getComputedStyle(label).color), rgb(getComputedStyle(pair).backgroundColor)],
        [rgb(getComputedStyle(note).color), rgb(getComputedStyle(document.querySelector('#people .dialog-card')).backgroundColor)],
        [rgb(getComputedStyle(box, '::before').borderLeftColor), rgb(getComputedStyle(box).backgroundColor)]];
    }""")

    def light(rgb):
        linear = [c / 255 / 12.92 if c / 255 <= 0.04045 else ((c / 255 + 0.055) / 1.055) ** 2.4 for c in rgb]
        return sum(c * w for c, w in zip(linear, [0.2126, 0.7152, 0.0722]))

    for foreground, background in colors:
        a, b = sorted([light(foreground), light(background)])
        assert (b + 0.05) / (a + 0.05) >= 4.5, f"low contrast: {foreground} on {background}"


with sync_playwright() as p:
    launch = {"headless": True}
    if os.environ.get("DESKPORT_TEST_CHROMIUM"):
        launch["executable_path"] = os.environ["DESKPORT_TEST_CHROMIUM"]
    browser = p.chromium.launch(**launch)
    admin = context(browser, viewport={"width": 1280, "height": 900})
    fixture = admin.request.get(f"{base}/__test/fixture")
    assert fixture.ok and fixture.json().get("fixture") == "deskport-permissions-ui", "Only run this test against the isolated permissions UI fixture"
    assert admin.request.post(f"{base}/__test/reset").ok, "the fixture must start with clean permissions and event history"
    page = admin.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    open_people(page)
    for theme in ["light", "dark"]:
        page.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
        contrast(page)
        capture(page, f"people-desktop-{theme}")

    expect(checkbox(page, "laptop", "edit")).to_be_checked()
    save(page, checkbox(page, "laptop", "read"), True)
    expect(checkbox(page, "laptop", "read")).to_be_checked()
    expect(checkbox(page, "laptop", "edit")).not_to_be_checked()
    expect(checkbox(page, "laptop", "read")).to_be_focused()
    with page.expect_response(lambda r: "/api/admin/people/" in r.url and r.request.method == "PUT"):
        page.keyboard.press("Space")
    expect(checkbox(page, "laptop", "read")).not_to_be_checked()
    save(page, person(page).locator("[data-add-machines]"), True)
    expect(checkbox(page, "server", "edit")).to_be_checked()
    save(page, checkbox(page, "*", "read"), True)
    expect(checkbox(page, "server", "edit")).to_be_checked()
    expect(checkbox(page, "laptop", "read")).to_be_checked()
    expect(checkbox(page, "laptop", "read")).to_be_disabled()
    save(page, checkbox(page, "server", "edit"), False)
    expect(checkbox(page, "server", "read")).to_be_checked()
    save(page, checkbox(page, "*", "edit"), True)
    expect(checkbox(page, "server", "edit")).to_be_checked()
    expect(checkbox(page, "server", "edit")).to_be_disabled()

    grant(admin, "editor@example.com", ["laptop", "server"], [], False)
    page.locator('[data-people="close"]').click()
    open_people(page)
    held = []
    page.route("**/api/admin/people/editor*", lambda route: held.append(route))
    checkbox(page, "laptop", "read").check()
    expect(person(page)).to_have_attribute("aria-busy", "true")
    expect(checkbox(page, "laptop", "edit")).to_be_disabled()
    page.wait_for_function("document.querySelector('.pp-person[aria-busy=true]') !== null")
    assert held, "the save request is held for the loading/error check"
    held[0].fulfill(status=500, content_type="application/json", body='{"error":"Test save failure"}')
    expect(person(page)).to_have_attribute("aria-busy", "false")
    expect(checkbox(page, "laptop", "edit")).to_be_checked()
    expect(checkbox(page, "laptop", "read")).not_to_be_checked()
    expect(checkbox(page, "laptop", "read")).to_be_focused()
    expect(person(page).get_by_role("alert")).to_contain_text("Not saved")
    page.unroute("**/api/admin/people/editor*")

    for width, height, label in [(390, 844, "mobile"), (320, 680, "narrow-mobile"), (768, 1024, "tablet")]:
        mobile = context(browser, viewport={"width": width, "height": height}, has_touch=True, is_mobile=True, device_scale_factor=3)
        mp = mobile.new_page()
        mp.on("pageerror", lambda error: errors.append(str(error)))
        open_people(mp)
        for theme in ["light", "dark"]:
            mp.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
            contrast(mp)
            assert mp.locator("#people").evaluate("e => e.scrollWidth <= e.clientWidth"), f"overflow at {width}"
            assert mp.locator("#people-list").evaluate("e => e.scrollWidth <= e.clientWidth"), f"list overflow at {width}"
            assert mp.locator(".pp-check").first.bounding_box()["height"] >= 40
            assert mp.locator(".pp-add").first.bounding_box()["height"] >= 44
            capture(mp, f"people-{label}-{theme}")
        mobile.close()
    page.emulate_media(forced_colors="active")
    assert checkbox(page, "laptop", "edit").evaluate("e => getComputedStyle(e).appearance") == "auto"
    page.emulate_media(forced_colors="none")

    # Role changes are exercised against fake streams, never a real terminal.
    reader = context(browser, "reader@example.com", viewport={"width": 1280, "height": 900})
    rp = reader.new_page()
    rp.on("pageerror", lambda error: errors.append(str(error)))
    rp.goto(base)
    rp.wait_for_load_state("networkidle")
    expect(rp.locator("#people-open")).to_be_hidden()
    expect(rp.locator("#add-machine-open")).to_be_visible()
    rp.locator('button[data-view="term"]:visible').first.click()
    expect(rp.locator("#status .badge-text")).to_have_text("View only")
    expect(rp.locator('[data-action="paste"]').first).to_be_disabled()
    rp.locator(".xterm-helper-textarea").focus()
    rp.keyboard.type("read must not send input\n")
    rp.set_viewport_size({"width": 1000, "height": 700})
    events = admin.request.get(f"{base}/__test/events").json()
    assert not [e for e in events if e["type"] in ["input", "resize"] and e.get("email") == "reader@example.com"]

    grant(admin, "reader@example.com", ["desk"], ["laptop"])
    expect(rp.locator("#status .badge-text")).to_have_text("Connected")
    rp.locator(".xterm-helper-textarea").focus()
    rp.keyboard.type("fake input only\n")
    rp.wait_for_function("document.querySelector('.xterm-helper-textarea').readOnly === false")
    before = len([e for e in admin.request.get(f"{base}/__test/events").json() if e["type"] in ["input", "resize"] and e.get("email") == "reader@example.com"])
    assert before > 0, "Edit remains interactive"
    grant(admin, "reader@example.com", [], ["desk", "laptop"])
    expect(rp.locator("#status .badge-text")).to_have_text("View only")
    rp.locator(".xterm-helper-textarea").focus()
    rp.keyboard.type("must stop after downgrade\n")
    rp.set_viewport_size({"width": 1100, "height": 800})
    after = len([e for e in admin.request.get(f"{base}/__test/events").json() if e["type"] in ["input", "resize"] and e.get("email") == "reader@example.com"])
    assert before == after, "downgrade stops terminal input and resize"
    rp.locator('button[data-view="screen"]:visible').first.click()
    expect(rp.locator("#status .badge-text")).to_have_text("View only")
    expect(rp.locator('[data-action="super"]').first).to_be_disabled()
    expect(rp.locator('[data-action="clipboard"]').first).to_be_disabled()
    grant(admin, "reader@example.com", ["desk"], ["laptop"])
    expect(rp.locator("#status .badge-text")).to_have_text("Connected")
    grant(admin, "reader@example.com", [], ["desk", "laptop"])
    expect(rp.locator("#status .badge-text")).to_have_text("View only")
    # The first downgraded screen is deliberately busy; the bounded retry recovers.
    screen_streams = [e for e in admin.request.get(f"{base}/__test/events").json() if e["type"] == "stream" and e["kind"] == "screen" and e.get("email") == "reader@example.com"]
    assert len(screen_streams) == 4, screen_streams
    grant(admin, "reader@example.com", [], [], True)
    expect(rp.locator("body")).to_have_attribute("data-view", "machines")
    expect(rp.locator("#machine-empty")).to_contain_text("Add a machine")
    rp.locator("#add-machine-open").click()
    expect(rp.locator("#add-command")).to_contain_text("test-only-do-not-install")
    tokens = [e for e in admin.request.get(f"{base}/__test/events").json() if e["type"] == "token"]
    assert tokens[-1]["email"] == "reader@example.com"
    rp.locator('[data-add="close"]').click()
    grant(admin, "reader@example.com", [], [], False)
    rp.locator('button[data-view="machines"]:visible').first.click()
    expect(rp.locator("#add-machine-open")).to_be_hidden()
    reader.close()

    editor = context(browser, "editor@example.com")
    ep = editor.new_page()
    ep.on("pageerror", lambda error: errors.append(str(error)))
    ep.goto(base)
    ep.wait_for_load_state("networkidle")
    ep.locator('.mc[data-id="laptop"] [data-open="screen"]').click()
    expect(ep.locator("#status .badge-text")).to_have_text("View only")
    expect(ep.locator('[data-action="super"]').first).to_be_disabled()
    expect(ep.locator('[data-action="clipboard"]').first).to_be_disabled()
    editor.close()

    grant(admin, "reader@example.com", [], ["server"], False)
    assert admin.request.post(f"{base}/__test/unsupported", data={"id": "server", "enabled": True}).ok
    older = context(browser, "reader@example.com")
    op = older.new_page()
    op.on("pageerror", lambda error: errors.append(str(error)))
    op.goto(base)
    op.wait_for_load_state("networkidle")
    op.locator('.mc[data-id="server"] [data-open="term"]').click()
    expect(op.locator("#status .badge-text")).to_have_text("Agent update needed")
    op.locator('button[data-view="screen"]:visible').first.click()
    expect(op.locator("#screen-overlay-title")).to_have_text("Agent update needed")
    assert admin.request.post(f"{base}/__test/unsupported", data={"id": "server", "enabled": False}).ok
    op.locator('#screen-overlay [data-action="reconnect"]').click()
    expect(op.locator("#status .badge-text")).to_have_text("View only")
    older.close()

    admin.close()
    browser.close()
    assert not errors, errors
print("People UI, themes, responsive layout, save recovery, Read/Edit streams and portal restrictions passed.")
