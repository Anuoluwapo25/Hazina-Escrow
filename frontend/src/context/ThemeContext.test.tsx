// Feature: theme-switching
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as fc from 'fast-check';
import { ThemeProvider } from './ThemeProvider';
import { useTheme } from './useTheme';

// ── Helpers ───────────────────────────────────────────────────────────────────

function TestConsumer() {
  const { theme, toggleTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button onClick={toggleTheme}>toggle</button>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
  vi.restoreAllMocks();
});

// ── Property 1: toggle is an involution ──────────────────────────────────────
// Feature: theme-switching, Property 1: toggle involution
describe('ThemeContext – toggle involution', () => {
  it('toggling twice returns to the original theme', () => {
    fc.assert(
      fc.property(fc.constantFrom('dark', 'light') as fc.Arbitrary<'dark' | 'light'>, initial => {
        localStorage.setItem('hazina-theme', initial);
        const { unmount } = render(
          <ThemeProvider>
            <TestConsumer />
          </ThemeProvider>,
        );
        const before = screen.getByTestId('theme').textContent;
        act(() => screen.getByRole('button').click());
        act(() => screen.getByRole('button').click());
        const after = screen.getByTestId('theme').textContent;
        expect(after).toBe(before);
        unmount();
        localStorage.clear();
        document.documentElement.classList.remove('dark');
      }),
    );
  });
});

// ── Property 2: localStorage persistence on toggle ───────────────────────────
// Feature: theme-switching, Property 2: localStorage persistence
describe('ThemeContext – localStorage persistence', () => {
  it('after toggling, localStorage equals the new theme', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('dark', 'light') as fc.Arbitrary<'dark' | 'light'>,
        async initial => {
          localStorage.setItem('hazina-theme', initial);
          const { unmount } = render(
            <ThemeProvider>
              <TestConsumer />
            </ThemeProvider>,
          );
          await userEvent.click(screen.getByRole('button', { name: 'toggle' }));
          const stored = localStorage.getItem('hazina-theme');
          const current = screen.getByTestId('theme').textContent;
          expect(stored).toBe(current);
          unmount();
          localStorage.clear();
          document.documentElement.classList.remove('dark');
        },
      ),
    );
  });
});

// ── Property 3: DOM class reflects theme state ───────────────────────────────
// Feature: theme-switching, Property 3: DOM class reflects theme
describe('ThemeContext – DOM class reflects theme', () => {
  it('document.documentElement has "dark" class iff theme === "dark"', () => {
    fc.assert(
      fc.property(fc.constantFrom('dark', 'light') as fc.Arbitrary<'dark' | 'light'>, initial => {
        localStorage.setItem('hazina-theme', initial);
        const { unmount } = render(
          <ThemeProvider>
            <TestConsumer />
          </ThemeProvider>,
        );
        const theme = screen.getByTestId('theme').textContent;
        const hasDark = document.documentElement.classList.contains('dark');
        expect(hasDark).toBe(theme === 'dark');
        unmount();
        localStorage.clear();
        document.documentElement.classList.remove('dark');
      }),
    );
  });
});

// ── Property 4: stored valid value takes precedence over OS preference ────────
// Feature: theme-switching, Property 4: stored value precedence
describe('ThemeContext – stored value takes precedence', () => {
  it('initializes to stored value regardless of matchMedia', () => {
    fc.assert(
      fc.property(fc.constantFrom('dark', 'light') as fc.Arbitrary<'dark' | 'light'>, stored => {
        const opposite = stored === 'dark' ? 'light' : 'dark';
        vi.spyOn(window, 'matchMedia').mockReturnValue({
          matches: opposite === 'dark',
          media: '',
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        } as MediaQueryList);

        localStorage.setItem('hazina-theme', stored);
        const { unmount } = render(
          <ThemeProvider>
            <TestConsumer />
          </ThemeProvider>,
        );
        expect(screen.getByTestId('theme').textContent).toBe(stored);
        unmount();
        localStorage.clear();
        document.documentElement.classList.remove('dark');
        vi.restoreAllMocks();
      }),
    );
  });
});

// ── Property 5: invalid stored value falls back to OS preference ─────────────
// Feature: theme-switching, Property 5: invalid value fallback
describe('ThemeContext – invalid stored value fallback', () => {
  it('falls back to OS preference for non-dark/light stored values', () => {
    fc.assert(
      fc.property(
        fc.string().filter(s => s !== 'dark' && s !== 'light'),
        fc.boolean(),
        (invalidStored, prefersDark) => {
          vi.spyOn(window, 'matchMedia').mockReturnValue({
            matches: prefersDark,
            media: '',
            onchange: null,
            addListener: vi.fn(),
            removeListener: vi.fn(),
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
            dispatchEvent: vi.fn(),
          } as MediaQueryList);

          if (invalidStored) localStorage.setItem('hazina-theme', invalidStored);
          const { unmount } = render(
            <ThemeProvider>
              <TestConsumer />
            </ThemeProvider>,
          );
          const expected = prefersDark ? 'dark' : 'light';
          expect(screen.getByTestId('theme').textContent).toBe(expected);
          unmount();
          localStorage.clear();
          document.documentElement.classList.remove('dark');
          vi.restoreAllMocks();
        },
      ),
    );
  });
});

// ── Property 6: useTheme outside provider throws ─────────────────────────────
// Feature: theme-switching, Property 6: useTheme outside provider
describe('ThemeContext – useTheme outside provider', () => {
  it('throws when used without ThemeProvider', () => {
    function Bare() {
      useTheme();
      return null;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Bare />)).toThrow();
    spy.mockRestore();
  });
});
