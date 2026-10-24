// The lesson validator: the same rules for the prepared pool and for generated lessons.
import { describe, expect, it } from 'vitest';
import type { Lesson, MockSiteLesson, VideoLesson } from '@l45/shared';
import { content, getTrack, rejectedLessons } from '../src/content.ts';
import { shuffleQuiz } from '../src/generator.ts';
import { validateLesson } from '../src/validate.ts';
import { mockSiteJson } from './helpers.ts';

const sicherheit = getTrack('t-sicherheit')!;
const urls = ['https://www.bacs.admin.ch/de/phishing-de'];
const pool = (id: string) => structuredClone(content.lessons.find((l) => l.id === id)!) as Lesson;

function generatedMockSite(domain?: string): MockSiteLesson {
  const raw = JSON.parse(mockSiteJson({ domain }));
  return {
    id: 'ki-test', trackId: 't-sicherheit', type: 'mock-site', level: 'Grundstufe', title: raw.title, intro: raw.intro, durationMin: 3,
    mode: 'alone', targets: ['link'], source: 'model', primarySource: { title: 'BACS', url: urls[0] },
    provenance: { by: 'model', model: 'mock', at: '2026-10-24T00:00:00Z', basedOn: [], sessionNo: 1 },
    content: raw.content,
  };
}

describe('Validator', () => {
  it('accepts all prepared lessons', () => {
    expect(rejectedLessons).toEqual([]);
    expect(content.lessons.length).toBe(24);
  });

  it('accepts a valid generated website lesson', () => {
    expect(validateLesson(generatedMockSite(), { track: sicherheit, sourceUrls: urls })).toEqual([]);
  });

  it('rejects real-looking domains and real brands', () => {
    const errors = validateLesson(generatedMockSite('kundenportal.ch'), { track: sicherheit, sourceUrls: urls });
    expect(errors.join()).toMatch(/only made-up \.example addresses are allowed, found: kundenportal\.ch/);

    const l = generatedMockSite();
    l.content.mail![0].text = 'PostFinance <service@postfinance-info.example>';
    expect(validateLesson(l, { track: sicherheit, sourceUrls: urls }).join()).toMatch(/real brands.*postfinance/);
  });

  it('checks that the verdict and the warning signs match', () => {
    const l = generatedMockSite();
    l.content.correctVerdict = 'echt';
    expect(validateLesson(l, { track: sicherheit, sourceUrls: urls }).join()).toMatch(/"echt" \(genuine\), but warning signs/);
    for (const p of [...l.content.mail!, ...l.content.site]) delete p.signal;
    l.content.correctVerdict = 'phishing';
    expect(validateLesson(l, { track: sicherheit, sourceUrls: urls }).join()).toMatch(/"phishing", but no warning sign/);
  });

  it('rejects quiz questions with answers of unequal length', () => {
    const l = pool('sich-v1') as VideoLesson;
    l.content.questions[0].options = ['Short', 'A much longer answer than the others', 'Medium long'];
    expect(validateLesson(l, { track: sicherheit }).join()).toMatch(/differ by at most 2 words \(now 1\/7\/2\)/);
  });

  it('allows answers that differ by up to 2 words', () => {
    const l = pool('sich-v1') as VideoLesson;
    l.content.questions[0].options = ['One two three', 'One two three four', 'One two three four five'];
    expect(validateLesson(l, { track: sicherheit }).join()).not.toMatch(/words/);
  });

  it('rejects the right answer always in the same place', () => {
    const l = pool('sich-v1') as VideoLesson;
    l.content.questions.forEach((q) => (q.correct = 0));
    expect(validateLesson(l, { track: sicherheit }).join()).toMatch(/in the same place/);
  });

  it('shuffles the right answer into different places', () => {
    for (let i = 0; i < 20; i++) {
      const qs = shuffleQuiz([
        { options: ['right one', 'wrong two', 'wrong three'], correct: 0 },
        { options: ['right four', 'wrong five', 'wrong six'], correct: 0 },
      ]);
      expect(qs[0].correct).not.toBe(qs[1].correct);
      expect(qs[0].options[qs[0].correct]).toBe('right one');
      expect(qs[1].options[qs[1].correct]).toBe('right four');
    }
  });

  it('requires at most 5 minutes and a source from the list', () => {
    const l = generatedMockSite();
    l.durationMin = 8;
    l.primarySource = { title: 'Blog', url: 'https://somewhere.example/blog' };
    const e = validateLesson(l, { track: sicherheit, sourceUrls: urls }).join();
    expect(e).toMatch(/duration must be 1 to 5 minutes/);
    expect(e).toMatch(/is not among the area's sources/);
  });

  it('requires generated practice sites to say that everything is made up', () => {
    const l = generatedMockSite();
    l.content.disclaimer = 'Practice example with addresses on .example.';
    expect(validateLesson(l, { track: sicherheit, sourceUrls: urls }).join()).toMatch(/the notice must say/);
  });

  it('requires a made-up sentence with a criterion of the area in text checks', () => {
    const l = pool('info-m1');
    if (l.type !== 'mark-evidence') throw new Error('test data');
    for (const s of l.content.summary) s.verdict = 'belegt';
    expect(validateLesson(l, { track: getTrack('t-info') }).join()).toMatch(/at least one sentence must be "erfunden"/);
    const l2 = pool('info-m1');
    if (l2.type !== 'mark-evidence') throw new Error('test data');
    l2.content.summary.find((s) => s.verdict === 'erfunden')!.criterion = 'doesnotexist';
    expect(validateLesson(l2, { track: getTrack('t-info') }).join()).toMatch(/unknown criterion doesnotexist/);
  });
});
