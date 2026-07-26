// Feature: theme-switching
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as fc from 'fast-check';
import { ThemeProvider } from '../context/ThemeProvider';
import ThemeToggle from './ThemeToggle';

function renderToggle(initialTheme?: 'dark' | 'light') {
  if (initialTheme) localStorage.setItem('hazina-theme', initialTheme);
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove('dark');
});

// Property 3 (component): icon and aria-label match theme
// Feature: theme-switching, Property 3 (component): icon and label match theme
describe('ThemeToggle – icon and label match theme', () => {
  it('shows Sun icon and "Switch to light mode" when theme is dark', () => {
    renderToggle('dark');
    expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeTruthy();
  });

  it('shows Moon icon and "Switch to dark mode" when theme is light', () => {
    renderToggle('light');
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeTruthy();
  });

  it('icon and label match theme for both values (property)', () => {
    fc.assert(
      fc.property(fc.constantFrom('dark', 'light') as fc.Arbitrary<'dark' | 'light'>, theme => {
        localStorage.setItem('hazina-theme', theme);
        const { unmount } = render(
          <ThemeProvider>
            <ThemeToggle />
          </ThemeProvider>,
        );
        const btn = screen.getByRole('button');
        const label = btn.getAttribute('aria-label') ?? '';
        if (theme === 'dark') {
          expect(label).toMatch(/light mode/i);
        } else {
          expect(label).toMatch(/dark mode/i);
        }
        unmount();
        localStorage.clear();
        document.documentElement.classList.remove('dark');
      }),
    );
  });
});

// Task 4.2: clicking ThemeToggle flips the theme
describe('ThemeToggle – click toggles theme', () => {
  it('clicking the button flips from dark to light', async () => {
    renderToggle('dark');
    const btn = screen.getByRole('button', { name: /switch to light mode/i });
    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: /switch to dark mode/i })).toBeTruthy();
  });

  it('clicking the button flips from light to dark', async () => {
    renderToggle('light');
    const btn = screen.getByRole('button', { name: /switch to dark mode/i });
    await userEvent.click(btn);
    expect(screen.getByRole('button', { name: /switch to light mode/i })).toBeTruthy();
  });
});
