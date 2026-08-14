/**
 * trivial-data — the published app's END-USER data client.
 *
 * A dependency-free fetch wrapper over Trivial's RLS data API — GET/POST/PATCH/DELETE against
 * `/api/data/:projectId/:table[/:id]`.
 * VENDORED into the scaffold; the maker writes app code against `db`, never against raw fetch.
 *
 * ── THE SECURITY INVARIANT ───────────────────────────────────────────────────
 * The ONLY credential attached to a request is the END-USER's bearer token (from trivial-auth's
 * `getToken()`). There is NO project secret in the bundle. Requests are sent with
 * `credentials: 'omit'` — cookies are never used (and the api.trivial.so cookie can't reach
 * trivial.build anyway); the bearer token is the sole auth. Anonymous calls carry no token at all —
 * the server treats them as anonymous (public reads succeed; owner data stays invisible, owner writes
 * are rejected by RLS). Identity is the verified token's `sub`, never anything in the request body.
 *
 * RLS does the scoping server-side: `db.from('notes').select()` returns only the signed-in user's own
 * rows; a forged `owner` in an insert body is overwritten by the GUC default. The client cannot widen
 * its own access — that is the point of the substrate.
 *
 * Inert by default: with the empty placeholder config, `select()` returns an empty page and mutations
 * throw a clear "not configured" error, so the default scaffold renders cleanly with the flag off.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { config, isConfigured, getToken, onUser, __applyIdentityEcho } from './trivial-auth';
import type { Tables } from './trivial-tables';

/** The reserved honeypot field (anti-spam). Add a hidden
 *  `<input name={HONEYPOT_FIELD} tabIndex={-1} autoComplete="off" aria-hidden />`
 *  (off-screen) to visitor-write forms and pass its value to `.insert()`; the
 *  server silently drops anonymous submissions where it's filled. */
export const HONEYPOT_FIELD = '_hp';

export type Row = Record<string, unknown>;

export interface Page<T extends Row = Row> {
  rows: T[];
  /** Pass back as `select({ cursor })` for the next page; null when there are no more. */
  nextCursor: number | null;
}

export interface SelectOptions {
  cursor?: number | null;
  limit?: number;
}

/** Thrown on any non-2xx data-API response. `status` mirrors the HTTP status (e.g. 401, 403, 404). */
export class TrivialDataError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'TrivialDataError';
  }
}

// Same-origin: dataApiBaseUrl is '' → baseUrl() is '' → tableUrl() is the RELATIVE
// `/api/data/...`, which the browser resolves against the app's own <handle>.trivial.build origin
// (nginx proxies that location to the API workers). A non-empty value — the rejected cross-origin
// CORS fallback — is used verbatim with its trailing slash trimmed.
const baseUrl = (): string => config.dataApiBaseUrl.replace(/\/$/, '');
const tableUrl = (table: string): string =>
  `${baseUrl()}/api/data/${encodeURIComponent(config.projectId)}/${encodeURIComponent(table)}`;

