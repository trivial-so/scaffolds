/**
 * trivial-auth — your app's END-USER sign-in.
 *
 * This file is YOURS (vendored into your project — read it, change it). It signs a real end-user
 * (NOT you, the maker) into your app and hands `trivial-data.ts` a bearer token for the data API.
 *
 * ── HOW SIGN-IN WORKS ────────────────────────────────────────────────────────
 * `signIn()` sends the visitor to `/__trivial/auth/sign-in` — a hosted page on YOUR app's own
 * origin (Trivial serves it; you don't build a form). The visitor signs in or creates an account
 * there; the page stores the tokens in this origin's localStorage and returns them to where they
 * were. Same-origin end to end: no OAuth in the browser, no token ever in a URL, no cookies —
 * the bearer token below is the only credential, per-person and revocable.
 *
 * The previous version of this file drove OAuth PKCE in the browser against Zitadel's hosted
 * login. The first-party flow replaced it: the sign-in page is unbranded, registration works, and
 * the client shrank to "navigate there, read the store when you're back".
 *
 * ── PREVIEW PARITY (the canvas frame) ────────────────────────────────────────
 * The SAME code works before you publish. In the canvas preview there are no Live users, so
 * `signIn()` asks the workshop for the Draft-user picker (view-as) instead of navigating, and
 * `getUser()`/`onUser()` reflect whichever Draft user the frame is wearing. Build your sign-in
 * button once; it works in the frame today and for Live users the moment you publish.
 *
 * ── THE API YOU'LL ACTUALLY USE ──────────────────────────────────────────────
 *   signIn() / signOut()      — start/end a session (preview: opens/clears the Draft-user picker)
 *   sendPasswordReset(email)  — email a managed reset link (Trivial hosts the reset page)
 *   sendVerificationEmail(e)  — email a managed verification link
 *   getUser() / onUser(cb)    — who is signed in ({ id, name?, email?, role? } | null)
 *   useUser()                 — the React hook over all of the above
 *   apiFetch(path, init?)     — fetch with the bearer attached (for your /api/<name> handlers;
 *                               plain fetch works too — anonymous calls need nothing)
 */
import { useCallback, useEffect, useState } from 'react';
import rawConfig from '../trivial.config.json';

export interface TrivialConfig {
  /** The Trivial project id — the data-API tenant key. */
  projectId: string;
  /** Base URL of the Trivial data API. EMPTY under the same-origin model (relative /api/data/*). */
  dataApiBaseUrl: string;
  /** Zitadel issuer (OIDC discovery base). Kept for reference/tooling — sign-in no longer needs it client-side. */
  authIssuer: string;
  /** Your project's PUBLIC OIDC client id (PKCE, no secret) — informational since the first-party flow. */
  authClientId: string;
  /** Your project's Zitadel org id — your app's own isolated user pool. */
  authOrg: string;
}

/** Widen the JSON's literal-typed empty strings to plain `string` (the placeholder is all ""). */
export const config: TrivialConfig = rawConfig as TrivialConfig;

/** True once the data API is wired (projectId injected at publish). */
export function isConfigured(): boolean {
  return Boolean(config.projectId);
}

/** True once end-user auth is provisioned (issuer + client + org injected at publish). */
export function isAuthConfigured(): boolean {
  return Boolean(config.authIssuer && config.authClientId && config.authOrg);
}

// ── preview detection (the canvas frame) ─────────────────────────────────────
// The workshop shell defines `__TRIVIAL_VIEWAS__` in the frame document and updates it whenever
// you change the view-as identity; its PRESENCE is the "I am in the preview" signal. Published
// bundles never have it.
interface ViewAsIdentity { userId: string | null; role: string | null }

function previewViewAs(): ViewAsIdentity | null {
  if (typeof window === 'undefined') return null;
  const v = (window as unknown as { __TRIVIAL_VIEWAS__?: ViewAsIdentity }).__TRIVIAL_VIEWAS__;
  return v && typeof v === 'object' ? v : null;
}

/** True inside the canvas preview frame (Draft users, mock data reality). */
export function isPreview(): boolean {
  return previewViewAs() !== null;
}

// ── token store ──────────────────────────────────────────────────────────────
// The sign-in page writes these exact slots before sending the visitor back. The profile
// slot exists because access-token JWTs carry no name/email (ID-token claims) — the page
// hands the display identity off beside the tokens.
const TOKEN_KEY = 'trivial.auth.tokens';
const USER_KEY = 'trivial.auth.user';

interface StoredTokens {
  access_token: string;
  refresh_token?: string;
  /** epoch ms when the access token expires. */
  expires_at: number;
}

function loadTokens(): StoredTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
  } catch {
    return null;
  }
}

function storeTokens(t: { access_token: string; refresh_token?: string; expires_in?: number }): void {
  const tokens: StoredTokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in ? t.expires_in * 1000 : 3600 * 1000),
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(tokens));
  notifyUserChanged();
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  grantedRole = null;
  grantedRoleSub = null;
  notifyUserChanged();
}

