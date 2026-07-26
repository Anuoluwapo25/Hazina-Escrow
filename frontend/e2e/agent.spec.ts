import { expect, test } from '@playwright/test';
import { setupApiMocks } from './helpers/mockApi';
import { navigateTo } from './helpers/navigation';

test('run the agent demo flow and render a report', async ({ page }) => {
  await setupApiMocks(page);

  await navigateTo(page, '/agent');
  await expect(page.getByRole('heading', { name: /research agent/i })).toBeVisible();

  await page.getByPlaceholder(/best low risk/i).fill('Find the best yield opportunities in DeFi');
  await page.getByRole('button', { name: /run agent/i }).click();

  await expect(page.getByText(/top opportunity/i)).toBeVisible({ timeout: 20_000 });
});
