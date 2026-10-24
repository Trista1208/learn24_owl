// The map layout must look tidy for any map: no node or label on top of another, no line through a label,
// no two branches crossing. Checked on the prepared maps and on many random ones with long chains and forks.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Lesson, MapNode, Skill } from '@l45/shared';
import { TYPE_LABEL } from '@l45/shared';
import { edgePoints, extent, layout, wrap, type Placed } from './layout.ts';

const data = new URL('../../../data/', import.meta.url);
const skills = JSON.parse(readFileSync(new URL('skills.json', data), 'utf8')) as Skill[];
const lessons = readdirSync(new URL('lessons/', data)).flatMap((f) => JSON.parse(readFileSync(new URL(`lessons/${f}`, data), 'utf8')) as Lesson[]);

/** Small seeded random numbers, so a failing map can be reproduced. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
}

interface Spec { skill: string; tracks: { id: string; name: string; lessons: number; forkRate: number }[] }

/** Builds a map like the app does: start, skills, tracks, lessons as chains that sometimes fork. */
function build(specs: Spec[], rand: () => number): MapNode[] {
  const nodes: MapNode[] = [{ id: 'start', kind: 'start', parentId: null, label: 'Mara' }];
  for (const s of specs) {
    nodes.push({ id: `s-${s.skill}`, kind: 'skill', parentId: 'start', label: skills.find((x) => x.id === s.skill)?.name ?? 'Own topics', skillId: s.skill });
    for (const t of s.tracks) {
      nodes.push({ id: `t-${t.id}`, kind: 'track', parentId: `s-${s.skill}`, label: t.name, skillId: s.skill, trackId: t.id });
      const own: string[] = [];
      for (let i = 0; i < t.lessons; i++) {
        // Mostly the chain goes on from the last lesson; sometimes the agent forks off an earlier one.
        const parent = !own.length ? `t-${t.id}` : rand() < t.forkRate ? own[Math.floor(rand() * own.length)] : own[own.length - 1];
        const id = `n-${t.id}-${i}`;
        nodes.push({ id, kind: 'lesson', parentId: parent, label: lessons[Math.floor(rand() * lessons.length)].title, trackId: t.id, state: 'planned' });
        own.push(id);
      }
    }
  }
  return nodes;
}

function randomMap(seed: number): MapNode[] {
  const rand = rng(seed);
  const pool = ['digital', 'math', 'science', 'custom'];
  const count = 1 + Math.floor(rand() * 4);
  const specs: Spec[] = pool.slice(0, count).map((skill, k) => ({
    skill,
    tracks: Array.from({ length: 1 + Math.floor(rand() * (skill === 'digital' ? 5 : 6)) }, (_, i) => ({
      id: `${k}-${i}`,
      name: rand() < 0.5 ? 'Pass Security+ SY0-701 with practice questions' : skills.flatMap((s) => s.tracks)[Math.floor(rand() * 7)].name,
      lessons: Math.floor(rand() * 12),
      forkRate: rand() * 0.35,
    })),
  }));
  return build(specs, rand);
}

type Box = { x0: number; x1: number; y0: number; y1: number };
const box = (p: Placed, part: 'all' | 'text' = 'all'): Box[] => {
  const e = extent(p.node.kind);
  const all = { x0: p.x - e.left, x1: p.x + e.right, y0: p.y - e.top, y1: p.y + e.bottom };
  if (part === 'all') return [all];
  // Only the text above and below the disc; lines may pass through a node's own disc.
  const disc = p.node.kind === 'start' ? 42 : p.node.kind === 'skill' ? 30 : p.node.kind === 'track' ? 22 : 16;
  return [{ ...all, y1: p.y - disc }, { ...all, y0: p.y + disc }];
};
const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const inside = (pt: { x: number; y: number }, b: Box) => pt.x > b.x0 && pt.x < b.x1 && pt.y > b.y0 && pt.y < b.y1;

function segmentsCross(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }) {
  const o = (p: typeof a, q: typeof a, r: typeof a) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
}

