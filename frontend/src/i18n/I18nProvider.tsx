import { useEffect, useState, type ReactNode } from 'react';
import { DEFAULT_LOCALE, LOCALE_LABELS, SUPPORTED_LOCALES, type SupportedLocale } from './catalog';
import { I18N_STORAGE_KEY, normalizeLocale, resolveInitialLocale } from './config';
import { formatCurrency, formatDate, formatNumber, translate } from './translate';
import { I18nContext, type I18nContextValue } from './I18nContext';
import { getLocaleDirection } from './locale';

export interface I18nProviderProps {
  children: ReactNode;
  initialLocale?: SupportedLocale;
  storageKey?: string;
}

export function I18nProvider({
  children,
  initialLocale,
  storageKey = I18N_STORAGE_KEY,
}: I18nProviderProps) {
  const [locale, setLocaleState] = useState<SupportedLocale>(() =>
    resolveInitialLocale(initialLocale, storageKey),
  );

  useEffect(() => {
    const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
    document.documentElement.lang = normalized;
    document.documentElement.dir = getLocaleDirection(normalized);
    window.localStorage.setItem(storageKey, normalized);
  }, [locale, storageKey]);

  const value: I18nContextValue = {
    locale,
    defaultLocale: DEFAULT_LOCALE,
    availableLocales: SUPPORTED_LOCALES,
    setLocale: setLocaleState,
    getLocaleLabel: nextLocale => LOCALE_LABELS[nextLocale] ?? nextLocale,
    t: (key, params) => translate(locale, key, params),
    number: (valueToFormat, options) => formatNumber(locale, valueToFormat, options),
    currency: (valueToFormat, currencyCode, options) =>
      formatCurrency(locale, valueToFormat, currencyCode, options),
    date: (valueToFormat, options) => formatDate(locale, valueToFormat, options),
  };

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
