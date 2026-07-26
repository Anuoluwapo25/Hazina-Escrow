import { createContext } from 'react';
import type { MessageKey, SupportedLocale } from './catalog';
import type { TranslationParams } from './types';

export interface I18nContextValue {
  locale: SupportedLocale;
  defaultLocale: SupportedLocale;
  availableLocales: readonly SupportedLocale[];
  setLocale: (locale: SupportedLocale) => void;
  getLocaleLabel: (locale: SupportedLocale) => string;
  t: (key: MessageKey, params?: TranslationParams) => string;
  number: (value: number, options?: Intl.NumberFormatOptions) => string;
  currency: (value: number, currency?: string, options?: Intl.NumberFormatOptions) => string;
  date: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
}

export const I18nContext = createContext<I18nContextValue | null>(null);
