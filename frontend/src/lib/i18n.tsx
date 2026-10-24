// The app speaks English only. t() fills {placeholders}; the labels for levels, modes, types and sources come from
// @l45/shared, and topic, area and lesson names come from the data as they are.
import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import type { DccLevel, LessonType, Mode, Source } from '@l45/shared';
import { DCC_LEVEL_LABEL, MODE_LABEL, SOURCE_LABEL, TYPE_LABEL } from '@l45/shared';

export type Lang = 'en';

/** Locale for dates and times. */
export const localeOf = (_lang: Lang = 'en') => 'en-GB';

function fill(s: string, vars?: Record<string, string | number>) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ''));
}

type I18n = {
  lang: Lang;
  t: (text: string, vars?: Record<string, string | number>) => string;
  level: (lv: DccLevel | null | undefined) => string;
  mode: (m: Mode) => string;
  type: (kind: LessonType) => string;
  source: (s: Source) => string;
  skillName: (id: string | undefined, fallback: string) => string;
  trackName: (id: string | undefined, fallback: string) => string;
  lessonTitle: (id: string | undefined, fallback: string) => string;
  nodeLabel: (node: { kind: string; label: string; lessonId?: string; trackId?: string; skillId?: string }) => string;
};

const Ctx = createContext<I18n | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    document.documentElement.lang = 'en';
    document.title = 'AIthena';
  }, []);

  const value = useMemo<I18n>(() => {
    const named = (_id: string | undefined, fallback: string) => fallback;
    return {
      lang: 'en',
      t: fill,
      level: (lv) => (lv ? DCC_LEVEL_LABEL[lv] : 'not assessed'),
      mode: (m) => MODE_LABEL[m],
      type: (kind) => TYPE_LABEL[kind],
      source: (s) => SOURCE_LABEL[s],
      skillName: named,
      trackName: named,
      lessonTitle: named,
      nodeLabel: (node) => node.label,
    };
  }, []);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useI18n outside LangProvider');
  return ctx;
}
