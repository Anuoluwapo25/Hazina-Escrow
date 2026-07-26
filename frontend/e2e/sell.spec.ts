import { expect, test } from '@playwright/test';
import { setupApiMocks } from './helpers/mockApi';
import { navigateTo } from './helpers/navigation';

test('list a dataset from the sell page and show success', async ({ page }) => {
  await setupApiMocks(page);

  await navigateTo(page, '/sell');
  await expect(page.getByRole('heading', { name: /list your data/i })).toBeVisible();

  await page.getByPlaceholder(/e\.g\. Top 100 Whale Wallet Movements — April 2026/i).fill('My Test Dataset');
  await page.getByPlaceholder(/describe what your data contains/i).fill('A useful mock dataset for e2e testing.');
  await page.getByPlaceholder(/G\.\.\. \(56-character Stellar public key\)/i).fill('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
  await page.getByPlaceholder(/Paste your JSON data here/i).fill('{"key":"value"}');

  await page.getByRole('button', { name: /publish to marketplace/i }).click();
  await expect(page.getByText(/publish dataset\?/i)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: /^publish$/i }).click();

  await expect(page.getByRole('heading', { name: /listing live!/i })).toBeVisible({ timeout: 15_000 });

  const marketplaceResponse = page.waitForResponse(
    response => response.url().includes('/api/v1/datasets') && response.request().method() === 'GET',
  );
  await page.getByRole('button', { name: /view marketplace/i }).click();
  await marketplaceResponse;

  await expect(page.getByRole('link', { name: /view details for my test dataset/i })).toBeVisible();
});
