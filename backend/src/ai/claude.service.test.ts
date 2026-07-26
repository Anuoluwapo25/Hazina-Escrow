import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreate = vi.fn();

vi.mock('@anthropic-ai/sdk', () => {
  class APITimeoutError extends Error {
    constructor() {
      super('Request timed out');
      this.name = 'APITimeoutError';
    }
  }

  const MockAnthropic = vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }) as unknown as { new (): object; APITimeoutError: typeof APITimeoutError };
  MockAnthropic.APITimeoutError = APITimeoutError;

  return { default: MockAnthropic };
});

import {
  generateDataSummary,
  parseClaudeSummaryResponse,
  stripMarkdownFence,
} from './claude.service';

describe('stripMarkdownFence', () => {
  it('removes fenced markdown wrappers', () => {
    const raw = '```markdown\nExecutive summary text\n```';
    expect(stripMarkdownFence(raw)).toBe('Executive summary text');
  });
});

describe('parseClaudeSummaryResponse', () => {
  it('extracts summary and answer sections when buyer question exists', () => {
    const responseText =
      'Data shows steady growth across wallets.\n\nAnswer: Wallet A outperformed by 18%.';
    const parsed = parseClaudeSummaryResponse(responseText, true);

    expect(parsed.summary).toBe('Data shows steady growth across wallets.');
    expect(parsed.answer).toBe('Wallet A outperformed by 18%.');
  });

  it('returns cleaned summary only when no buyer question exists', () => {
    const responseText = '```text\nThree sentence executive summary.\n```';
    const parsed = parseClaudeSummaryResponse(responseText, false);

    expect(parsed).toEqual({ summary: 'Three sentence executive summary.' });
  });
});

describe('generateDataSummary', () => {
  const originalAnthropicModel = process.env.ANTHROPIC_MODEL;

  beforeEach(() => {
    mockCreate.mockReset();
    delete process.env.ANTHROPIC_MODEL;
  });

  afterEach(() => {
    if (originalAnthropicModel === undefined) {
      delete process.env.ANTHROPIC_MODEL;
      return;
    }

    process.env.ANTHROPIC_MODEL = originalAnthropicModel;
  });

  it('parses fenced output returned by Claude', async () => {
    mockCreate.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: '```markdown\nSummary line one.\n\nAnswer: A concise answer.\n```',
        },
      ],
    });

    const result = await generateDataSummary({ rows: [1, 2, 3] }, 'What changed?');
    expect(result.summary).toBe('Summary line one.');
    expect(result.answer).toBe('A concise answer.');
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-3-5-haiku-20241022' }),
    );
  });

  it('uses ANTHROPIC_MODEL when configured', async () => {
    process.env.ANTHROPIC_MODEL = 'claude-custom-summary-model';
    mockCreate.mockResolvedValue({
      content: [{ type: 'text', text: 'Summary only.' }],
    });

    await generateDataSummary({ rows: [1] });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'claude-custom-summary-model' }),
    );
  });
});

// ── Timeout tests ──────────────────────────────────────────────────────────
describe('generateDataSummary timeout handling', () => {
  const originalTimeout = process.env.ANTHROPIC_TIMEOUT_MS;

  beforeEach(() => {
    mockCreate.mockReset();
    delete process.env.ANTHROPIC_TIMEOUT_MS;
  });

  afterEach(() => {
    if (originalTimeout === undefined) delete process.env.ANTHROPIC_TIMEOUT_MS;
    else process.env.ANTHROPIC_TIMEOUT_MS = originalTimeout;
  });

  it('throws AnthropicTimeoutError when SDK raises APITimeoutError', async () => {
    // Simulate the Anthropic SDK throwing a timeout error
    const timeoutErr = new Error('Request timed out');
    timeoutErr.name = 'APITimeoutError';
    mockCreate.mockRejectedValue(timeoutErr);

    const { AnthropicTimeoutError } = await import('./claude.service');

    await expect(generateDataSummary({ rows: [1, 2, 3] })).rejects.toBeInstanceOf(
      AnthropicTimeoutError,
    );
  });

  it('AnthropicTimeoutError message is user-friendly', async () => {
    // Simulate the Anthropic SDK throwing a timeout error
    const timeoutErr = new Error('Request timed out');
    timeoutErr.name = 'APITimeoutError';
    mockCreate.mockRejectedValue(timeoutErr);

    const { AnthropicTimeoutError } = await import('./claude.service');

    const err = await generateDataSummary({ rows: [] }).catch(e => e);
    expect(err).toBeInstanceOf(AnthropicTimeoutError);
    expect(err.message).not.toContain('AbortError');
    expect(err.message).toMatch(/AI assistant did not respond/i);
  });
});
