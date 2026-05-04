# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright"]
# ///
import asyncio, os
from playwright.async_api import async_playwright

PORT = 5175

PAGES = [
    ("after_index_light", f"http://localhost:{PORT}/", "light", False),
    ("after_index_dark", f"http://localhost:{PORT}/", "dark", False),
    ("after_study_light", f"http://localhost:{PORT}/study-mode.html", "light", True),
    ("after_study_dark", f"http://localhost:{PORT}/study-mode.html", "dark", True),
]

async def main():
    os.makedirs("screenshots", exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        for name, url, theme, dismiss_modal in PAGES:
            try:
                await page.add_init_script(f"localStorage.setItem('theme', '{theme}');")
                await page.goto(url, wait_until="networkidle", timeout=15000)
                await page.wait_for_timeout(1500)
                if dismiss_modal:
                    try:
                        await page.click("#welcome-start-btn", timeout=2000)
                        await page.wait_for_timeout(800)
                    except Exception:
                        pass
                path = f"screenshots/{name}.png"
                await page.screenshot(path=path, full_page=False)
                print(f"OK  {name}")
                # Also crop hero input area
                el = await page.query_selector(".hero-search-wrapper")
                if el:
                    await el.screenshot(path=f"screenshots/{name}_input.png")
            except Exception as e:
                print(f"ERR {name}: {e}")
        await browser.close()

asyncio.run(main())
