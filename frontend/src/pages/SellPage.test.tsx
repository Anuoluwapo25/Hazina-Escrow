import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SellPage from './SellPage';
import { I18nProvider } from '../i18n';
import { api } from '../lib/api';
import { ToastProvider } from '../components/ui/ToastProvider';

vi.mock('../lib/api', () => ({
  api: {
    createDataset: vi.fn(),
  },
}));

const validWallet = `G${'A'.repeat(55)}`;
const walletError =
  'Enter a valid Stellar public key (starts with G, uses A-Z or 2-7, and is exactly 56 characters)';

function renderSellPage() {
  return render(
    <ToastProvider>
      <I18nProvider initialLocale="en">
        <MemoryRouter>
          <SellPage />
        </MemoryRouter>
      </I18nProvider>
    </ToastProvider>,
  );
}

function getFileInput(container: HTMLElement) {
  const fileInput = container.querySelector('input[type="file"]');
  expect(fileInput).toBeTruthy();
  return fileInput as HTMLInputElement;
}

function fillRequiredFields() {
  fireEvent.change(
    screen.getByPlaceholderText('e.g. Top 100 Whale Wallet Movements — April 2026'),
    {
      target: { value: 'Test Dataset' },
    },
  );
  fireEvent.change(
    screen.getByPlaceholderText(
      'Describe what your data contains, how it was collected, and why buyers would want it...',
    ),
    {
      target: { value: 'A useful dataset description' },
    },
  );
  fireEvent.change(screen.getByPlaceholderText('G... (56-character Stellar public key)'), {
    target: { value: validWallet },
  });
  // Blur wallet input to trigger validation
  fireEvent.blur(screen.getByPlaceholderText('G... (56-character Stellar public key)'));
  // Set dataset type (first combobox; the second is the payment token select)
  const [typeSelect] = screen.getAllByRole('combobox');
  if (!typeSelect) throw new Error('Expected dataset type combobox to exist');
  fireEvent.change(typeSelect, {
    target: { value: 'whale-wallets' },
  });
  // Set a valid price by directly changing the input
  const priceInput = screen.getByRole('spinbutton');
  fireEvent.change(priceInput, { target: { value: '0.05' } });
  fireEvent.blur(priceInput);
}

