/**
 * corpus.ts — the hand-authored source of truth for the search relevance
 * regression suite: a small, realistic dataset catalogue plus ~30 labelled
 * (query → expected dataset) pairs.
 *
 * This file is pure data (no embeddings). `scripts/gen-search-fixtures.ts`
 * reads it, runs the *real* production pipeline (composeSearchDocument +
 * embedBatch) over every dataset document and every query, and writes the
 * result to the committed `search-fixtures.json` that
 * `search.relevance.test.ts` asserts against — so CI never calls the
 * embedding model, but is still testing genuine model output.
 *
 * Deliberately includes datasets whose titles share zero tokens with their
 * matching query (e.g. "large holder activity" → "Whale Wallet Movements")
 * — that gap is exactly what pure keyword/substring search cannot bridge,
 * and what this regression suite exists to catch a regression in.
 */

export interface FixtureDataset {
  id: string;
  name: string;
  description: string;
  category: string;
  type: string;
  tags: string[];
  data: Record<string, unknown>;
}

export interface FixtureQuery {
  query: string;
  /** The dataset id this query should surface — used for recall@5/nDCG@5. */
  expectedDatasetId: string;
  /** One-line note on why this pair is in the suite (exact/semantic/decoy/etc). */
  note: string;
}

export const FIXTURE_DATASETS: FixtureDataset[] = [
  {
    id: 'ds-whale-wallets',
    name: 'Whale Wallet Movements',
    description: 'Tracks token transfers by top-balance addresses on Stellar',
    category: 'on-chain',
    type: 'whale-wallets',
    tags: ['stellar', 'on-chain'],
    data: {
      _points: [
        { walletAddress: 'GABCDEF...', balanceUsd: 4_200_000, transferAmount: 150_000 },
        { walletAddress: 'GXYZQRS...', balanceUsd: 980_000, transferAmount: 40_000 },
      ],
    },
  },
  {
    id: 'ds-validator-health',
    name: 'Validator Node Health Report',
    description: 'Uptime, missed ledgers, and quorum participation for network validators',
    category: 'network',
    type: 'validator-health',
    tags: ['stellar', 'infrastructure'],
    data: {
      _points: [{ nodeId: 'sdf-1', uptimePct: 99.97, missedLedgers: 3, quorumVotes: 18220 }],
    },
  },
  {
    id: 'ds-yield-farming',
    name: 'DeFi Yield Opportunities',
    description: 'Comparative lending and liquidity-pool annual returns across protocols',
    category: 'defi',
    type: 'yield-data',
    tags: ['defi', 'yield'],
    data: { _points: [{ protocol: 'blend', asset: 'USDC', apy: 6.4 }] },
  },
  {
    id: 'ds-nft-floor',
    name: 'NFT Collection Floor Prices',
    description: 'Lowest listed price and sales volume per NFT collection',
    category: 'nft',
    type: 'nft-market',
    tags: ['nft', 'marketplace'],
    data: { _points: [{ collection: 'stellar-punks', floorPrice: 120, sales24h: 4 }] },
  },
  {
    id: 'ds-stablecoin-peg',
    name: 'Stablecoin Peg Deviation Tracker',
    description: 'How far each stablecoin trades from its intended dollar value over time',
    category: 'markets',
    type: 'stablecoin-peg',
    tags: ['stablecoin', 'risk'],
    data: { _points: [{ symbol: 'USDC', deviationBps: 2, timestamp: '2026-01-01' }] },
  },
  {
    id: 'ds-gas-fees',
    name: 'Network Fee Trends',
    description: 'Median cost to submit a transaction, sampled every ledger',
    category: 'network',
    type: 'fee-trends',
    tags: ['fees', 'network'],
    data: { _points: [{ ledger: 55000000, medianFeeStroops: 100 }] },
  },
  {
    id: 'ds-bridge-flows',
    name: 'Cross-Chain Bridge Flow Monitor',
    description: 'Volume and direction of assets moving between chains through bridges',
    category: 'interop',
    type: 'bridge-flows',
    tags: ['bridge', 'interop'],
    data: { _points: [{ bridge: 'allbridge', direction: 'in', volumeUsd: 2_100_000 }] },
  },
  {
    id: 'ds-governance-votes',
    name: 'DAO Governance Voting Records',
    description: 'Proposal outcomes and how each address voted on protocol governance',
    category: 'governance',
    type: 'governance-votes',
    tags: ['dao', 'governance'],
    data: { _points: [{ proposalId: 'SEP-99', outcome: 'passed', votesFor: 8_100_000 }] },
  },
  {
    id: 'ds-social-sentiment',
    name: 'Crypto Social Sentiment Index',
    description: 'Aggregated positive/negative mention scores pulled from public forums',
    category: 'sentiment',
    type: 'social-sentiment',
    tags: ['sentiment', 'social'],
    data: { _points: [{ asset: 'XLM', sentimentScore: 0.62, mentions24h: 3400 }] },
  },
  {
    id: 'ds-security-audits',
    name: 'Smart Contract Audit Findings Database',
    description: 'Severity-ranked issues discovered during independent contract reviews',
    category: 'security',
    type: 'audit-findings',
    tags: ['security', 'audits'],
    data: { _points: [{ contract: 'hazina-escrow', severity: 'low', status: 'resolved' }] },
  },
  {
    id: 'ds-price-feed',
    name: 'Real-Time Multi-Asset Price Feed',
    description: 'Streaming quote data for major tokens across several venues',
    category: 'markets',
    type: 'price-feed',
    tags: ['prices', 'oracle'],
    data: { _points: [{ symbol: 'XLM/USD', price: 0.11, venue: 'stellar-dex' }] },
  },
  {
    id: 'ds-exchange-liquidity',
    name: 'Exchange Order Book Depth',
    description: 'Bid/ask volume available at each price level on major exchanges',
    category: 'markets',
    type: 'orderbook-depth',
    tags: ['liquidity', 'exchange'],
    data: { _points: [{ venue: 'stellar-dex', pair: 'XLM/USDC', bidDepthUsd: 400_000 }] },
  },
  {
    id: 'ds-token-unlocks',
    name: 'Token Vesting Unlock Schedule',
    description: 'Upcoming dates and amounts for team and investor token releases',
    category: 'tokenomics',
    type: 'vesting-schedule',
    tags: ['vesting', 'tokenomics'],
    data: { _points: [{ project: 'exampledao', unlockDate: '2026-03-01', amountUsd: 5_000_000 }] },
  },
  {
    id: 'ds-wallet-clustering',
    name: 'Wallet Clustering & Entity Labels',
    description: 'Groups related addresses and attributes them to known exchanges or entities',
    category: 'on-chain',
    type: 'entity-labels',
    tags: ['forensics', 'on-chain'],
    data: { _points: [{ walletAddress: 'GLMNOP...', label: 'exchange-cold-wallet' }] },
  },
  {
    id: 'ds-mev-activity',
    name: 'Front-Running Bot Activity Tracker',
    description: 'Detects transactions that profit by reordering around other trades',
    category: 'security',
    type: 'mev-detection',
    tags: ['mev', 'security'],
    data: { _points: [{ txHash: 'abc123', profitUsd: 340, technique: 'sandwich' }] },
  },
  {
    id: 'ds-lending-liquidations',
    name: 'Lending Protocol Liquidation Events',
    description: 'Historical record of undercollateralized positions being closed out',
    category: 'defi',
    type: 'liquidation-events',
    tags: ['defi', 'lending'],
    data: { _points: [{ protocol: 'blend', borrower: 'GQRST...', collateralSeizedUsd: 12_000 }] },
  },
  {
    id: 'ds-stellar-anchors',
    name: 'Stellar Anchor Reserve Attestations',
    description: 'Proof-of-reserve statements showing anchors hold what they issued',
    category: 'compliance',
    type: 'anchor-attestations',
    tags: ['anchors', 'compliance'],
    data: { _points: [{ anchor: 'example-anchor', issuedUsd: 2_000_000, reserveUsd: 2_010_000 }] },
  },
  {
    id: 'ds-weather',
    name: 'Lagos Weather Forecast',
    description: 'Daily temperature, rainfall, and humidity forecast for Lagos, Nigeria',
    category: 'other',
    type: 'weather',
    tags: ['weather'],
    data: { _points: [{ date: '2026-01-02', tempC: 29, rainMm: 4 }] },
  },
  {
    id: 'ds-restaurant-reviews',
    name: 'Lagos Restaurant Reviews',
    description: 'Aggregated diner ratings and review counts for restaurants in Lagos',
    category: 'other',
    type: 'reviews',
    tags: ['food', 'reviews'],
    data: { _points: [{ restaurant: 'Nkoyo Kitchen', rating: 4.6, reviewCount: 812 }] },
  },
];

