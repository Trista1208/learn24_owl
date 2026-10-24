// Light or dark: follows the system by default, the switch can pin either one. Stored per browser.
import { useState, type ReactNode } from 'react';
import { useI18n } from './i18n.tsx';
import { FoldMenu } from './fold.tsx';

export type Theme = 'auto' | 'light' | 'dark';

const KEY = 'lernagent.theme';

function stored(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

function apply(theme: Theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Called once before the first render, so the page does not flash in the wrong theme. */
export const applyStoredTheme = () => apply(stored());

const ICON: Record<Theme, ReactNode> = {
  auto: (
    <>
      <circle cx="10" cy="10" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M10 3.5 A6.5 6.5 0 0 1 10 16.5 Z" fill="currentColor" />
    </>
  ),
  light: (
    <>
      <circle cx="10" cy="10" r="3.6" fill="currentColor" />
      <path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </>
  ),
  dark: <path d="M15.5 12.6A6.6 6.6 0 0 1 7.4 4.5a6.6 6.6 0 1 0 8.1 8.1Z" fill="currentColor" />,
};

const OPTIONS: { value: Theme; label: string }[] = [
  { value: 'auto', label: 'Automatic (follows the system)' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export function ThemeSwitch() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<Theme>(stored);
  const choose = (next: Theme) => {
    try {
      if (next === 'auto') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable: the choice lives only in memory */
    }
    apply(next);
    setTheme(next);
  };
  const options = OPTIONS.map((o) => ({
    value: o.value,
    label: t(o.label),
    icon: <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">{ICON[o.value]}</svg>,
  }));
  return <FoldMenu className="theme-switch" label={t('Appearance')} value={theme} options={options} onChoose={choose} />;
}
