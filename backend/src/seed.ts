import { faker } from '@faker-js/faker';
import { v4 as uuidv4 } from 'uuid';
import { Dataset, Transaction, writeStore, readStore, Store } from './common/storage';
import { logger } from './lib/logger';
import { PROVIDERS } from './providers/registry';

/**
 * Maps each dataset `type` to its marketplace category and a realistic data
 * generator, so seeded datasets are coherent (a "yield-data" dataset actually
 * contains yield rows, not random key/value noise).
 */
const TYPE_CONFIG: Record<
  string,
  { category: string; tags: string[]; makeData: () => Record<string, unknown> }
> = {
  'whale-wallets': {
    category: 'on-chain-flows',
    tags: ['whales', 'on-chain', 'flows'],
    makeData: () => ({
      source: 'On-chain tracker',
      movements: faker.helpers.multiple(
        () => ({
          amount: faker.number.int({ min: 1000, max: 90000 }),
          asset: faker.helpers.arrayElement(['XLM', 'USDC', 'AQUA']),
          at: faker.date.recent({ days: 3 }).toISOString(),
        }),
        { count: 5 },
      ),
    }),
  },
  'trading-signals': {
    category: 'trading-signals',
    tags: ['signals', 'trading'],
    makeData: () => ({
      source: 'Signals engine',
      signals: faker.helpers.multiple(
        () => ({
          asset: faker.helpers.arrayElement(['XLM', 'AQUA', 'yXLM', 'SHX']),
          signal: faker.helpers.arrayElement(['buy', 'sell', 'hold']),
          strength: faker.number.float({ min: 0.3, max: 0.95, fractionDigits: 2 }),
        }),
        { count: 4 },
      ),
    }),
  },
  'yield-data': {
    category: 'defi-yields',
    tags: ['yield', 'defi', 'apy'],
    makeData: () => ({
      source: 'Yield aggregator',
      opportunities: faker.helpers.multiple(
        () => ({
          protocol: faker.company.name().split(',')[0],
          symbol: faker.helpers.arrayElement(['USDC', 'USDT', 'DAI']),
          apy: faker.number.float({ min: 1, max: 18, fractionDigits: 2 }),
          tvlUsd: faker.number.int({ min: 1_000_000, max: 2_000_000_000 }),
        }),
        { count: 5 },
      ),
    }),
  },
  'risk-scores': {
    category: 'risk-intelligence',
    tags: ['risk', 'protocol'],
    makeData: () => ({
      source: 'Risk model',
      protocols: faker.helpers.multiple(
        () => ({
          protocol: faker.company.name().split(',')[0],
          riskScore: faker.number.int({ min: 5, max: 95 }),
          riskLevel: faker.helpers.arrayElement(['Low', 'Medium', 'High']),
        }),
        { count: 5 },
      ),
    }),
  },
  'nft-data': {
    category: 'nft-analytics',
    tags: ['nft', 'floor'],
    makeData: () => ({
      source: 'NFT index',
      collections: faker.helpers.multiple(
        () => ({
          collection: faker.commerce.productName(),
          floorXlm: faker.number.int({ min: 50, max: 5000 }),
          change7d: faker.number.float({ min: -20, max: 30, fractionDigits: 1 }),
        }),
        { count: 4 },
      ),
    }),
  },
  sentiment: {
    category: 'market-sentiment',
    tags: ['sentiment', 'market'],
    makeData: () => ({
      source: 'Sentiment engine',
      sentiment: faker.helpers.arrayElement(['Bullish', 'Neutral', 'Bearish']),
      avgChange24h: faker.number.float({ min: -8, max: 8, fractionDigits: 2 }),
    }),
  },
};

const DATA_TYPES = Object.keys(TYPE_CONFIG);

/**
 * Generates a mock Stellar G-address using valid characters (A-Z, 2-7).
 */
const generateStellarAddress = () => {
  return 'G' + faker.string.fromCharacters('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', 55);
};

