# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright"]
# ///
import asyncio
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        page.on("pageerror", lambda e: print(f"[pageerror] {e}"))

        await page.add_init_script("localStorage.setItem('theme', 'light');")
        await page.goto("http://localhost:5176/study-mode.html", wait_until="networkidle", timeout=15000)
        await page.wait_for_timeout(1500)
        try:
            await page.click("#welcome-start-btn", timeout=2000)
            await page.wait_for_timeout(500)
        except Exception:
            pass

        # BEFORE send - inspect parent chain
        print("=== BEFORE SEND ===")
        info = await page.evaluate("""() => {
            const chain = ['study-hero', 'study-chat-active', 'study-main'];
            const result = {};
            for (const id of chain) {
                const el = document.getElementById(id);
                if (!el) { result[id] = 'NOT FOUND'; continue; }
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                result[id] = {
                    rect: `${r.width}x${r.height} @ (${r.x},${r.y})`,
                    display: cs.display,
                    flex: cs.flex,
                    height: cs.height,
                    parent: el.parentElement?.tagName + '.' + (el.parentElement?.className || '')
                };
            }
            // Walk up from study-main
            let el = document.getElementById('study-main');
            const ancestors = [];
            while (el) {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                ancestors.push({
                    tag: el.tagName + (el.id ? '#' + el.id : '') + (el.className ? '.' + el.className.split(' ').join('.') : ''),
                    rect: `${r.width}x${r.height}`,
                    display: cs.display,
                    flex: cs.flex,
                });
                el = el.parentElement;
            }
            return { result, ancestors };
        }""")
        for k, v in info['result'].items():
            print(f"  {k}: {v}")
        print("Ancestors of #study-main:")
        for a in info['ancestors']:
            print(f"  {a['tag']}  {a['rect']}  display:{a['display']}  flex:{a['flex']}")

        # Now send
        await page.fill("#hero-search-input", "Test message")
        await page.click("#hero-send-btn")
        await page.wait_for_timeout(2000)

        print("\n=== AFTER SEND ===")
        info = await page.evaluate("""() => {
            const chain = ['study-hero', 'study-chat-active', 'study-main'];
            const result = {};
            for (const id of chain) {
                const el = document.getElementById(id);
                if (!el) { result[id] = 'NOT FOUND'; continue; }
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                result[id] = {
                    rect: `${r.width}x${r.height} @ (${r.x},${r.y})`,
                    display: cs.display,
                    flex: cs.flex,
                    height: cs.height,
                };
            }
            return result;
        }""")
        for k, v in info.items():
            print(f"  {k}: {v}")

        await browser.close()

asyncio.run(main())