// ── sign-in / sign-out ───────────────────────────────────────────────────────
/**
 * Start sign-in. Published: navigates to the hosted sign-in page on this origin (`return_to`
 * brings the visitor back to the current page). Preview: asks the workshop to open the test-user
 * picker — pick a user there and your app re-renders as them.
 */
export async function signIn(): Promise<void> {
  if (isPreview()) {
    try { window.parent.postMessage({ type: 'trivial:request-sign-in' }, '*'); } catch { /* shell absent */ }
    return;
  }
  // `trivial dev` serves this same path itself and picks the identity locally, so on a
  // loopback origin the page below really does exist even though no user pool has been
  // provisioned yet. Checked at runtime off the hostname rather than through a bundler flag:
  // the dev server is 127.0.0.1-only with a validated Host header, and a published origin can
  // never be loopback, so the explanatory throw is unchanged everywhere it matters.
  const onLocalDev = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
  if (!isAuthConfigured() && !onLocalDev) {
    throw new Error(
      'Sign-in is not enabled for this project yet. Declare a non-public table in the Data app and publish — Trivial provisions your app\'s user pool at publish.',
    );
  }
  const returnTo = window.location.pathname + window.location.search + window.location.hash;
  window.location.assign(`/__trivial/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`);
}

/**
 * End the session. Published: drops the stored tokens (the bearer is the only session there is).
 * Preview: asks the workshop to reset view-as to signed-out.
 */
export function signOut(): void {
  if (isPreview()) {
    try { window.parent.postMessage({ type: 'trivial:request-sign-out' }, '*'); } catch { /* shell absent */ }
    return;
  }
  clearTokens();
}

// ── password reset / email verification (managed by Trivial) ─────────────────
/**
 * Trigger a password-reset email for `email` (if it's a registered account on this app). Trivial sends a
 * managed reset link to the address; the visitor follows it to a hosted page and sets a new password — you
 * don't build the reset UI. ENUMERATION-SAFE: this ALWAYS resolves and never reveals whether the address has
 * an account, so show a neutral message ("If that email has an account, a reset link is on its way."). No-op
 * in the canvas preview (there are no Live users to email).
 */
export async function sendPasswordReset(email: string): Promise<void> {
  if (isPreview()) return;
  if (!isAuthConfigured()) throw new Error('Sign-in is not enabled for this project yet.');
  await fetch('/__trivial/auth/password-reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ email }),
  }).catch(() => { /* enumeration-safe: never surface send state to the caller */ });
}

/**
 * Trigger a verification email for `email`. Same enumeration-safe, no-op-in-preview contract as
 * `sendPasswordReset`. The visitor confirms via the link; the hosted page marks their email verified.
 */
export async function sendVerificationEmail(email: string): Promise<void> {
  if (isPreview()) return;
  if (!isAuthConfigured()) throw new Error('Sign-in is not enabled for this project yet.');
  await fetch('/__trivial/auth/verify-email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ email }),
  }).catch(() => {});
}