const seed = async () => {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      '[seed] Refusing to run in production (NODE_ENV=production). Aborting to protect live data.',
    );
    process.exit(1);
  }

  const clean = process.argv.includes('--clean');
  logger.info(
    `Starting seeding... ${clean ? '(Cleaning existing data)' : '(Appending to existing data)'}`,
  );

  const store: Store = clean
    ? { datasets: [], transactions: [], webhooks: [], payoutFailures: [], claimableBalances: [] }
    : await readStore();

  const newDatasets: Dataset[] = [];

  // Always include one live, provider-backed dataset per registered provider so
  // the marketplace demonstrates real data feeds after seeding.
  logger.info(`Bootstrapping ${PROVIDERS.length} live provider datasets...`);
  for (const provider of PROVIDERS) {
    const snapshot = await provider.refresh();
    newDatasets.push({
      id: `ds-live-${provider.id}`,
      name: `${provider.displayName} ${provider.type.replace('-', ' ')}`,
      description: `Live ${provider.type.replace('-', ' ')} sourced from ${provider.displayName}.`,
      type: provider.type,
      category: provider.category,
      pricePerQuery: parseFloat(faker.finance.amount({ min: 0.5, max: 1.5, dec: 2 })),
      sellerWallet: generateStellarAddress(),
      provider: provider.id,
      live: true,
      lastRefreshedAt: snapshot.fetchedAt,
      tags: [provider.type],
      data: {
        ...snapshot.data,
        _points: snapshot.points,
        _headline: snapshot.headline,
        _live: snapshot.live,
        _fetchedAt: snapshot.fetchedAt,
      },
      queriesServed: faker.number.int({ min: 50, max: 3000 }),
      totalEarned: 0,
      createdAt: faker.date.past({ years: 1 }).toISOString(),
    });
  }

  // Generate additional static datasets with coherent, type-appropriate data.
  const numDatasets = 20;
  logger.info(`Generating ${numDatasets} static datasets...`);
  for (let i = 0; i < numDatasets; i++) {
    const type = faker.helpers.arrayElement(DATA_TYPES);
    const config = TYPE_CONFIG[type];
    if (!config) continue;
    const name =
      faker.company.name().split(',')[0] +
      ' ' +
      faker.helpers.arrayElement([
        'Index',
        'Signals',
        'Alpha',
        'Intelligence',
        'Analytics',
        'Oracle',
      ]);
    const queriesServed = faker.number.int({ min: 10, max: 5000 });
    const pricePerQuery = parseFloat(faker.finance.amount({ min: 0.1, max: 5, dec: 2 }));

    newDatasets.push({
      id: `ds-${uuidv4()}`,
      name,
      description: faker.commerce.productDescription(),
      type,
      category: config.category,
      pricePerQuery,
      sellerWallet: generateStellarAddress(),
      live: false,
      tags: config.tags,
      data: config.makeData(),
      queriesServed,
      totalEarned: parseFloat((queriesServed * pricePerQuery).toFixed(2)),
      createdAt: faker.date.past({ years: 1 }).toISOString(),
    });
  }

  store.datasets.push(...newDatasets);

  // Generate Transactions against the seeded datasets.
  const numTransactions = 150;
  logger.info(`Generating ${numTransactions} transactions...`);
  for (let i = 0; i < numTransactions; i++) {
    const dataset = faker.helpers.arrayElement(store.datasets);
    const tx: Transaction = {
      id: `tx-${uuidv4()}`,
      datasetId: dataset.id,
      txHash: faker.string.hexadecimal({ length: 64, prefix: '' }).toLowerCase(),
      amount: dataset.pricePerQuery,
      sellerPaid: true,
      sellerAmount: parseFloat((dataset.pricePerQuery * 0.95).toFixed(7)),
      buyerQuery: faker.lorem.sentence().replace(/\.$/, '') + '?',
      aiSummary: faker.lorem.sentences(2),
      timestamp: faker.date.recent({ days: 90 }).toISOString(),
    };
    store.transactions.push(tx);
  }

  await writeStore(store);
  logger.info(
    `Seeding complete! Total in store: ${store.datasets.length} datasets, ${store.transactions.length} transactions.`,
  );
};

seed().catch(logger.error);
