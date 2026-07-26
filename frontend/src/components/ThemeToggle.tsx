import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../context/useTheme';

/**
 * ThemeToggle – a button that switches between light and dark themes.
 * Delegates all state management to ThemeContext (via useTheme).
 * Fully accessible:
 *  - aria-label updates to reflect the action ("Switch to light/dark mode").
 *  - Keyboard users can focus and activate it with Space/Enter.
 *  - Icons are aria-hidden.
 */
export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="flex items-center justify-center p-2 rounded-full hover:bg-gold/10 focus:outline-none focus:ring-2 focus:ring-gold-light"
    >
      {theme === 'dark' ? (
        <Sun className="w-5 h-5" aria-hidden="true" />
      ) : (
        <Moon className="w-5 h-5" aria-hidden="true" />
      )}
    </button>
  );
}