// ── refresh (same-origin — the server proxies your project's client) ─────────
async function refresh(refreshToken: string): Promise<string | null> {
  const res = await fetch('/__trivial/auth/refresh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'omit',
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  storeTokens(data);
  // Refresh bundles may carry an id-only user (no profile claims in the tokens) —
  // never let one clobber the profile the sign-in page stored.
  if (data.user?.id && (data.user.name || data.user.email)) {
    try { localStorage.setItem(USER_KEY, JSON.stringify(data.user)); } catch { /* quota */ }
  }
  return data.access_token ?? null;
}

/**
 * The current end-user access token, or null when signed out. Refreshes transparently when the
 * token is within 30s of expiry and a refresh token is held; clears the store on failure. This is
 * the ONLY credential trivial-data / apiFetch attach to requests. Always null in preview (the
 * preview scopes data through the frame's test identity instead).
 */
export async function getToken(): Promise<string | null> {
  if (isPreview()) return null;
  const t = loadTokens();
  if (!t) return null;
  if (Date.now() < t.expires_at - 30_000) return t.access_token;
  if (t.refresh_token) {
    const next = await refresh(t.refresh_token).catch(() => null);
    if (next) return next;
  }
  clearTokens();
  return null;
}

// ── the user object ──────────────────────────────────────────────────────────
export interface TrivialUser {
  /** The user's stable id — the same id RLS scopes their rows to. */
  id: string;
  email?: string;
  name?: string;
  /** The user's granted role (you grant roles in the Data app), kept fresh from the platform's
   *  identity echo on every data response — so it appears after the first data call of a session
   *  and clears the same way on revoke. DISPLAY-ONLY: the server re-resolves authority from the
   *  grant store on every request; gate UI with it, never security. */
  role?: string;
}

/** Decode a JWT's payload for DISPLAY only — the server independently re-verifies every token. */
function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ── the granted-role echo (display-only) ─────────────────────────────────────
// Live issuance NEVER stamps a role into the token — roles live in the grant store and are
// resolved server-side per request — so `user.role` on the published wire comes from here: the
// platform echoes the resolved identity on every data response (X-Trivial-Identity), and
// trivial-data feeds it back. Self-healing on grant AND revoke (the next data call updates it);
// scoped to the CURRENT signed-in sub so a stale echo can never cross users.
let grantedRole: string | null = null;
let grantedRoleSub: string | null = null;
/** Internal — called by trivial-data with each response's parsed identity echo. */
export function __applyIdentityEcho(echo: { actingAs?: string | null; role?: string | null }): void {
  const t = loadTokens();
  if (!t) return; // signed out — nothing to heal
  const claims = decodeJwt(t.access_token);
  const sub = claims && typeof claims.sub === 'string' ? claims.sub : null;
  if (!sub || echo.actingAs !== sub) return; // echo for a different (or no) identity — ignore
  const next = typeof echo.role === 'string' && echo.role ? echo.role : null;
  if (grantedRole === next && grantedRoleSub === sub) return;
  grantedRole = next;
  grantedRoleSub = sub;
  notifyUserChanged();
}

function userFromToken(t: StoredTokens | null): TrivialUser | null {
  if (!t) return null;
  const claims = decodeJwt(t.access_token);
  if (!claims || typeof claims.sub !== 'string') return null;
  // The stored profile (written by the sign-in page / refresh) carries name/email —
  // the access token itself doesn't. The token's sub stays authoritative for id.
  let profile: { id?: string; name?: string; email?: string } = {};
  try { profile = JSON.parse(localStorage.getItem(USER_KEY) || '{}'); } catch { /* ignore */ }
  const matches = profile.id === claims.sub;
  const role = grantedRoleSub === claims.sub && grantedRole ? grantedRole : undefined;
  return {
    role,
    id: claims.sub,
    email: (matches ? profile.email : undefined) ?? (typeof claims.email === 'string' ? claims.email : undefined),
    name: (matches ? profile.name : undefined) ?? (typeof claims.name === 'string' ? claims.name : undefined),
  };
}

function userFromViewAs(v: ViewAsIdentity): TrivialUser | null {
  // Honest to the app's own data plane: your app NEVER has a sees-all mode (run parity — the
  // workshop's Owner lens scopes the app's fetches as an anonymous visitor; sees-all belongs to
  // the Data app only). So both owner-default (null) and anonymous ('') read as signed out here;
  // a picked Draft user is the only signed-in preview identity.
  if (v.userId === null || v.userId === '') return null;
  return { id: v.userId, name: v.userId, role: v.role ?? undefined };
}

/** The signed-in user, or null. Preview: reflects the frame's test identity. Synchronous. */
export function getUser(): TrivialUser | null {
  const v = previewViewAs();
  if (v) return userFromViewAs(v);
  return userFromToken(loadTokens());
}

// ── change subscription ──────────────────────────────────────────────────────
type UserListener = (user: TrivialUser | null) => void;
const listeners = new Set<UserListener>();
let wired = false;

function notifyUserChanged(): void {
  const user = getUser();
  listeners.forEach((cb) => { try { cb(user); } catch { /* listener's problem */ } });
}

function wireGlobalEvents(): void {
  if (wired || typeof window === 'undefined') return;
  wired = true;
  // Preview: the shell fires this on every view-as change.
  window.addEventListener('trivial:identity', notifyUserChanged);
  // Published: another tab signed in/out (the sign-in page itself returns via a full navigation,
  // so same-tab pickup happens on mount; this covers multi-tab coherence).
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY) notifyUserChanged();
  });
}

/**
 * Subscribe to sign-in state. Fires with the current user immediately, then on every change
 * (sign-in, sign-out, test-identity switch in preview). Returns the unsubscribe.
 */
export function onUser(cb: UserListener): () => void {
  wireGlobalEvents();
  listeners.add(cb);
  try { cb(getUser()); } catch { /* listener's problem */ }
  return () => { listeners.delete(cb); };
}

// ── authenticated fetch ──────────────────────────────────────────────────────
/**
 * `fetch` that attaches the visitor's bearer token — use it to call YOUR handlers
 * (`apiFetch('/api/todos')`). Anonymous when signed out (public routes still work). In preview the
 * frame's test identity rides along automatically, so the same call scopes correctly there too.
 * Plain `fetch` remains fine for public routes.
 */
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await getToken();
  const headers = new Headers(init?.headers);
  if (token && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  return fetch(path, { ...init, headers, credentials: 'omit' });
}

// ── React hook ───────────────────────────────────────────────────────────────
export interface UseUser {
  user: TrivialUser | null;
  loading: boolean;
  signIn: () => Promise<void>;
  signOut: () => void;
}

/**
 * React hook: the current end-user + `signIn`/`signOut`. Re-renders on every sign-in state
 * change — including test-identity switches in the canvas preview.
 */
export function useUser(): UseUser {
  const [user, setUser] = useState<TrivialUser | null>(() => getUser());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onUser(setUser);
    // Settle expiry/refresh once on mount (also picks up the sign-in page's fresh write).
    let active = true;
    void getToken().then(() => {
      if (active) {
        setUser(getUser());
        setLoading(false);
      }
    });
    return () => {
      active = false;
      unsub();
    };
  }, []);

  const signOutCb = useCallback(() => { signOut(); }, []);

  return { user, loading, signIn, signOut: signOutCb };
}
