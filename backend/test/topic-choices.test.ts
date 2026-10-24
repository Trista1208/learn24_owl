import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionView, TopicChoices } from '@l45/shared';
import { createApp } from '../src/app.ts';
import { setSourceCheck } from '../src/designer.ts';
import { setMockHandler, type ModelRequest } from '../src/provider.ts';
import { _idle, _reset, get } from '../src/sessions.ts';
import { addTracks, mockSiteJson, session, v1Right } from './helpers.ts';

let app = createApp();
let calls: ModelRequest[] = [];
const proposals = () => JSON.stringify({ topics: [
  { title: 'Recognise link targets reliably', reason: 'Go deeper into checking links.', criterion: 'link' },
  { title: 'Check links in invoice emails', reason: 'Apply what you know to an invoice.', criterion: 'link' },
  { title: 'Compare domains more closely', reason: 'Explore a related focus.', criterion: 'adresse' },
] });

beforeEach(() => {
  _reset();
  app = createApp();
  process.env.MODEL_PROVIDER = 'mock';
  calls = [];
  setMockHandler(req => { calls.push(req); return req.purpose === 'plan' ? proposals() : mockSiteJson(); });
});
afterEach(async () => {
  await _idle();
  setMockHandler(null);
  setSourceCheck(null);
  process.env.MODEL_PROVIDER = 'none';
});

async function learner(trackIds = ['t-sicherheit']): Promise<SessionView> {
  const r = await request(app).post('/api/login').send({ name: 'Topic learner', levels: { 't-sicherheit': 'Grundstufe', 't-info': 'Fortgeschritten' } }).expect(201);
  return addTracks(app, r.body, trackIds);
}
async function topics(v: SessionView, track = 't-sicherheit'): Promise<TopicChoices> {
  const r = await request(app).post(`/api/sessions/${v.session.id}/tracks/${track}/topics`).send({}).expect(200);
  return r.body.choices;
}
const choose = (v: SessionView, c: TopicChoices, index = 1, format = 'mock-site') => request(app).post(`/api/sessions/${v.session.id}/topics/choose`).send({ choiceSetId: c.id, topicId: c.topics[index].id, format });

