import Anthropic from '@anthropic-ai/sdk';
import { getAnthropicResearchModel } from './anthropic.config';
import { AnthropicTimeoutError } from './claude.service';
import { logger } from '../lib/logger';

// Configurable via env; default 60 seconds (shared with claude.service)
const ANTHROPIC_TIMEOUT_MS = parseInt(process.env.ANTHROPIC_TIMEOUT_MS ?? '60000', 10);

export interface SellerDataset {
  role: string;
  displayName: string;
  data: Record<string, unknown>;
  cost: number;
}

export interface ResearchInput {
  userQuery: string;
  budget: number;
  riskTolerance: 'low' | 'medium' | 'high';
  availableSellers: SellerDataset[];
}

export interface ResearchReport {
  topOpportunity: {
    protocol: string;
    vault: string;
    chain: string;
    apy: number;
    riskLevel: string;
    whaleConfidence: string;
    sentimentScore: string;
  };
  reasoning: string;
  alternatives: string[];
  warnings: string[];
  rawAnalysis: string;
}

/**
 * Safely parse JSON from Claude response, handling markdown fences and prose.
 * Returns null if parsing fails after all attempts.
 */
function tryParseJson(raw: string): ResearchReport | null {
  // Attempt #1: Remove markdown fences and parse
  const cleaned = raw
    .replace(/^```json\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(cleaned) as ResearchReport;
  } catch {
    // Attempt #2: Extract first valid-looking JSON object
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]) as ResearchReport;
      } catch {
        // Both attempts failed
        return null;
      }
    }

    // No JSON object found
    return null;
  }
}

export async function synthesizeResearch(input: ResearchInput): Promise<ResearchReport> {
  // `timeout` (ms) is applied to every request made by this client instance.
  // The SDK throws APITimeoutError when the deadline is exceeded.
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: ANTHROPIC_TIMEOUT_MS,
  });

  const datasetSections = input.availableSellers
    .map(
      (seller, i) =>
        `DATASET ${i + 1} — ${seller.displayName.toUpperCase()} (purchased for ${seller.cost.toFixed(2)} USDC):\n${JSON.stringify(seller.data, null, 2)}`,
    )
    .join('\n\n---\n\n');

  // Static system instructions — marked for prompt caching so repeated agent
  // jobs reuse the cached token block rather than re-tokenising it (#378).
  const systemPrompt = `You are the Hazina Research Agent — an autonomous DeFi yield researcher. You have just purchased data from on-chain data sellers using micro-payments on Stellar. Synthesise all datasets into a single, actionable research report for the user.

INSTRUCTIONS:
1. Identify the single best USDC yield opportunity that matches the user's risk tolerance and budget.
2. Cross-reference all available datasets to build confidence.
3. Flag any red flags or warnings.
4. Suggest 2 alternatives if the top pick doesn't suit.

Respond ONLY with valid JSON in this exact shape (no markdown fences):
{
  "topOpportunity": {
    "protocol": "Protocol name",
    "vault": "Vault or pool name",
    "chain": "Chain name",
    "apy": 7.2,
    "riskLevel": "Low | Medium | High",
    "whaleConfidence": "High | Medium | Low | Neutral",
    "sentimentScore": "Bullish | Neutral | Bearish"
  },
  "reasoning": "2-3 sentence explanation of why this is the best pick, citing specific data from the datasets",
  "alternatives": ["Alternative 1: brief description", "Alternative 2: brief description"],
  "warnings": ["Warning if any — empty array if none"],
  "rawAnalysis": "Concise paragraph synthesising all four data sources"
}`;

  const userMessage = `USER QUERY: "${input.userQuery}"
BUDGET: $${input.budget} USDC
RISK TOLERANCE: ${input.riskTolerance}

---

${datasetSections}`;

  try {
    // First attempt — system prompt cached; only the dynamic dataset content is re-sent
    const response = await client.messages.create({
      model: getAnthropicResearchModel(),
      max_tokens: 2048,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userMessage }],
    });

    const raw = response.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('');

    let parsed = tryParseJson(raw);
    if (parsed !== null) {
      return parsed;
    }

    // Retry with stricter instruction — still benefits from cached system prompt
    logger.warn('[synthesizeResearch] Initial parse failed, retrying with stricter prompt');

    const retryResponse = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: userMessage },
        {
          role: 'user',
          content:
            'CRITICAL: Return ONLY valid JSON. Do not include explanations, markdown, code fences, or any extra text. Just the JSON object.',
        },
      ],
    });

    const retryRaw = retryResponse.content
      .filter(b => b.type === 'text')
      .map(b => (b as { type: 'text'; text: string }).text)
      .join('');

    parsed = tryParseJson(retryRaw);
    if (parsed !== null) {
      return parsed;
    }

    throw new Error(
      `Failed to parse Claude JSON response after retry. Raw output: ${raw.slice(0, 500)}`,
    );
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'name' in err && err.name === 'APITimeoutError') {
      throw new AnthropicTimeoutError(ANTHROPIC_TIMEOUT_MS);
    }
    throw err;
  }
}

/**
 * Parses risk tolerance from a natural-language query.
 * e.g. "medium risk" → 'medium', "low risk" → 'low', default → 'medium'
 */
export function parseRiskTolerance(query: string): 'low' | 'medium' | 'high' {
  const q = query.toLowerCase();
  if (q.includes('low risk') || q.includes('safe') || q.includes('conservative')) return 'low';
  if (q.includes('high risk') || q.includes('aggressive') || q.includes('degen')) return 'high';
  return 'medium';
}

/**
 * Parses a budget in USDC from a natural-language query.
 * e.g. "$500", "500 USDC", "500 budget" → 500
 */
export function parseBudget(query: string): number {
  const match = query.match(/\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(usdc|usd|budget)?/i);
  if (match) {
    const parsed = Number((match[1] ?? '').replace(/,/g, ''));
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.round(parsed);
    }
  }
  return 500; // default
}