async function request<T>(method: string, url: string, body?: Row): Promise<T> {
  const headers: Record<string, string> = {};
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`; // the ONLY credential — no project secret
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(url, {
    method,
    headers,
    credentials: 'omit', // never send cookies; the bearer token is the sole auth (D4 / D5)
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  // Feed the platform's identity echo back to the auth store: `user.role` on the
  // published wire comes from the grant store server-side, never the token, so this is what
  // keeps the documented `role` field true (and revoke-fresh) outside the preview.
  const echoHeader = res.headers.get('X-Trivial-Identity');
  if (echoHeader) {
    try { __applyIdentityEcho(JSON.parse(echoHeader)); } catch { /* diagnostic header — never fatal */ }
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const msg = (data as { error?: string })?.error || `Request failed (${res.status})`;
    throw new TrivialDataError(res.status, msg);
  }
  return data as T;
}

// The sign-in echo probe. The role heal above is response-driven, so a page that GATES
// before fetching (an admin page checking user.role on mount) would never receive it. On each
// sign-in (new sub), fire ONE lightweight data request purely for its identity echo — the table
// name is valid-but-nonexistent, so the server resolves identity, stamps the echo, and 404s;
// request() feeds the echo back and the gated UI re-renders with the fresh role.
let probedSub: string | null = null;
onUser((u) => {
  if (!u || !isConfigured() || probedSub === u.id) return;
  probedSub = u.id;
  void request('GET', tableUrl('identity_probe')).catch(() => { /* 404 expected — the echo is the point */ });
});

/** A bound query builder for a single table. */
class TableQuery {
  constructor(private readonly table: string) {}

  /** Keyset-paginated read. RLS scopes the result to the caller (own rows for owner tables; all for
   *  public). Returns an empty page when the project isn't wired yet (inert flag-off behaviour). */
  async select(opts: SelectOptions = {}): Promise<Page> {
    if (!isConfigured()) return { rows: [], nextCursor: null };
    const qs = new URLSearchParams();
    if (opts.limit != null) qs.set('limit', String(opts.limit));
    if (opts.cursor != null) qs.set('cursor', String(opts.cursor));
    const q = qs.toString();
    return request<Page>('GET', `${tableUrl(this.table)}${q ? `?${q}` : ''}`);
  }

  /** Insert a row. The owner column is stamped server-side from the verified token — any `owner` in
   *  `values` is ignored. Requires a configured project (throws otherwise). */
  async insert(values: Row): Promise<Row> {
    requireConfigured();
    return request<Row>('POST', tableUrl(this.table), values);
  }

  /** Update an owned row by id. RLS scopes which rows are visible/writable; `id`/`owner` are immutable. */
  async update(id: string | number, values: Row): Promise<Row> {
    requireConfigured();
    return request<Row>('PATCH', `${tableUrl(this.table)}/${encodeURIComponent(String(id))}`, values);
  }

  /** Delete an owned row by id (RLS-scoped). */
  async delete(id: string | number): Promise<void> {
    requireConfigured();
    await request<void>('DELETE', `${tableUrl(this.table)}/${encodeURIComponent(String(id))}`);
  }
}

function requireConfigured(): void {
  if (!isConfigured()) {
    throw new TrivialDataError(412, 'Trivial data is not configured for this project yet.');
  }
}

/** The data client. `db.from('notes').select() / .insert() / .update() / .delete()`. */
export const db = {
  from: (table: string): TableQuery => new TableQuery(table),
};

// ── useTable — the one-line React binding ────────────────────────────────────
//
// `const { rows, insert } = useTable('todos')` wires a component to a table:
// fetch on mount, refetch after your own mutations, and refetch when the
// signed-in user changes (so preview view-as / sign-in / sign-out all show the
// right rows). RLS scopes everything server-side — an `owner` table needs no
// user filtering in your code, ever.
//
// Types come from `./trivial-tables` (generated from src/trivial.manifest.json
// whenever you save the manifest): rows autocomplete your declared columns.
// Tables not in the manifest still work — their rows are just untyped.

/** Declared table names get autocomplete; any string is still allowed. */
type TableName = (keyof Tables & string) | (string & {});
type RowOf<K extends string> = K extends keyof Tables ? Tables[K] & Row : Row;

export interface UseTableResult<T extends Row> {
  rows: T[];
  /** True during the initial fetch (and any refetch that follows a user change). */
  loading: boolean;
  error: TrivialDataError | null;
  /** Insert, then refetch. The owner column is stamped server-side. */
  insert: (values: Row) => Promise<void>;
  /** Update an owned row by id, then refetch. */
  update: (id: string | number, values: Row) => Promise<void>;
  /** Delete an owned row by id, then refetch. */
  remove: (id: string | number) => Promise<void>;
  refetch: () => Promise<void>;
}

export function useTable<K extends TableName>(
  table: K,
  opts: { limit?: number } = {},
): UseTableResult<RowOf<K & string>> {
  type T = RowOf<K & string>;
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<TrivialDataError | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const limit = opts.limit;
  const refetch = useCallback(async () => {
    try {
      const page = await db.from(table).select(limit != null ? { limit } : {});
      if (!alive.current) return;
      setRows(page.rows as T[]);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof TrivialDataError ? e : new TrivialDataError(0, String(e)));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [table, limit]);

  // Initial fetch + refetch whenever the signed-in identity changes
  // (sign-in, sign-out, or the workshop's preview view-as switching).
  useEffect(() => {
    setLoading(true);
    void refetch();
    const off = onUser(() => { setLoading(true); void refetch(); });
    return off;
  }, [refetch]);

  const insert = useCallback(async (values: Row) => {
    await db.from(table).insert(values);
    await refetch();
  }, [table, refetch]);
  const update = useCallback(async (id: string | number, values: Row) => {
    await db.from(table).update(id, values);
    await refetch();
  }, [table, refetch]);
  const remove = useCallback(async (id: string | number) => {
    await db.from(table).delete(id);
    await refetch();
  }, [table, refetch]);

  return { rows, loading, error, insert, update, remove, refetch };
}
