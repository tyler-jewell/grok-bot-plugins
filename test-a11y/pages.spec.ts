import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const routes = ["/", "/g/x", "/privacy.html", "/terms.html"];

async function silenceMapCdn(page: import("@playwright/test").Page): Promise<void> {
  await page.route("https://cdn.jsdelivr.net/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
}

function luminance(color: string): number {
  const parts = color.match(/\d+(\.\d+)?/g)?.slice(0, 3).map(Number) ?? [];
  if (parts.length < 3) throw new Error(`unparsed color ${color}`);
  const [r, g, b] = parts.map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} theme`, () => {
    test.use({ colorScheme: scheme });

    for (const route of routes) {
      test(`${route} has no serious or critical axe violation`, async ({ page }) => {
        await silenceMapCdn(page);
        await page.goto(route);
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const bright = luminance(bg);
        expect(bright, bg).toBeGreaterThan(scheme === "light" ? 0.4 : -1);
        expect(bright, bg).toBeLessThan(scheme === "dark" ? 0.2 : 2);
        const results = await new AxeBuilder({ page }).analyze();
        const violations = results.violations.filter((row) => row.impact === "serious" || row.impact === "critical");
        expect(violations.map((row) => `${row.id}: ${row.help}`)).toEqual([]);
      });
    }
  });
}

test("keyboard walk on the group page shows a visible focus", async ({ page }) => {
  await silenceMapCdn(page);
  await page.goto("/g/x");
  const expected = ["a.skip", "a.brand", 'a[href*="openstreetmap.org"]', 'a[href="/privacy.html"]', 'a[href="/terms.html"]'];
  for (const selector of expected) {
    await page.keyboard.press("Tab");
    const focused = page.locator(selector);
    await expect(focused).toBeFocused();
    const visible = await focused.evaluate((el) => {
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const ring = style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
      const onScreen = rect.width > 0 && rect.x > -1 && rect.x < window.innerWidth;
      return ring && onScreen;
    });
    expect(visible, selector).toBe(true);
  }
});
