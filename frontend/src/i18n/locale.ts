export const RTL_LOCALES = ['ar', 'he', 'fa', 'ur'] as const;

export function getLocaleDirection(locale: string): 'ltr' | 'rtl' {
  const language = locale.toLowerCase().split('-')[0];
  return RTL_LOCALES.includes(language as (typeof RTL_LOCALES)[number]) ? 'rtl' : 'ltr';
}
