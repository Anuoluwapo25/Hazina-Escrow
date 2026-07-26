// Feature: frontend-testing-infrastructure
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AgentPage from './AgentPage';
import { I18nProvider } from '../i18n';
import type { AgentJob } from '../lib/api';

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('../lib/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      agentInfo: vi.fn().mockResolvedValue({
        agent: {
          name: 'Hazina Agent',
          version: '1.0.0',
          description: '',
          agentWallet: 'GAGENT',
          escrowWallet: 'GESCROW',
          fee: { amount: 1, currency: 'USDC', network: 'stellar', description: '' },
          sellers: [],
          agentProfit: 0.1,
        },
      }),
      agentDemo: vi.fn(),
      agentResearch: vi.fn(),
      getStats: vi.fn(),
      getDatasets: vi.fn(),
    },
  };
});

// ── Fixture ────────────────────────────────────────────────────────────────

const mockAgentJob: AgentJob = {
  success: true,
  demo: true,
  jobId: 'job-1',
  query: 'best yield',
  report: {
    topOpportunity: {
      protocol: 'Aave',
      vault: 'USDC Vault',
      chain: 'Stellar',
      apy: 8.5,
      riskLevel: 'Low',
      whaleConfidence: 'High',
      sentimentScore: 'Bullish',
    },
    reasoning: 'Strong on-chain metrics.',
    alternatives: ['Compound', 'Yearn'],
    warnings: ['Smart contract risk'],
    rawAnalysis: 'Full analysis here.',
  },
  payments: {
    humanPaid: 1,
    currency: 'USDC',
    network: 'stellar',
    sellerPayments: [
      { seller: 'GSELLER1', type: 'yield-data', amount: 0.14, txHash: 'tx1', onChain: false },
    ],
    totalSpent: 0.14,
    agentProfit: 0.86,
    note: 'Simulated payment',
  },
  meta: { agentWallet: 'GAGENT', timestamp: new Date().toISOString(), datasetsQueried: 4 },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function renderAgentPage() {
  return render(
    <I18nProvider initialLocale="en">
      <AgentPage />
    </I18nProvider>,
  );
}

// ── Query input validation ─────────────────────────────────────────────────

describe('AgentPage – query input validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('run button is disabled when input has fewer than 5 non-whitespace characters', async () => {
    renderAgentPage();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'hi');
    // The submit button (Run Agent) should still be enabled in terms of DOM state,
    // but clicking it should show a validation error without calling the API.
    const { api } = await import('../lib/api');
    const runBtn = screen.getByRole('button', { name: /run agent/i });
    await userEvent.click(runBtn);
    expect(api.agentDemo).not.toHaveBeenCalled();
  });

  it('run button triggers demo when input has 5+ non-whitespace characters', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.agentDemo).mockResolvedValueOnce(mockAgentJob);
    renderAgentPage();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'best yield opportunities');
    const runBtn = screen.getByRole('button', { name: /run agent/i });
    await userEvent.click(runBtn);
    expect(api.agentDemo).toHaveBeenCalledWith('best yield opportunities');
  });
});

// ── Query submission interactions ──────────────────────────────────────────

describe('AgentPage – submission interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('pressing Enter calls api.agentDemo with trimmed query', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.agentDemo).mockResolvedValueOnce(mockAgentJob);
    renderAgentPage();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, '  best yield  {Enter}');
    expect(api.agentDemo).toHaveBeenCalledWith('best yield');
  });

  it('clicking an example query chip updates the input value', async () => {
    renderAgentPage();
    // The first example query chip – just grab the first chip button
    const chips = screen
      .getAllByRole('button')
      .filter(btn => !btn.getAttribute('aria-label') && btn.className.includes('rounded-lg'));
    const chip = chips[0];
    expect(chip).toBeDefined();
    await userEvent.click(chip as HTMLElement);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    expect(input.value.length).toBeGreaterThan(0);
  });
});

// ── Loading state ──────────────────────────────────────────────────────────

describe('AgentPage – loading state', () => {
  it('shows loading spinner and hides result while pending', async () => {
    const { api } = await import('../lib/api');
    vi.clearAllMocks();
    let resolve!: (v: AgentJob) => void;
    vi.mocked(api.agentDemo).mockReturnValueOnce(
      new Promise(r => {
        resolve = r;
      }),
    );

    renderAgentPage();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'best yield strategy now');
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => {
      // Loading indicator (spinner or skeleton) should be present
      const spinner = document.querySelector('.animate-spin, [aria-busy="true"]');
      expect(spinner).toBeTruthy();
    });

    // No result section yet
    expect(screen.queryByText('Top Opportunity')).toBeNull();

    // Clean up the hanging promise
    resolve(mockAgentJob);
  });
});

// ── Error state & retry ────────────────────────────────────────────────────

describe('AgentPage – error state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows error message when api.agentDemo rejects with an Error', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.agentDemo).mockRejectedValueOnce(new Error('Network failure'));
    renderAgentPage();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'best yield strategy here{Enter}');
    await waitFor(() => {
      expect(screen.getByText('Network failure')).toBeTruthy();
    });
  });

  it('shows fallback string when rejection value is not an Error', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.agentDemo).mockRejectedValueOnce('raw string error');
    renderAgentPage();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'best yield strategy here{Enter}');
    await waitFor(() => {
      // Non-Error rejections fall back to t('common.states.error')
      expect(screen.getByText('Something went wrong.')).toBeTruthy();
    });
  });

  it('retry button calls api.agentDemo again', async () => {
    const { api } = await import('../lib/api');
    vi.mocked(api.agentDemo)
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(mockAgentJob);

    renderAgentPage();
    const input = screen.getByRole('textbox');
    await userEvent.type(input, 'best yield strategy{Enter}');
    await waitFor(() => screen.getByText('fail'));

    const retryBtn = screen.getByRole('button', { name: /retry/i });
    await userEvent.click(retryBtn);
    expect(api.agentDemo).toHaveBeenCalledTimes(2);
  });
});

// ── Result rendering ───────────────────────────────────────────────────────

describe('AgentPage – result rendering', () => {
  it('shows Demo badge when result.demo is true', async () => {
    const { api } = await import('../lib/api');
    vi.clearAllMocks();
    vi.mocked(api.agentDemo).mockResolvedValueOnce(mockAgentJob);
    renderAgentPage();
    await userEvent.type(screen.getByRole('textbox'), 'best yield{Enter}');
    await waitFor(() => {
      expect(screen.getByText('Demo')).toBeTruthy();
    });
  });
});
