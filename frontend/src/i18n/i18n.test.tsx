import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { I18nProvider } from './I18nProvider';
import { getLocaleDirection } from './locale';
import LocaleSwitcher from './LocaleSwitcher';
import { I18N_STORAGE_KEY, detectBrowserLocale, normalizeLocale } from './config';
import { translate } from './translate';
import { useI18n } from './useI18n';

function I18nHarness() {
  const { currency, locale, setLocale, t } = useI18n();

  return (
    <div>
      <p data-testid="locale">{locale}</p>
      <p data-testid="title">{t('nav.marketplace')}</p>
      <p data-testid="step">{t('onboarding.stepCounter', { current: 2, total: 5 })}</p>
      <p data-testid="money">{currency(12.5, 'USD')}</p>
      <button type="button" onClick={() => setLocale('sw')}>
        switch
      </button>
      <LocaleSwitcher />
    </div>
  );
}

describe('i18n support', () => {
  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.lang = '';
    document.documentElement.dir = '';
  });

  it('normalizes locale codes', () => {
    expect(normalizeLocale('sw-KE')).toBe('sw');
    expect(normalizeLocale('en-US')).toBe('en');
    expect(normalizeLocale('fr-FR')).toBe('fr');
    expect(normalizeLocale('es-MX')).toBe('es');
  });

  it('detects the browser locale when supported', () => {
    Object.defineProperty(window.navigator, 'languages', {
      configurable: true,
      value: ['sw-KE', 'en-US'],
    });

    expect(detectBrowserLocale()).toBe('sw');
  });

  it('translates and interpolates values', () => {
    expect(translate('sw', 'nav.marketplace')).toBe('Soko');
    expect(translate('fr', 'nav.marketplace')).toBe('Marketplace');
    expect(translate('es', 'nav.marketplace')).toBe('Marketplace');
    expect(translate('en', 'onboarding.stepCounter', { current: 1, total: 3 })).toBe('Step 1 of 3');
  });

  it('resolves text direction for current and future locales', () => {
    expect(getLocaleDirection('en')).toBe('ltr');
    expect(getLocaleDirection('sw-KE')).toBe('ltr');
    expect(getLocaleDirection('ar')).toBe('rtl');
    expect(getLocaleDirection('he-IL')).toBe('rtl');
  });

  it('persists locale changes through the provider', () => {
    render(
      <I18nProvider initialLocale="en">
        <I18nHarness />
      </I18nProvider>,
    );

    expect(screen.getByTestId('title').textContent).toBe('Marketplace');
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe('en');

    fireEvent.click(screen.getByRole('button', { name: 'switch' }));

    expect(screen.getByTestId('locale').textContent).toBe('sw');
    expect(screen.getByTestId('title').textContent).toBe('Soko');
    expect(window.localStorage.getItem(I18N_STORAGE_KEY)).toBe('sw');
    expect(document.documentElement.lang).toBe('sw');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('allows switching locale through the shared switcher component', () => {
    render(
      <I18nProvider initialLocale="en">
        <I18nHarness />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByRole('combobox'), {
      target: { value: 'sw' },
    });

    expect(screen.getByTestId('title').textContent).toBe('Soko');
  });
});
