// Feature: frontend-testing-infrastructure
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { localizeScale } from './agentUtils';

const KNOWN_VALUES = ['low', 'medium', 'high', 'neutral', 'bullish', 'bearish'];
const SUPPORTED_LOCALES = ['en', 'es', 'fr', 'sw'];

// Stub t() per locale — maps the i18n keys to non-empty locale-specific strings
function makeT(locale: string): (key: string) => string {
  const map: Record<string, Record<string, string>> = {
    en: {
      'agent.scales.low': 'Low',
      'agent.scales.medium': 'Medium',
      'agent.scales.high': 'High',
      'agent.scales.neutral': 'Neutral',
      'agent.scales.bullish': 'Bullish',
      'agent.scales.bearish': 'Bearish',
    },
    es: {
      'agent.scales.low': 'Bajo',
      'agent.scales.medium': 'Medio',
      'agent.scales.high': 'Alto',
      'agent.scales.neutral': 'Neutral',
      'agent.scales.bullish': 'Alcista',
      'agent.scales.bearish': 'Bajista',
    },
    fr: {
      'agent.scales.low': 'Faible',
      'agent.scales.medium': 'Moyen',
      'agent.scales.high': 'Élevé',
      'agent.scales.neutral': 'Neutre',
      'agent.scales.bullish': 'Haussier',
      'agent.scales.bearish': 'Baissier',
    },
    sw: {
      'agent.scales.low': 'Chini',
      'agent.scales.medium': 'Kati',
      'agent.scales.high': 'Juu',
      'agent.scales.neutral': 'Wastani',
      'agent.scales.bullish': 'Kupanda',
      'agent.scales.bearish': 'Kushuka',
    },
  };
  return (key: string) => map[locale]?.[key] ?? key;
}

describe('localizeScale', () => {
  // Property 3: non-empty output for all known values × all supported locales
  it('returns non-empty string for all known values across all locales', () => {
    for (const locale of SUPPORTED_LOCALES) {
      const t = makeT(locale);
      for (const value of KNOWN_VALUES) {
        const result = localizeScale(value, t);
        expect(result.length).toBeGreaterThan(0);
      }
    }
  });

  // Property 4: passthrough for unrecognised values
  it('returns the input unchanged for unrecognised values', () => {
    const t = makeT('en');
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).filter(s => !KNOWN_VALUES.includes(s.toLowerCase())),
        value => {
          expect(localizeScale(value, t)).toBe(value);
        },
      ),
    );
  });

  // Property 5: case-insensitive matching for known values
  it('is case-insensitive for known values', () => {
    const t = makeT('en');
    fc.assert(
      fc.property(
        fc.constantFrom(...KNOWN_VALUES),
        fc.constantFrom(
          (s: string) => s,
          (s: string) => s.toUpperCase(),
          (s: string) => s.charAt(0).toUpperCase() + s.slice(1),
        ),
        (value, transform) => {
          const v1 = localizeScale(value, t);
          const v2 = localizeScale(transform(value), t);
          expect(v1).toBe(v2);
        },
      ),
    );
  });
});
