import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(function () {
    return {
      messages: {
        create: mockCreate,
      },
    };
  }),
}));

import { parseBudget, parseRiskTolerance, synthesizeResearch } from './research.service';

describe('parseRiskTolerance', () => {
  it('returns low for low-risk synonyms', () => {
    expect(parseRiskTolerance('Need a safe and conservative strategy')).toBe('low');
    expect(parseRiskTolerance('Show me LOW RISK vaults')).toBe('low');
  });

  it('returns high for aggressive/degen language', () => {
    expect(parseRiskTolerance('I want aggressive yield plays')).toBe('high');
    expect(parseRiskTolerance('Give me degen opportunities')).toBe('high');
  });

  it('defaults to medium when no clear risk signal exists', () => {
    expect(parseRiskTolerance('Find balanced opportunities for me')).toBe('medium');
  });
});

describe('parseBudget', () => {
  it('parses comma-separated budget values', () => {
    expect(parseBudget('Best low risk USDC yield with $1,250 budget')).toBe(1250);
  });

  it('parses decimal values and rounds to nearest whole USDC', () => {
    expect(parseBudget('Allocate 99.6 USDC to this strategy')).toBe(100);
  });

  it('falls back to default when no budget is found', () => {
    expect(parseBudget('Find safe stablecoin pools')).toBe(500);
  });
});

describe('synthesizeResearch', () => {
  const originalAnthropicModel = process.env.ANTHROPIC_MODEL;
  const originalAnthropicResearchModel = process.env.ANTHROPIC_RESEARCH_MODEL;

  beforeEach(() => {
    mockCreate.mockReset();
    delete process.env.ANTHROPIC_MODEL;
    delete process.env.ANTHROPIC_RESEARCH_MODEL;
  });

  afterEach(() => {
    if (originalAnthropicModel === undefined) {
      delete process.env.ANTHROPIC_MODEL;
    } else {
      process.env.ANTHROPIC_MODEL = originalAnthropicModel;
    }

    if (originalAnthropicResearchModel === undefined) {
      delete process.env.ANTHROPIC_RESEARCH_MODEL;
    } else {
      process.env.ANTHROPIC_RESEARCH_MODEL = originalAnthropicResearchModel;
    }
  });

  it('uses ANTHROPIC_RESEARCH_MODEL when configured', async () => {
    process.env.ANTHROPIC_RESEARCH_MODEL = 'claude-custom-research-model';
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            topOpportunity: {
              protocol: 'Aave',
              vault: 'USDC Core',
              chain: 'Ethereum',
              apy: 7.2,
              riskLevel: 'Low',
              whaleConfidence: 'High',
              sentimentScore: 'Bullish',
            },
            reasoning: 'Best fit.',
            alternatives: ['Alt 1', 'Alt 2'],
            warnings: [],
            rawAnalysis: 'Synthesis.',
          }),
        },
      ],
    });

    const result = await synthesizeResearch({
      userQuery: 'Find a safe USDC vault',
      budget: 500,
      riskTolerance: 'low',
      availableSellers: [],
    });

    expect(result.topOpportunity.protocol).toBe('Aave');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-custom-research-model' }),
    );
  });

  it('falls back to ANTHROPIC_MODEL when research override is unset', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-shared-model';
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            topOpportunity: {
              protocol: 'Compound',
              vault: 'USDC Vault',
              chain: 'Base',
              apy: 6.1,
              riskLevel: 'Medium',
              whaleConfidence: 'Neutral',
              sentimentScore: 'Neutral',
            },
            reasoning: 'Shared fallback.',
            alternatives: [],
            warnings: [],
            rawAnalysis: 'Fallback.',
          }),
        },
      ],
    });

    await synthesizeResearch({
      userQuery: 'Find a balanced USDC vault',
      budget: 500,
      riskTolerance: 'medium',
      availableSellers: [],
    });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-shared-model' }),
    );
  });
});