export const FIXTURE_QUERIES: FixtureQuery[] = [
  {
    query: 'large holder activity',
    expectedDatasetId: 'ds-whale-wallets',
    note: 'primary acceptance criterion — zero shared tokens with the title or any field',
  },
  {
    query: 'ds-whale-wallets',
    expectedDatasetId: 'ds-whale-wallets',
    note: 'exact dataset id must rank first',
  },
  {
    query: 'Whale Wallet Movements',
    expectedDatasetId: 'ds-whale-wallets',
    note: 'exact dataset title must rank first',
  },
  {
    query: 'who is dumping large amounts of tokens',
    expectedDatasetId: 'ds-whale-wallets',
    note: 'slang paraphrase of whale activity',
  },
  {
    query: 'big wallets offloading their bags',
    expectedDatasetId: 'ds-whale-wallets',
    note: 'crypto slang paraphrase',
  },
  {
    query: 'which data would help me judge validator reliability on Stellar?',
    expectedDatasetId: 'ds-validator-health',
    note: "the issue's own example query, phrased as a full question",
  },
  {
    query: 'network uptime for block validators',
    expectedDatasetId: 'ds-validator-health',
    note: 'partial token overlap (uptime, validators)',
  },
  {
    query: 'best APY for lending my USDC',
    expectedDatasetId: 'ds-yield-farming',
    note: 'semantic paraphrase, "APY" vs "annual returns"',
  },
  {
    query: 'yield farming opportunities across DeFi protocols',
    expectedDatasetId: 'ds-yield-farming',
    note: 'easy — high token overlap',
  },
  {
    query: 'floor price trends for NFT collections',
    expectedDatasetId: 'ds-nft-floor',
    note: 'moderate token overlap',
  },
  {
    query: 'is USDC still pegged to the dollar',
    expectedDatasetId: 'ds-stablecoin-peg',
    note: 'semantic — "pegged" vs "peg deviation"',
  },
  {
    query: 'how much does it cost to send a transaction right now',
    expectedDatasetId: 'ds-gas-fees',
    note: 'pure semantic — zero overlap with "network fee trends"',
  },
  {
    query: 'cheapest gas right now',
    expectedDatasetId: 'ds-gas-fees',
    note: 'partial overlap via crypto slang "gas"',
  },
  {
    query: 'money moving between different blockchains',
    expectedDatasetId: 'ds-bridge-flows',
    note: 'pure semantic — zero overlap with "bridge"',
  },
  {
    query: 'cross chain bridge hacks and exploits',
    expectedDatasetId: 'ds-bridge-flows',
    note: 'partial overlap via "bridge"',
  },
  {
    query: 'how are people voting on this DAO proposal',
    expectedDatasetId: 'ds-governance-votes',
    note: 'semantic paraphrase',
  },
  {
    query: 'what is crypto twitter saying about this token',
    expectedDatasetId: 'ds-social-sentiment',
    note: 'pure semantic — zero overlap with "sentiment index"',
  },
  {
    query: 'sentiment analysis of social media posts about crypto',
    expectedDatasetId: 'ds-social-sentiment',
    note: 'partial overlap via "sentiment", "social"',
  },
  {
    query: 'known vulnerabilities found in smart contract code reviews',
    expectedDatasetId: 'ds-security-audits',
    note: 'semantic — "vulnerabilities/reviews" vs "audit findings"',
  },
  {
    query: 'live prices across multiple tokens',
    expectedDatasetId: 'ds-price-feed',
    note: 'semantic paraphrase of "real-time multi-asset price feed"',
  },
  {
    query: 'how deep is the order book on this exchange',
    expectedDatasetId: 'ds-exchange-liquidity',
    note: 'partial overlap via "order book", "exchange"',
  },
  {
    query: 'when do team tokens unlock',
    expectedDatasetId: 'ds-token-unlocks',
    note: 'partial overlap via "unlock", "tokens"',
  },
  {
    query: 'who really controls this wallet address',
    expectedDatasetId: 'ds-wallet-clustering',
    note: 'semantic — "controls" vs "attributes to entities"',
  },
  {
    query: 'bots front-running trades for profit',
    expectedDatasetId: 'ds-mev-activity',
    note: 'partial overlap via "front-running"',
  },
  {
    query: 'sandwich attacks on DEX trades',
    expectedDatasetId: 'ds-mev-activity',
    note: 'semantic — "sandwich" only appears in sample data, not title/description',
  },
  {
    query: 'borrowers getting liquidated on lending platforms',
    expectedDatasetId: 'ds-lending-liquidations',
    note: 'high overlap — easy case',
  },
  {
    query: 'proof that the anchor actually holds the reserves',
    expectedDatasetId: 'ds-stellar-anchors',
    note: 'semantic — "proof/holds" vs "attestations/reserve"',
  },
  {
    query: 'ds-security-audits',
    expectedDatasetId: 'ds-security-audits',
    note: 'exact dataset id (second exact-match check)',
  },
  {
    query: 'Smart Contract Audit Findings Database',
    expectedDatasetId: 'ds-security-audits',
    note: 'exact dataset title (second exact-match check)',
  },
  {
    query: 'will it rain in Lagos tomorrow',
    expectedDatasetId: 'ds-weather',
    note: 'decoy domain — must not be confused with on-chain datasets',
  },
];
