import { expect, test } from '@playwright/test';
import { setupApiMocks } from './helpers/mockApi';
import { navigateTo } from './helpers/navigation';

test('browse the marketplace and search for a dataset', async ({ page }) => {
  await setupApiMocks(page);

  const datasetsResponse = page.waitForResponse(
    response => response.url().includes('/api/v1/datasets') && response.request().method() === 'GET',
  );

  await navigateTo(page, '/marketplace');
  await datasetsResponse;

  await expect(page.getByRole('heading', { name: /marketplace/i })).toBeVisible();
  await expect(page.getByPlaceholder(/search/i)).toBeVisible();

  const searchResponse = page.waitForResponse(
    response => response.url().includes('/api/v1/datasets') && response.url().includes('search=Yield'),
  );
  await page.getByPlaceholder(/search/i).fill('Yield');
  await searchResponse;
  await expect(page.getByText('DeFi Yield Aggregator')).toBeVisible();

  const filterResponse = page.waitForResponse(
    response => response.url().includes('/api/v1/datasets') && response.url().includes('type=yield-data'),
  );
  await page.getByRole('button', { name: /filter by yield data/i }).click();
  await filterResponse;

  await expect(page.getByRole('button', { name: /filter by yield data/i })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('DeFi Yield Aggregator')).toBeVisible();
  await expect(page.getByText('Whale Wallet Tracker')).toHaveCount(0);
});
