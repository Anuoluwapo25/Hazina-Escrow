import type { Page } from '@playwright/test';
import stats from '../fixtures/stats.json' with { type: 'json' };
import datasets from '../fixtures/datasets.json' with { type: 'json' };
import queryInitiate from '../fixtures/queryInitiate.json' with { type: 'json' };
import queryResult from '../fixtures/queryResult.json' with { type: 'json' };
import createDataset from '../fixtures/createDataset.json' with { type: 'json' };

/**
 * Registers page.route() handlers for all fixture endpoints.
 * Uses glob patterns so routes match regardless of VITE_API_URL.
 */
export async function setupApiMocks(page: Page): Promise<void> {
    const datasetList = datasets.data.map(dataset => ({ ...dataset }));

    const datasetResponseFor = (requestUrl: string) => {
        const url = new URL(requestUrl);
        const search = url.searchParams.get('search')?.toLowerCase() ?? '';
        const types = url.searchParams.getAll('type');
        const filtered = datasetList.filter(dataset => {
            const matchesSearch =
                !search ||
                dataset.name.toLowerCase().includes(search) ||
                dataset.description.toLowerCase().includes(search);
            const matchesType = types.length === 0 || types.includes(dataset.type);
            return matchesSearch && matchesType;
        });

        return {
            ...datasets,
            data: filtered,
            total: filtered.length,
            totalPages: 1,
        };
    };

    // Stats
    await page.route('**/api/v1/datasets/stats', route =>
        route.fulfill({ json: stats }),
    );

    // Datasets list
    await page.route('**/api/v1/datasets?**', route =>
        route.fulfill({ json: datasetResponseFor(route.request().url()) }),
    );
    // Datasets list (no query string)
    await page.route('**/api/v1/datasets', async route => {
        if (route.request().method() === 'GET') {
            return route.fulfill({ json: datasetResponseFor(route.request().url()) });
        }
        if (route.request().method() === 'POST') {
            const payload = route.request().postDataJSON() as Partial<typeof createDataset.dataset>;
            const dataset = {
                ...createDataset.dataset,
                ...payload,
                id: createDataset.dataset.id,
                queriesServed: 0,
                totalEarned: 0,
                createdAt: createDataset.dataset.createdAt,
            };
            datasetList.unshift(dataset);
            return route.fulfill({ json: { ...createDataset, dataset } });
        }
        return route.continue();
    });

    // Query initiation
    await page.route('**/api/v1/query/**', route =>
        route.fulfill({ json: queryInitiate }),
    );

    // Demo query / verify
    await page.route('**/api/v1/verify/**/demo', route =>
        route.fulfill({ json: queryResult }),
    );
    await page.route('**/api/v1/verify/**', route =>
        route.fulfill({ json: queryResult }),
    );

    // Agent endpoints
    await page.route('**/api/v1/agent/info', route =>
        route.fulfill({
            json: {
                success: true,
                agent: {
                    name: 'Hazina Agent',
                    version: '1.0.0',
                    description: 'Mock agent for e2e tests',
                    agentWallet: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE',
                    fee: { amount: 1, currency: 'USDC', network: 'Stellar Testnet', description: 'Demo fee' },
                    sellers: [
                        { type: 'yield-data', role: 'yieldData', cost: 0.05 },
                    ],
                    agentProfit: 0.86,
                    escrowWallet: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE',
                },
            },
        }),
    );
    await page.route('**/api/v1/agent/research/demo', route =>
        route.fulfill({
            json: {
                success: true,
                demo: true,
                jobId: 'job-demo',
                query: 'Find the best yield opportunities',
                report: {
                    topOpportunity: {
                        protocol: 'Aave',
                        vault: 'USDC Vault',
                        chain: 'Stellar',
                        apy: 8.4,
                        riskLevel: 'Low',
                        whaleConfidence: 'High',
                        sentimentScore: 'Bullish',
                    },
                    reasoning: 'Mocked AI reasoning for Playwright.',
                    alternatives: ['Protocol B', 'Protocol C'],
                    warnings: ['Mock warning'],
                    rawAnalysis: 'Mocked AI analysis for e2e.',
                },
                payments: {
                    humanPaid: 1,
                    currency: 'USDC',
                    network: 'Stellar Testnet',
                    sellerPayments: [{ seller: 'Seller One', type: 'yield-data', amount: 0.05, txHash: 'mock-tx', onChain: false }],
                    totalSpent: 0.05,
                    agentProfit: 0.95,
                },
                meta: {
                    agentWallet: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE',
                    timestamp: '2026-06-23T00:00:00.000Z',
                    datasetsQueried: 1,
                },
            },
        }),
    );
    await page.route('**/api/v1/agent/research', route =>
        route.fulfill({
            json: {
                success: true,
                demo: false,
                jobId: 'job-paid',
                query: 'Find the best yield opportunities',
                report: {
                    topOpportunity: {
                        protocol: 'Aave',
                        vault: 'USDC Vault',
                        chain: 'Stellar',
                        apy: 8.4,
                        riskLevel: 'Low',
                        whaleConfidence: 'High',
                        sentimentScore: 'Bullish',
                    },
                    reasoning: 'Mocked paid AI reasoning.',
                    alternatives: ['Protocol B'],
                    warnings: ['Mock warning'],
                    rawAnalysis: 'Mocked AI analysis for e2e.',
                },
                payments: {
                    humanPaid: 1,
                    currency: 'USDC',
                    network: 'Stellar Testnet',
                    sellerPayments: [{ seller: 'Seller One', type: 'yield-data', amount: 0.05, txHash: 'mock-tx', onChain: false }],
                    totalSpent: 0.05,
                    agentProfit: 0.95,
                },
                meta: {
                    agentWallet: 'GABC1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890ABCDE',
                    timestamp: '2026-06-23T00:00:00.000Z',
                    datasetsQueried: 1,
                },
            },
        }),
    );

    // Individual dataset
    await page.route('**/api/v1/datasets/ds-*', route => {
        if (route.request().method() === 'GET') {
            return route.fulfill({ json: { success: true, dataset: datasets.data[0] } });
        }
        return route.continue();
    });

    // WebSocket — stub to avoid connection errors
    await page.route('**/ws**', route => route.abort());
}