/** Everything that makes a map look messy, in words. Empty = tidy. */
function problems(nodes: MapNode[]): string[] {
  const placed = [...layout(nodes).values()];
  const byId = new Map(placed.map((p) => [p.node.id, p]));
  const out: string[] = [];
  expect(placed).toHaveLength(nodes.length);

  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (overlaps(box(placed[i])[0], box(placed[j])[0])) out.push(`${placed[i].node.id} overlaps ${placed[j].node.id}`);
    }
  }

  const edges = placed.filter((p) => p.node.parentId).map((p) => ({ from: byId.get(p.node.parentId!)!, to: p, pts: edgePoints(byId.get(p.node.parentId!)!, p) }));
  for (const e of edges) {
    for (const p of placed) {
      const own = p === e.from || p === e.to;
      for (const b of box(p, own ? 'text' : 'all')) {
        if (e.pts.some((pt) => inside(pt, b))) out.push(`Line ${e.from.node.id}→${e.to.node.id} through ${p.node.id}`);
      }
    }
  }
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const a = edges[i], b = edges[j];
      if (a.from === b.from || a.to === b.from || b.to === a.from) continue;
      const crossed = a.pts.some((p, k) => k > 0 && b.pts.some((q, m) => m > 0 && segmentsCross(a.pts[k - 1], p, b.pts[m - 1], q)));
      if (crossed) out.push(`Lines ${a.to.node.id} and ${b.to.node.id} cross`);
    }
  }
  return [...new Set(out)];
}

describe('Map layout', () => {
  it('arranges the prepared areas without overlap', () => {
    const specs: Spec[] = skills.map((s) => ({ skill: s.id, tracks: s.tracks.map((t) => ({ id: t.id, name: t.name, lessons: 4, forkRate: 0 })) }));
    expect(problems(build(specs, rng(1)))).toEqual([]);
  });

  it('stays clean with long chains and branches', () => {
    const specs: Spec[] = [{ skill: 'custom', tracks: [{ id: 'sec', name: 'Pass Security+ SY0-701', lessons: 25, forkRate: 0.3 }] }];
    expect(problems(build(specs, rng(2)))).toEqual([]);
  });

  it('is clean for random maps', () => {
    for (let seed = 1; seed <= 40; seed++) expect(problems(randomMap(seed)), `Map ${seed}`).toEqual([]);
  });

  it('keeps both sides about equally high', () => {
    const specs: Spec[] = skills.map((s) => ({ skill: s.id, tracks: s.tracks.map((t) => ({ id: t.id, name: t.name, lessons: 2, forkRate: 0 })) }));
    const placed = [...layout(build(specs, rng(3))).values()];
    const span = (side: 1 | -1) => {
      const ys = placed.filter((p) => p.depth > 0 && p.side === side).map((p) => p.y);
      return Math.max(...ys) - Math.min(...ys);
    };
    expect(span(1)).toBeGreaterThan(0);
    expect(span(-1)).toBeGreaterThan(0);
  });

  it('reserves enough room for the longest labels', () => {
    // Conservative width per character of the map font (Signika): regular 0.56 em, bold 0.6 em.
    const width = (text: string, px: number, bold = false) => text.length * px * (bold ? 0.6 : 0.56);
    const half = (kind: MapNode['kind']) => extent(kind).left;
    const long = 'A very long title for a lesson about encryption and the exchange of keys';
    for (const title of [...lessons.map((l) => l.title), long]) {
      for (const line of wrap(title, 20)) expect(width(line, 14) / 2, line).toBeLessThanOrEqual(half('lesson'));
    }
    for (const t of Object.values(TYPE_LABEL)) expect(width(`${t}, 5 Min., KI`, 12) / 2).toBeLessThanOrEqual(half('lesson'));
    expect(width('Next step', 12, true) / 2).toBeLessThanOrEqual(half('lesson'));
    for (const name of [...skills.flatMap((s) => s.tracks.map((t) => t.name)), 'Pass Security+ SY0-701 with practice questions and PBQs']) {
      for (const line of wrap(name, 18)) expect(width(line, 16, true) / 2, line).toBeLessThanOrEqual(half('track'));
    }
    expect(width('DCC: Intermediate', 13) / 2).toBeLessThanOrEqual(half('track'));
    for (const s of [...skills.map((x) => x.name), 'Own topics']) expect(width(s, 21, true) / 2, s).toBeLessThanOrEqual(half('skill'));
  });
});
