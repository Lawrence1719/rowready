import { expect, test, type Page } from '@playwright/test';

async function importSmallFile(page: Page): Promise<void> {
  await page.getByLabel('Import CSV, TSV, or Excel').setInputFiles({
    name: 'notification-check.csv', mimeType: 'text/csv', buffer: Buffer.from('Name\nAlice'),
  });
  await expect(page.getByRole('heading', { name: 'notification-check.csv', level: 1 })).toBeVisible();
}

test('action notifications animate in, automatically animate out, and leave the workspace intact', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  await importSmallFile(page);
  const notification = page.getByTestId('notification-toast');
  await expect(notification).toBeVisible();
  await expect(notification).toHaveAttribute('role', 'status');
  await expect(notification).toContainText('imported');
  await expect(notification).toHaveAttribute('data-state', 'open');
  await expect(notification).toHaveCSS('animation-name', 'toast-enter');

  // Observe the actual timer-driven exit rather than advancing worker or animation clocks.
  const exit = await notification.evaluate(element => new Promise<{ name: string; duration: string }>(resolve => {
    const observer = new MutationObserver(check);
    function check() {
      if (element.getAttribute('data-state') !== 'closed') return;
      const style = getComputedStyle(element);
      observer.disconnect();
      resolve({ name: style.animationName, duration: style.animationDuration });
    }
    observer.observe(element, { attributes: true, attributeFilter: ['data-state'] });
    check();
  }));
  expect(exit.name).toBe('toast-exit');
  expect(parseFloat(exit.duration)).toBeGreaterThan(0);
  await expect(notification).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit row 1, Name: Alice', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('notifications fit a mobile screen and respect reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await importSmallFile(page);
  const notification = page.getByTestId('notification-toast');
  await expect(notification).toBeVisible();
  await expect(notification).toHaveCSS('animation-name', 'none');
  const bounds = await notification.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await notification.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(notification).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'notification-check.csv', level: 1 })).toBeVisible();
});