describe('Topic previews followed by an explicit format choice', () => {
  it('offers three distinct previews, exactly one recommended, without lessons or map nodes; refresh reuses them', async () => {
    const v = await learner();
    const c = await topics(v);
    expect(c.topics).toHaveLength(3);
    expect(new Set(c.topics.map(t => t.title)).size).toBe(3);
    expect(c.topics.filter(t => t.recommended)).toHaveLength(1);
    for (const topic of c.topics) expect(topic.formats).toEqual(expect.arrayContaining(['video', 'ai-chat', 'mark-evidence', 'mock-site']));
    expect(c.topics.every(t => !('content' in t))).toBe(true);
    expect(c.source).toBe('model');
    const after = await session(app, v.session.id);
    expect(after.session.nodes).toEqual(v.session.nodes);
    expect((await request(app).get(`/api/sessions/${v.session.id}/lessons`)).body).toEqual([]);
    expect((await topics(v)).id).toBe(c.id);
    expect(calls.map(c => c.purpose)).toEqual(['plan']);
    const sent = JSON.stringify(calls);
    expect(sent).not.toContain('Topic learner');
    expect(sent).not.toContain(v.session.learnerId);
  });

  it.each(['ai-chat', 'mark-evidence'])('generates a %s lesson even when the area has no prepared example in that format', async format => {
    const v = await learner();
    const c = await topics(v);
    setMockHandler(req => {
      calls.push(req);
      return JSON.stringify({
        title: 'Understand link targets', intro: 'You check where a link goes.', durationMin: 3,
        primarySourceUrl: 'https://www.bacs.admin.ch/de/phishing-de',
        content: format === 'ai-chat' ? {
          kind: 'tutor', goal: 'You recognise foreign link targets.', aiRole: 'Ask questions about the link target.',
          opening: 'How do you check a link before you click?', minTurns: 2,
          criteria: [{ id: 'link', label: 'Link target', hint: 'Read the target address.' }], fallbackReplies: ['What does the link target say?'],
        } : {
          noteTitle: 'Made-up example note', note: ['The link goes to a foreign domain.', 'You can show the target before you click.'],
          summary: [
            { id: 's1', text: 'The link goes to a foreign domain.', verdict: 'belegt', explanation: 'The note says this.' },
            { id: 's2', text: 'The link surely goes to the familiar site.', verdict: 'erfunden', criterion: 'link', explanation: 'The note names a foreign domain.' },
          ],
        },
      });
    });
    const r = await choose(v, c, 1, format).expect(201);
    expect(r.body.generated[0].type).toBe(format);
    expect(r.body.view.session.preferredLessonType).toBe(format);
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(1);
  });

  it('uses topic-specific format suggestions, excludes unsupported formats and always offers a podcast', async () => {
    const v = await learner();
    setMockHandler(() => JSON.stringify({ topics: [
      { title: 'Explain link targets', reason: 'Understand the target address.', criterion: 'link', formats: ['video', 'ai-chat'] },
      { title: 'Check a summary', reason: 'Compare statements with a note.', criterion: 'link', formats: ['mark-evidence', 'ai-chat', 'lesetext'] },
      { title: 'Check a login page', reason: 'Practise directly on an example page.', criterion: 'adresse', formats: ['mock-site', 'video', 'podcast'] },
    ] }));
    const c = await topics(v);
    expect(c.topics[0].formats).toEqual(['video', 'ai-chat', 'podcast']);
    expect(c.topics[1].formats).toEqual(['mark-evidence', 'ai-chat', 'podcast']);
    expect(c.topics[2].formats).toEqual(['video', 'mock-site', 'podcast']);
    await choose(v, c, 0, 'mock-site').expect(400);
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(0);
  });

  it('generates only the selected topic and exact format, adds one node, and records another direction neutrally', async () => {
    const v = await learner();
    const c = await topics(v);
    const r = await choose(v, c).expect(201);
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(1);
    expect(calls.at(-1)!.messages[0].content).toContain(c.topics[1].title);
    expect(calls.at(-1)!.messages[0].content).toContain('Lesson type: mock-site');
    expect(r.body.generated).toHaveLength(1);
    expect(r.body.generated[0].type).toBe('mock-site');
    expect(r.body.view.session.nodes).toHaveLength(v.session.nodes.length + 1);
    expect(r.body.view.session.preferredLessonType).toBe('mock-site');
    expect(r.body.view.session.recommendations.at(-1)).toMatchObject({ status: 'chosen', chosenNodeId: r.body.nodeId });
    expect(r.body.view.session.topicChoices).toBeUndefined();
    // An old/replayed submission must not generate a duplicate lesson.
    await choose(v, c).expect(409);
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(1);
  });

  it('does not generate a full next lesson when a chosen lesson is completed', async () => {
    const v = await learner();
    const c = await topics(v);
    const r = await choose(v, c).expect(201);
    const id = r.body.nodeId;
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${id}/start`).expect(200);
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${id}/complete`).send({ answer: { type: 'mock-site', marked: ['m-link', 'w-url'], verdict: 'phishing' } }).expect(200);
    await _idle();
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(1);
    const after = await session(app, v.session.id);
    expect(after.session.planning).toBe(false);
    expect(after.session.nodes).toHaveLength(v.session.nodes.length + 1);
    const next = await topics(v);
    expect(next.id).not.toBe(c.id);
    expect(next.parentNodeId).toBe(id);
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(1);
  });

  it('offers only the peak exam after five lessons, built from what that mountain trained', async () => {
    const v = await learner();
    for (let i = 0; i < 5; i++) {
      const c = await topics(v);
      expect(c.topics.some(t => t.exam)).toBe(false);
      const id = (await choose(v, c).expect(201)).body.nodeId;
      await request(app).post(`/api/sessions/${v.session.id}/nodes/${id}/start`).expect(200);
      await request(app).post(`/api/sessions/${v.session.id}/nodes/${id}/complete`).send({ answer: { type: 'mock-site', marked: ['m-link', 'w-url'], verdict: 'phishing' } }).expect(200);
      await _idle();
    }
    const plans = calls.filter(c => c.purpose === 'plan').length;
    const peak = await topics(v);
    expect(peak.topics).toHaveLength(1);
    expect(peak.topics[0]).toMatchObject({ title: 'Summit test', exam: true, recommended: true });
    expect(peak.canSuggestOwn).toBe(false);
    expect(calls.filter(c => c.purpose === 'plan')).toHaveLength(plans);

    const id = (await choose(v, peak, 0).expect(201)).body.nodeId;
    const prompt = calls.filter(c => c.purpose === 'generate').at(-1)!.messages[0].content;
    expect(prompt).toContain('Summit test');
    // Exam coverage must not depend on the one-day spaced review deadline having elapsed.
    const queued = get(v.session.id).session.reviewQueue;
    expect(queued.some(q => q.criterion === 'adresse')).toBe(true);
    expect(queued.every(q => q.dueAt && Date.parse(q.dueAt) > Date.now())).toBe(true);
    // The five lessons trained link and adresse, so the exam brings back both.
    expect(prompt).toMatch(/- link: /);
    expect(prompt).toMatch(/- adresse: /);
    const after = await session(app, v.session.id);
    const lessonId = after.session.nodes.find(n => n.id === id)!.lessonId;
    const lessons = (await request(app).get(`/api/sessions/${v.session.id}/lessons`)).body as { id: string; provenance?: { exam?: true } }[];
    expect(lessons.find(l => l.id === lessonId)?.provenance?.exam).toBe(true);

    // After the peak the next mountain starts with ordinary topics.
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${id}/start`).expect(200);
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${id}/complete`).send({ answer: { type: 'mock-site', marked: ['m-link', 'w-url'], verdict: 'phishing' } }).expect(200);
    await _idle();
    const next = await topics(v);
    expect(next.topics).toHaveLength(3);
    expect(next.topics.some(t => t.exam)).toBe(false);
  });

  it('keeps the peak an ordinary lesson without a model', async () => {
    const v = await learner();
    for (let i = 0; i < 5; i++) {
      const c = await topics(v);
      const id = (await choose(v, c).expect(201)).body.nodeId;
      await request(app).post(`/api/sessions/${v.session.id}/nodes/${id}/start`).expect(200);
      await request(app).post(`/api/sessions/${v.session.id}/nodes/${id}/complete`).send({ answer: { type: 'mock-site', marked: ['m-link', 'w-url'], verdict: 'phishing' } }).expect(200);
      await _idle();
    }
    process.env.MODEL_PROVIDER = 'none';
    const peak = await topics(v);
    expect(peak.topics.some(t => t.exam)).toBe(false);
  });

  it('remembers the format and previews across a server restart, and the format across a new session', async () => {
    const v = await learner();
    const c = await topics(v);
    await choose(v, c).expect(201);
    const next = await topics(v);
    app = createApp();
    expect((await session(app, v.session.id)).session.preferredLessonType).toBe('mock-site');
    expect((await topics(v)).id).toBe(next.id);
    const r = await request(app).post('/api/login').send({ name: 'Topic learner', resume: 'continue', levels: { 't-sicherheit': 'Grundstufe', 't-info': 'Fortgeschritten' } }).expect(201);
    expect(r.body.session.preferredLessonType).toBe('mock-site');
    expect(r.body.session.id).not.toBe(v.session.id);
    const renewed = await topics(r.body);
    expect(renewed.id).not.toBe(next.id);
  });

  it('keeps three usable rule previews if topic planning fails', async () => {
    setMockHandler(() => 'not valid JSON');
    const v = await learner();
    const c = await topics(v);
    expect(c.source).toBe('rule');
    expect(c.topics).toHaveLength(3);
    expect(new Set(c.topics.map(t => t.title)).size).toBe(3);
    expect(c.topics.filter(t => t.recommended)).toHaveLength(1);
    expect(get(v.session.id).session.generatedLessons).toHaveLength(0);
  });

  it('keeps the chosen topic and preference unchanged after generation failure; retry can succeed', async () => {
    const v = await learner();
    const c = await topics(v);
    setMockHandler(() => 'invalid lesson');
    await choose(v, c).expect(502);
    const failed = await session(app, v.session.id);
    expect(failed.session.preferredLessonType).toBeUndefined();
    expect(failed.session.topicChoices!.id).toBe(c.id);
    expect(failed.session.nodes).toEqual(v.session.nodes);
    setMockHandler(() => mockSiteJson());
    await choose(v, c).expect(201);
  });

  it('tries a rejected lesson once more with the validator errors', async () => {
    const v = await learner();
    const c = await topics(v);
    const drafts: ModelRequest[] = [];
    setMockHandler(req => { drafts.push(req); return drafts.length === 1 ? mockSiteJson({ domain: 'postfinance.ch' }) : mockSiteJson(); });
    const r = await choose(v, c).expect(201);
    expect(r.body.generated).toHaveLength(1);
    expect(drafts).toHaveLength(2);
    expect(drafts[0].messages[0].content).not.toContain('Your last draft was rejected');
    expect(drafts[1].messages[0].content).toContain('Your last draft was rejected');
  });

  it('does not try again when the model call itself fails', async () => {
    const v = await learner();
    const c = await topics(v);
    let tries = 0;
    setMockHandler(() => { tries++; throw new Error('model down'); });
    await choose(v, c).expect(502);
    expect(tries).toBe(1);
  });

  it('validates a custom topic without creating a lesson, then generates it in the chosen format', async () => {
    const v = await learner();
    const c = await topics(v);
    setMockHandler(req => {
      calls.push(req);
      return req.purpose === 'plan' ? JSON.stringify({ criterion: 'link', reason: 'That fits checking link targets.' }) : mockSiteJson();
    });
    const custom = await request(app).post(`/api/sessions/${v.session.id}/topics/custom`).send({ choiceSetId: c.id, topic: 'Check links in parcel text messages' }).expect(200);
    expect(custom.body.topic.title).toBe('Check links in parcel text messages');
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(0);
    const r = await request(app).post(`/api/sessions/${v.session.id}/topics/choose`).send({ choiceSetId: c.id, topicId: custom.body.topic.id, format: 'mock-site' }).expect(201);
    expect(r.body.generated).toHaveLength(1);
    expect(calls.at(-1)!.messages[0].content).toContain('Check links in parcel text messages');
  });

  it('rejects invalid, unsupported, cross-learner, and stale choices before generation', async () => {
    const v = await learner();
    const c = await topics(v);
    await choose(v, c, 0, 'lesetext').expect(400);
    await choose(v, c, 0, 'unknown-format').expect(400);
    await request(app).post(`/api/sessions/${v.session.id}/topics/choose`).send({ choiceSetId: c.id, topicId: 'made-up', format: 'video' }).expect(400);
    await request(app).post(`/api/sessions/${v.session.id}/topics/custom`).send({ choiceSetId: c.id, topic: 'x' }).expect(400);
    await request(app).post(`/api/sessions/${v.session.id}/tracks/t-info/topics`).send({}).expect(404);
    const other = await request(app).post('/api/login').send({ name: 'Other learner' }).expect(201);
    await request(app).post(`/api/sessions/${other.body.session.id}/topics/choose`).send({ choiceSetId: c.id, topicId: c.topics[0].id, format: 'video' }).expect(409);
    await request(app).put(`/api/sessions/${v.session.id}/missions/t-sicherheit`).send({ text: 'I want to check parcel text messages reliably.' }).expect(200);
    await choose(v, c).expect(409);
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(0);
  });

  it('rejects an out-of-scope custom topic without changing the mission or criteria', async () => {
    const v = await learner();
    const c = await topics(v);
    setMockHandler(() => JSON.stringify({ error: 'That needs a new area.' }));
    await request(app).post(`/api/sessions/${v.session.id}/topics/custom`).send({ choiceSetId: c.id, topic: 'Learn Italian' }).expect(422);
    const after = await session(app, v.session.id);
    expect(after.skills).toEqual(v.skills);
    expect(after.workspace.missions).toEqual(v.workspace.missions);
    expect(get(v.session.id).session.generatedLessons).toHaveLength(0);
  });

  it('deduplicates simultaneous preview requests and rejects a second generation while one is running', async () => {
    const v = await learner();
    let releasePlan!: (text: string) => void;
    setMockHandler(req => { calls.push(req); return new Promise(resolve => { releasePlan = resolve; }); });
    const first = topics(v);
    while (!releasePlan) await new Promise(resolve => setTimeout(resolve, 5));
    const second = topics(v);
    releasePlan(proposals());
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(b.id);
    expect(calls).toHaveLength(1);
    let releaseLesson!: (text: string) => void;
    setMockHandler(req => { calls.push(req); return new Promise(resolve => { releaseLesson = resolve; }); });
    const pending = choose(v, a).then(r => r);
    while (!releaseLesson) await new Promise(resolve => setTimeout(resolve, 5));
    await choose(v, a).expect(409);
    releaseLesson(mockSiteJson());
    expect((await pending).status).toBe(201);
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(1);
  });

  it('enforces the generation limit before making another paid generation request', async () => {
    const v = await learner();
    const c = await topics(v);
    await choose(v, c).expect(201);
    const next = await topics(v);
    const generated = get(v.session.id).session.generatedLessons;
    for (let i = 1; i < 10; i++) generated.push({ ...generated[0], id: `already-generated-${i}` });
    await choose(v, next).expect(429);
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(1);
    expect((await session(app, v.session.id)).session.topicChoices!.id).toBe(next.id);
  });

  it('offers only existing prepared formats without a model and reuses the selected lesson', async () => {
    process.env.MODEL_PROVIDER = 'none';
    const v = await learner();
    const c = await topics(v);
    expect(c.canSuggestOwn).toBe(false);
    expect(c.topics).toHaveLength(3);
    expect(c.topics.every(t => t.formats.length === 1 && t.lessonId)).toBe(true);
    const r = await choose(v, c, 0, c.topics[0].formats[0]).expect(201);
    expect(r.body.generated).toEqual([]);
    expect(calls).toHaveLength(0);
    expect(r.body.view.session.preferredLessonType).toBe(c.topics[0].formats[0]);
  });

  it('reuses an existing recommended lesson and does not create the next one after completion', async () => {
    const v = await learner();
    setMockHandler(() => 'invalid plan');
    const c = await topics(v);
    expect(c.topics[0].lessonId).toBe('sich-v1');
    const r = await choose(v, c, 0, 'video').expect(201);
    expect(r.body.generated).toEqual([]);
    await request(app).post(`/api/sessions/${v.session.id}/nodes/${r.body.nodeId}/complete`).send({ answer: v1Right }).expect(200);
    expect(calls.filter(c => c.purpose === 'generate')).toHaveLength(0);
  });

  it('designs a new area without creating its first lesson before topic and format selection', async () => {
    setSourceCheck(async () => true);
    setMockHandler(req => {
      calls.push(req);
      return JSON.stringify({
        name: 'Photosynthesis', criteria: [
          { id: 'licht', label: 'Light as energy', ruleOfThumb: 'Plants use light as a source of energy.' },
          { id: 'wasser', label: 'Water', ruleOfThumb: 'Plants need water for photosynthesis.' },
          { id: 'zucker', label: 'Sugar', ruleOfThumb: 'Plants make sugar during photosynthesis.' },
        ], sources: [{ title: 'University', url: 'https://www.ethz.ch/', note: 'Plant biology' }], lessonTypes: ['video', 'ai-chat'],
      });
    });
    const v = await request(app).post('/api/login').send({ name: 'New area' }).expect(201);
    const r = await request(app).post(`/api/sessions/${v.body.session.id}/own-tracks`).send({ topic: 'Photosynthesis', deferLesson: true }).expect(201);
    expect(r.body.generated).toEqual([]);
    expect(r.body.view.session.nodes.filter((n: { kind: string }) => n.kind === 'lesson')).toEqual([]);
    const c = await topics(r.body.view, r.body.trackId);
    expect(c.topics).toHaveLength(3);
    expect(c.topics.every(t => t.formats.includes('video') && t.formats.includes('ai-chat'))).toBe(true);
    expect(calls.map(c => c.purpose)).toEqual(['design', 'plan']);
  });
});
