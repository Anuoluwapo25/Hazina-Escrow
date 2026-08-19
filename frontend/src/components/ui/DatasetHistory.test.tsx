import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import DatasetHistory from './DatasetHistory';
import { api } from '../../lib/api';

vi.mock('../../lib/api', () => ({
  api: { getDatasetHistory: vi.fn() },
}));

const DATASET_ID = 'ds-history';

function snapshot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'snap-1',
    datasetId: DATASET_ID,
    contentHash: 'a'.repeat(64),
    validFrom: '2026-08-03T00:00:00.000Z',
    validTo: null,
    byteSize: 2048,
    rawByteSize: 8192,
    observations: 4,
    lastObservedAt: '2026-08-03T00:15:00.000Z',
    providerRunId: null,
    createdAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  };
}

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <DatasetHistory datasetId={DATASET_ID} />
    </QueryClientProvider>,
  );
}

describe('DatasetHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('summarises how many versions exist and how often they changed', async () => {
    vi.mocked(api.getDatasetHistory).mockResolvedValue({
      datasetId: DATASET_ID,
      total: 2,
      limit: 50,
      offset: 0,
      snapshots: [
        snapshot({
          id: 'snap-0',
          validTo: '2026-08-03T00:00:00.000Z',
          contentHash: 'b'.repeat(64),
        }),
        snapshot(),
      ],
      changeFrequency: [
        { date: '2026-08-02', changes: 1 },
        { date: '2026-08-03', changes: 1 },
      ],
    });

    renderHistory();

    expect(await screen.findByText(/2 versions/)).toBeTruthy();
    expect(screen.getByText(/2 changes in 30 days/)).toBeTruthy();
  });

  it('lists the newest version first and marks the live one as current', async () => {
    vi.mocked(api.getDatasetHistory).mockResolvedValue({
      datasetId: DATASET_ID,
      total: 2,
      limit: 50,
      offset: 0,
      snapshots: [
        snapshot({
          id: 'snap-0',
          validTo: '2026-08-03T00:00:00.000Z',
          contentHash: 'b'.repeat(64),
        }),
        snapshot(),
      ],
      changeFrequency: [],
    });

    renderHistory();

    const items = await screen.findAllByRole('listitem');
    expect(items[0]?.textContent).toContain('aaaaaaaaaaaa…');
    expect(items[0]?.textContent).toContain('current');
    expect(items[1]?.textContent).toContain('2.0 KB');
  });

  it('renders nothing when the dataset has no history yet', async () => {
    vi.mocked(api.getDatasetHistory).mockResolvedValue({
      datasetId: DATASET_ID,
      total: 0,
      limit: 50,
      offset: 0,
      snapshots: [],
      changeFrequency: [],
    });

    const { container } = renderHistory();
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });

  it('renders nothing when history cannot be loaded', async () => {
    vi.mocked(api.getDatasetHistory).mockRejectedValue(new Error('offline'));

    const { container } = renderHistory();
    await waitFor(() => expect(container.querySelector('section')).toBeNull());
  });
});
