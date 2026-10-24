// Related videos and web pages for a lesson topic. No API key: DuckDuckGo's public HTML search.
import { HttpError } from './sessions.ts';

export interface LearnHit {
  title: string;
  url: string;
  snippet: string;
  image?: string;
}

export interface LearnMoreResult {
  videos: LearnHit[];
  web: LearnHit[];
}

const SEARCH = 'https://html.duckduckgo.com/html/';
const TAIL = 'explained';

const cache = new Map<string, { at: number; value: LearnMoreResult }>();

function decode(value: string): string {
  return value
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function realUrl(href: string): string {
  const raw = decode(href);
  const absolute = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const uddg = new URL(absolute).searchParams.get('uddg');
    if (uddg) return uddg;
  } catch {
    /* keep the original href */
  }
  return absolute;
}

function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    if (host === 'youtu.be') return u.pathname.split('/').filter(Boolean)[0] ?? null;
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = u.searchParams.get('v') ?? u.pathname.match(/\/(?:live|shorts|embed)\/([^/?]+)/)?.[1];
      return id || null;
    }
  } catch {
    /* not a video url */
  }
  return null;
}

async function hits(q: string): Promise<{ title: string; url: string; snippet: string }[]> {
  const res = await fetch(`${SEARCH}?q=${encodeURIComponent(q)}`, {
    headers: { 'user-agent': 'Mozilla/5.0 (compatible; Learn45/1.0)' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(String(res.status));
  const html = await res.text();
  const found: { title: string; url: string; snippet: string }[] = [];
  for (const part of html.split('class="result results_links').slice(1, 14)) {
    const link = part.match(/class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!link) continue;
    const url = realUrl(link[1]);
    if (!url.startsWith('http')) continue;
    const snippet = part.match(/class="result__snippet"[^>]*>([\s\S]*?)<\//);
    found.push({ title: decode(link[2]), url, snippet: snippet ? decode(snippet[1]) : '' });
  }
  return found;
}

export async function learnMore(rawQuery: string, lang: string): Promise<LearnMoreResult> {
  const topic = rawQuery.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (topic.length < 2) throw new HttpError(400, 'Say what you want to learn more about.');
  const key = `${lang}:${topic.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const tail = TAIL;
  const q = tail ? `${topic} ${tail}` : topic;
  let pages: { title: string; url: string; snippet: string }[];
  let clips: { title: string; url: string; snippet: string }[];
  try {
    [pages, clips] = await Promise.all([hits(q), hits(`${q} site:youtube.com`)]);
  } catch (err) {
    console.error('learn-more', err);
    throw new HttpError(503, 'Search is not reachable just now.');
  }
  const videos = clips.flatMap((item) => {
    const id = youtubeId(item.url);
    if (!id) return [];
    return [{
      title: item.title.replace(/\s+-\s+YouTube$/i, ''),
      url: `https://www.youtube.com/watch?v=${id}`,
      snippet: item.snippet,
      image: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    }];
  }).filter((item, i, all) => all.findIndex((x) => x.url === item.url) === i).slice(0, 4);
  const web = pages.filter((item) => !youtubeId(item.url) && !/duckduckgo\.com/i.test(item.url)).slice(0, 4);
  const value = { videos, web };
  cache.set(key, { at: Date.now(), value });
  return value;
}
