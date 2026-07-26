import { expect, test } from '@playwright/test';
import { setupApiMocks } from './helpers/mockApi';
import { navigateTo } from './helpers/navigation';

test('run a demo query flow from the marketplace modal', async ({ page }) => {
  await setupApiMocks(page);

  await navigateTo(page, '/marketplace');
  await page.waitForSelector('text=Whale Wallet Tracker');

  await page.getByRole('button', { name: /buy/i }).first().click();
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.getByRole('button', { name: /proceed to payment/i }).click();
  await page.getByLabel(/demo mode/i).check();
  const demoQueryResponse = page.waitForResponse(
    response =>
      response.url().includes('/api/v1/verify/') &&
      response.url().includes('/demo') &&
      response.request().method() === 'POST',
  );
  await page.getByRole('button', { name: /get ai analysis/i }).click();
  const result = await (await demoQueryResponse).json();

  await expect(page.getByText(/payment verified/i)).toBeVisible({ timeout: 15_000 });
  expect(result.ai.summary).toContain('Whale activity indicates strong accumulation');
});
