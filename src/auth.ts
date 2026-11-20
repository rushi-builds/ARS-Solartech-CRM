// ARS Solartech - email + password auth for a plain Cloudflare deployment.
// Passwords are PBKDF2-SHA256 (WebCrypto), sessions are random opaque tokens
// stored hashed in D1 and sent as an HttpOnly cookie. No third-party identity
// provider, so the app runs entirely inside one Cloudflare account.

export const SESSION_COOKIE = 'ars_session';
const SESSION_DAYS = 30;
// Cloudflare Workers' WebCrypto rejects PBKDF2 iteration counts above 100,000
// ("Pbkdf2 failed: iteration counts above 100000 are not supported").
const ITERATIONS = 100_000;
const MAX_ITERATIONS = 100_000;

const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const b64url = (buf: ArrayBuffer | Uint8Array): string =>
  b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function fromB64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as unknown as BufferSource, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** Returns `pbkdf2$<iterations>$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

/** Constant-time-ish comparison of a candidate password with a stored hash. */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]) || ITERATIONS;
  // Older hashes were stored with 150k iterations, which Workers cannot derive.
  if (iterations > MAX_ITERATIONS) return false;
  const salt = fromB64(parts[2]);
  const expected = fromB64(parts[3]);
  const actual = await pbkdf2(password, salt, iterations);
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
  return diff === 0;
}

/** Opaque session token + the SHA-256 hash that is stored in D1. */
export async function newSessionToken(): Promise<{ token: string; tokenHash: string }> {
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  return { token, tokenHash: await sha256(token) };
}

export async function sha256(value: string): Promise<string> {
  return b64(await crypto.subtle.digest('SHA-256', enc.encode(value)));
}

export function sessionExpiry(days = SESSION_DAYS): string {
  return new Date(Date.now() + days * 86400_000).toISOString();
}

export function readSessionToken(request: Request): string | null {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}

export function sessionCookie(token: string, origin: string): string {
  const secure = origin.startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure}`;
}

export function clearSessionCookie(origin: string): string {
  const secure = origin.startsWith('https://') ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

/** Basic same-origin guard for state-changing requests. */
export function sameOrigin(request: Request, expectedOrigin: string): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return request.headers.get('Sec-Fetch-Site') !== 'cross-site';
  try {
    return new URL(origin).origin === new URL(expectedOrigin).origin;
  } catch {
    return false;
  }
}

export function validEmail(v: unknown): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) && s.length <= 160 ? s : null;
}

export function passwordProblem(pw: unknown): string | null {
  const s = String(pw ?? '');
  if (s.length < 8) return 'Password must be at least 8 characters';
  if (s.length > 200) return 'Password is too long';
  return null;
}
