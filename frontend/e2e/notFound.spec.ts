import { expect, test } from '@playwright/test';
import { navigateTo } from './helpers/navigation';

test('show the 404 page for unknown routes', async ({ page }) => {
  await navigateTo(page, '/nonexistent');
  await expect(page.getByText(/404/i)).toBeVisible();
  await expect(page.getByText(/not found/i)).toBeVisible();
});
