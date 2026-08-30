import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ActivePassBadge from './ActivePassBadge';
import { I18nProvider } from '../../i18n';

function renderBadge(status: Parameters<typeof ActivePassBadge>[0]['status'], expiry?: number) {
  return render(
    <I18nProvider initialLocale="en">
      <ActivePassBadge status={status} expiry={expiry} />
    </I18nProvider>,
  );
}

describe('ActivePassBadge', () => {
  const HOUR = 60 * 60;

  it('renders the emerald active badge with a future expiry', () => {
    renderBadge('active', Math.floor(Date.now() / 1000) + 3 * 24 * HOUR);
    const badge = screen.getByTestId('active-pass-badge');
    expect(badge.textContent).toContain('Active');
    // Relative time formatting must point forward ("in …"), not backward.
    expect(badge.textContent).toMatch(/in \d+ days?/);
  });

  it('renders an expired badge when the term has ended', () => {
    renderBadge('expired');
    expect(screen.getByTestId('active-pass-badge').textContent).toContain('Expired');
  });

  it('renders a neutral fail-closed badge on verification failure — never "no access"', () => {
    renderBadge('unavailable');
    const badge = screen.getByTestId('active-pass-badge');
    expect(badge.textContent).toContain('Access status unavailable');
    expect(badge.textContent).not.toContain('Expired');
    expect(badge.textContent).not.toContain('Active');
  });

  it.each(['loading', 'none', 'no-wallet'] as const)('renders nothing for %s', status => {
    const { container } = renderBadge(status);
    expect(container.childElementCount).toBe(0);
  });
});
