// Small markdown helpers for the teaching workspace: frontmatter, slugs, list sections.

type Value = string | number | boolean | string[] | undefined;

const plain = (s: string) => /^[^\n"[{]/.test(s) && !/^(true|false|-?\d+(\.\d+)?)$/.test(s) && s.trim() === s;

export function toMd(meta: Record<string, Value>, body: string): string {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${typeof v === 'string' && plain(v) ? v : JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n${body.trimEnd()}\n`;
}

export function fromMd(text: string): { meta: Record<string, unknown>; body: string } {
  const t = text.replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  if (!m) return { meta: {}, body: t };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const raw = line.slice(i + 1).trim();
    let v: unknown = raw;
    if (/^["[{]/.test(raw) || /^(true|false|-?\d+(\.\d+)?)$/.test(raw)) {
      try {
        v = JSON.parse(raw);
      } catch {
        v = raw;
      }
    }
    meta[line.slice(0, i).trim()] = v;
  }
  return { meta, body: m[2] };
}

export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'entry'
  );
}

/** Text under a `## heading` up to the next heading. */
export function section(body: string, heading: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim().toLowerCase() === `## ${heading}`.toLowerCase());
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^#{1,2} /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

/** `- item` lines of a markdown block. */
export const bullets = (block: string) => block.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim());