describe('SellPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['short addresses', 'G123'],
    ['56-character addresses with the wrong prefix', `E${'A'.repeat(55)}`],
    ['addresses longer than 56 characters', `${validWallet}A`],
    ['addresses with invalid characters', `G${'a'.repeat(55)}`],
  ])('shows wallet validation error for %s', (_label, wallet) => {
    renderSellPage();
    const walletInput = screen.getByPlaceholderText('G... (56-character Stellar public key)');
    fireEvent.change(walletInput, {
      target: { value: wallet },
    });
    // Blur the input to trigger validation
    fireEvent.blur(walletInput);

    expect(screen.getByText(walletError)).toBeTruthy();
    const submitButton = screen.getByRole('button', { name: 'Publish to Marketplace' });
    expect(submitButton).toHaveProperty('disabled', true);
  });

  it.each([
    ['zero', '0'],
    ['negative number', '-5'],
  ])('shows price validation error for %s', (_label, price) => {
    renderSellPage();
    const priceInput = screen.getByRole('spinbutton');
    fireEvent.change(priceInput, { target: { value: price } });
    fireEvent.blur(priceInput);

    expect(screen.getByText('Price must be greater than 0')).toBeTruthy();
    const submitButton = screen.getByRole('button', { name: 'Publish to Marketplace' });
    expect(submitButton).toHaveProperty('disabled', true);
  });

  it('only advertises JSON uploads', () => {
    const { container } = renderSellPage();

    expect(screen.getByText('Upload JSON file')).toBeTruthy();
    expect(screen.getByText('JSON only, max 10MB')).toBeTruthy();
    expect(getFileInput(container).accept).toBe('.json,application/json');
  });

  it('shows JSON validation error for malformed dataset payload', () => {
    renderSellPage();
    fillRequiredFields();
    fireEvent.change(screen.getByPlaceholderText(/Paste your JSON data here/i), {
      target: { value: '{invalid-json' },
    });

    expect(screen.getByText('Invalid JSON — please check your data format')).toBeTruthy();
    const submitButton = screen.getByRole('button', { name: 'Publish to Marketplace' });
    expect(submitButton).toHaveProperty('disabled', true);
  });

  it.skip('submits, shows loading state, then success state', async () => {
    type CreatedDataset = Awaited<ReturnType<typeof api.createDataset>>;
    let resolveRequest: ((value: CreatedDataset) => void) | undefined;
    vi.mocked(api.createDataset).mockReturnValueOnce(
      new Promise<CreatedDataset>(resolve => {
        resolveRequest = resolve;
      }),
    );

    renderSellPage();
    fillRequiredFields();
    fireEvent.change(screen.getByPlaceholderText(/Paste your JSON data here/i), {
      target: { value: '{"rows":[1,2,3]}' },
    });
    // Blur textarea to trigger JSON validation
    fireEvent.blur(screen.getByPlaceholderText(/Paste your JSON data here/i));

    fireEvent.click(screen.getByRole('button', { name: 'Publish to Marketplace' }));

    await waitFor(() => {
      expect(api.createDataset).toHaveBeenCalledWith({
        name: 'Test Dataset',
        description: 'A useful dataset description',
        type: 'whale-wallets',
        pricePerQuery: 0.05,
        sellerWallet: validWallet,
        data: { rows: [1, 2, 3] },
      });
    });

    resolveRequest?.({
      id: 'ds-1',
      name: 'Test Dataset',
      description: 'A useful dataset description',
      type: 'whale-wallets',
      pricePerQuery: 0.05,
      sellerWallet: validWallet,
      queriesServed: 0,
      totalEarned: 0,
      createdAt: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(screen.getByText('Listing Live!')).toBeTruthy();
    });
  });

  it.skip('shows API error when submission fails', async () => {
    vi.mocked(api.createDataset).mockRejectedValueOnce(new Error('Create failed'));

    renderSellPage();
    fillRequiredFields();
    fireEvent.change(screen.getByPlaceholderText(/Paste your JSON data here/i), {
      target: { value: '{"rows":[1]}' },
    });
    // Blur textarea to trigger JSON validation
    fireEvent.blur(screen.getByPlaceholderText(/Paste your JSON data here/i));

    fireEvent.click(screen.getByRole('button', { name: 'Publish to Marketplace' }));

    await waitFor(() => {
      expect(screen.getByText('Create failed')).toBeTruthy();
    });
  });

  describe('Draft auto-save and restoration', () => {
    beforeEach(() => {
      localStorage.clear();
    });

    afterEach(() => {
      localStorage.clear();
    });

    it('persists form data to localStorage when fields change', async () => {
      renderSellPage();

      fireEvent.change(
        screen.getByPlaceholderText('e.g. Top 100 Whale Wallet Movements — April 2026'),
        {
          target: { value: 'My Test Dataset' },
        },
      );

      await waitFor(() => {
        const stored = localStorage.getItem('hazina_sell_form_draft');
        expect(stored).toBeTruthy();
        const data = JSON.parse(stored || '{}');
        expect(data.data.name).toBe('My Test Dataset');
        expect(data.timestamp).toBeDefined();
      });
    });

    it('does not persist wallet address for security', async () => {
      renderSellPage();

      fireEvent.change(
        screen.getByPlaceholderText('e.g. Top 100 Whale Wallet Movements — April 2026'),
        {
          target: { value: 'Dataset Name' },
        },
      );

      fireEvent.change(screen.getByPlaceholderText('G... (56-character Stellar public key)'), {
        target: { value: validWallet },
      });

      await waitFor(() => {
        const stored = localStorage.getItem('hazina_sell_form_draft');
        const data = JSON.parse(stored || '{}');
        expect(data.data.sellerWallet).toBeUndefined();
      });
    });

    it('restores saved draft on page reload', () => {
      const draftData = {
        data: {
          name: 'Saved Dataset',
          description: 'Saved description',
          type: 'whale-wallets',
          pricePerQuery: '0.10',
          dataText: '{"test": true}',
        },
        timestamp: Date.now(),
      };

      localStorage.setItem('hazina_sell_form_draft', JSON.stringify(draftData));

      renderSellPage();

      expect(screen.getByDisplayValue('Saved Dataset')).toBeTruthy();
      expect(screen.getByDisplayValue('Saved description')).toBeTruthy();
      expect(screen.getByDisplayValue('0.10')).toBeTruthy();
    });

    it('shows draft restored toast notification when draft is loaded', async () => {
      const draftData = {
        data: {
          name: 'Saved Dataset',
          description: 'Saved description',
          type: 'whale-wallets',
          pricePerQuery: '0.05',
          dataText: '',
        },
        timestamp: Date.now(),
      };

      localStorage.setItem('hazina_sell_form_draft', JSON.stringify(draftData));

      renderSellPage();

      await waitFor(() => {
        expect(screen.getByText('Draft restored from your last session')).toBeTruthy();
      });
    });

    it('does not show toast when no draft exists', () => {
      localStorage.clear();

      renderSellPage();

      expect(screen.queryByText('Draft restored from your last session')).toBeNull();
    });

    it('discards draft older than 24 hours', () => {
      const oldDraftData = {
        data: {
          name: 'Old Dataset',
          description: 'Old description',
          type: 'whale-wallets',
          pricePerQuery: '0.05',
          dataText: '',
        },
        timestamp: Date.now() - 25 * 60 * 60 * 1000, // 25 hours old
      };

      localStorage.setItem('hazina_sell_form_draft', JSON.stringify(oldDraftData));

      renderSellPage();

      // Should show empty form, not the old data
      const nameInput = screen.getByPlaceholderText(
        'e.g. Top 100 Whale Wallet Movements — April 2026',
      ) as HTMLInputElement;
      expect(nameInput.value).toBe('');

      // Storage should be cleared
      expect(localStorage.getItem('hazina_sell_form_draft')).toBeNull();
    });

    it('clears draft after successful submission', async () => {
      type CreatedDataset = Awaited<ReturnType<typeof api.createDataset>>;
      let resolveRequest: ((value: CreatedDataset) => void) | undefined;
      vi.mocked(api.createDataset).mockReturnValueOnce(
        new Promise<CreatedDataset>(resolve => {
          resolveRequest = resolve;
        }),
      );

      renderSellPage();
      fillRequiredFields();
      fireEvent.change(screen.getByPlaceholderText(/Paste your JSON data here/i), {
        target: { value: '{"rows":[1,2,3]}' },
      });

      // Verify draft is saved
      await waitFor(() => {
        const stored = localStorage.getItem('hazina_sell_form_draft');
        expect(stored).toBeTruthy();
      });

      fireEvent.click(screen.getByRole('button', { name: 'Publish to Marketplace' }));
      fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

      resolveRequest?.({
        id: 'ds-1',
        name: 'Test Dataset',
        description: 'A useful dataset description',
        type: 'whale-wallets',
        pricePerQuery: 0.05,
        sellerWallet: validWallet,
        queriesServed: 0,
        totalEarned: 0,
        createdAt: new Date().toISOString(),
      });

      await waitFor(() => {
        expect(screen.getByText('Listing Live!')).toBeTruthy();
        // Draft should be cleared after successful submission
        expect(localStorage.getItem('hazina_sell_form_draft')).toBeNull();
      });
    });

    it('restores wallet as empty string for security (never restore sensitive data)', () => {
      const draftWithWallet = {
        data: {
          name: 'Dataset',
          description: 'Description',
          type: 'whale-wallets',
          pricePerQuery: '0.05',
          dataText: '',
        },
        timestamp: Date.now(),
      };

      localStorage.setItem('hazina_sell_form_draft', JSON.stringify(draftWithWallet));

      renderSellPage();

      const walletInput = screen.getByPlaceholderText(
        'G... (56-character Stellar public key)',
      ) as HTMLInputElement;
      expect(walletInput.value).toBe('');
    });
  });
});
