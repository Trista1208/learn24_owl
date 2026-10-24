// Optional access gate for a public deployment: HTTP Basic Auth against ACCESS_USERS ("name:password,name:password").
// Without ACCESS_USERS the app stays open, as in local development.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/** Parses "name:password,name:password". A set but unusable value throws, so a typo never leaves the app open. */
export function parseUsers(raw: string | undefined): Map<string, string> | null {
  if (!raw?.trim()) return null;
  const users = new Map<string, string>();
  for (const entry of raw.split(',')) {
    const i = entry.indexOf(':');
    const name = entry.slice(0, i).trim();
    const password = entry.slice(i + 1).trim();
    if (i > 0 && name && password) users.set(name, password);
  }
  if (!users.size) throw new Error('ACCESS_USERS is set but contains no name:password entry');
  return users;
}

// Hashing first gives both sides the same length, so the comparison does not leak it.
const same = (a: string, b: string) => timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());

function credentials(header: string | undefined): [string, string] | null {
  const match = /^Basic ([A-Za-z0-9+/=]+)$/.exec(header ?? '');
  if (!match) return null;
  const decoded = Buffer.from(match[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i < 0 ? null : [decoded.slice(0, i), decoded.slice(i + 1)];
}

/** Middleware, or null when no users are configured. The health check stays open for the hosting platform. */
export function accessGate(raw: string | undefined) {
  const users = parseUsers(raw);
  if (!users) return null;
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api/health') return next();
    const given = credentials(req.headers.authorization);
    const password = given ? users.get(given[0]) : undefined;
    if (given && password !== undefined && same(given[1], password)) return next();
    res.set('WWW-Authenticate', 'Basic realm="AIthena", charset="UTF-8"').status(401).json({ error: 'Sign-in required' });
  };
}
