# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright"]
# ///
import asyncio, os
from playwright.async_api import async_playwright

PORT = 5176

async def main():
    os.makedirs("screenshots", exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        context = await browser.new_context(viewport={"width": 1440, "height": 900})
        page = await context.new_page()
        # Capture console messages
        console_msgs = []
        page.on("console", lambda m: console_msgs.append(f"[{m.type}] {m.text}"))
        page.on("pageerror", lambda e: console_msgs.append(f"[pageerror] {e}"))

        await page.add_init_script("localStorage.setItem('theme', 'light');")
        await page.goto(f"http://localhost:{PORT}/study-mode.html", wait_until="networkidle", timeout=15000)
        await page.wait_for_timeout(1500)

        # Dismiss welcome modal
        try:
            await page.click("#welcome-start-btn", timeout=2000)
            await page.wait_for_timeout(500)
        except Exception:
            pass

        # Screenshot BEFORE sending
        await page.screenshot(path="screenshots/issue_before_send.png", full_page=False)
        print("OK before_send")

        # Type a message and click send
        try:
            await page.fill("#hero-search-input", "Test message")
            await page.wait_for_timeout(300)
            await page.click("#hero-send-btn")
            print("Clicked send")
        except Exception as e:
            print(f"Send click error: {e}")

        # Wait for transition
        await page.wait_for_timeout(2500)
        await page.screenshot(path="screenshots/issue_after_send.png", full_page=False)
        print("OK after_send")

        # Wait a bit longer for any streaming to start
        await page.wait_for_timeout(3000)
        await page.screenshot(path="screenshots/issue_after_send_2s.png", full_page=False)

        # Print console output
        print("\n--- CONSOLE ---")
        for m in console_msgs:
            print(m)

        await browser.close()

asyncio.run(main())
