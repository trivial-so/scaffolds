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
  /** Pass back as `select({ cursor })` for the next page; null when there are no more. Hand it back
   *  as you got it — it is a row id for an id-ordered page and an opaque token for a sorted one. */
  nextCursor: number | string | null;
  /** How many rows match in total (the whole filtered set, not just this page). Present only when
   *  you ask for it with `count: true` — it costs a second query, so it is never implicit. */
  total?: number;
}

/** A value a filter compares against. */
export type FilterValue = string | number | boolean | null;

/** The comparison operators. Use exactly one per column: `{ price: { lte: 2000 } }`. */
export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

/**
 * One column's condition. A bare value is equality — and `null` means "is empty", which is what
 * everyone means by `{ assigned_to: null }` (plain SQL equality against null matches nothing).
 */
export type Filter =
  | FilterValue
  | Partial<Record<FilterOp, FilterValue>>
  | { in: FilterValue[] }
  /** Case-insensitive substring match on a text column — the search box.
   *  `{ title: { contains: query } }`. What the visitor typed is matched literally, so a `%`
   *  is a percent sign rather than a wildcard. */
  | { contains: string };

/** `{ status: 'paid', price: { lte: 2000 } }` — every condition must hold (they are AND-ed).
 *  Declared columns autocomplete; the server rejects a column that does not exist. */
export type Where<T extends Row = Row> = Partial<Record<keyof T & string, Filter>>;

export interface SelectOptions<T extends Row = Row> {
  cursor?: number | string | null;
  limit?: number;
  /** Sort by a column — `{ sort: 'price', order: 'asc' }` for cheapest first. Without it, rows come
   *  back in the order they were created. Paging stays correct across a sort, including rows where
   *  the column is empty. */
  sort?: (keyof T & string) | (string & {});
  /** Filter server-side. The database does the work and the page you get back is already the answer
   *  — filtering `rows` in the browser only ever filters the page you happened to fetch. */
  where?: Where<T>;
  /** Direction: `'asc'` (the default) or `'desc'`. Applies to `sort` when you give one, and to the
   *  creation order when you don't — so `{ order: 'desc' }` alone is "newest first". */
  order?: 'asc' | 'desc';
  /** Also return `total` — the number of matching rows. One extra query; opt in when you need it. */
  count?: boolean;
}

/**
 * What a `file` column holds — a reference to bytes stored outside the database. You get one from
 * `db.upload()` and save it straight into the column; never build one by hand.
 *
 * There is no URL in it, on purpose: the right URL depends on who is asking, and a URL saved into a
 * row would outlive the access rule that justified it.
 */
export interface FileRef {
  id: string;
  name: string | null;
  size: number;
  type: string;
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

/**
 * Build the read query string. The filter travels as ONE parameter holding JSON, rather than as
 * `where[price][lte]=2000`, so its values keep their TYPES on the way to the server: 2000 stays a
 * number and null stays null. A bracket form would turn both into strings and the server would have
 * to guess which ones you meant as numbers.
 */
function selectQuery(opts: SelectOptions): string {
  const qs = new URLSearchParams();
  if (opts.limit != null) qs.set('limit', String(opts.limit));
  if (opts.cursor != null) qs.set('cursor', String(opts.cursor));
  if (opts.order != null) qs.set('order', opts.order);
  if (opts.sort != null) qs.set('sort', opts.sort);
  if (opts.count) qs.set('count', '1');
  if (opts.where && Object.keys(opts.where).length) qs.set('where', JSON.stringify(opts.where));
  const q = qs.toString();
  return q ? `?${q}` : '';
}

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

  /** Keyset-paginated read, filtered and ordered server-side. RLS scopes the result to the caller
   *  (own rows for owner tables; all for public). Returns an empty page when the project isn't wired
   *  yet (inert flag-off behaviour). */
  async select(opts: SelectOptions = {}): Promise<Page> {
    if (!isConfigured()) return { rows: [], nextCursor: null };
    return request<Page>('GET', `${tableUrl(this.table)}${selectQuery(opts)}`);
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

const fileUrlFor = (id: string): string =>
  `${baseUrl()}/api/files/${encodeURIComponent(config.projectId)}/${encodeURIComponent(id)}`;

/** The data client. `db.from('notes').select() / .insert() / .update() / .delete()`. */
export const db = {
  from: (table: string): TableQuery => new TableQuery(table),

  /**
   * Upload a file and get the reference to save in a `file` column.
   *
   *   const ref = await db.upload(input.files[0])
   *   await db.from('posts').insert({ title, photo: ref })
   *
   * The bytes are sent as the request body, so nothing is copied into memory first. Until you save
   * the reference to a row, the file is visible only to you — which is what lets you show a preview
   * before submitting.
   */
  async upload(file: Blob, name?: string): Promise<FileRef> {
    requireConfigured();
    const headers: Record<string, string> = {
      'Content-Type': file.type || 'application/octet-stream',
    };
    const label = name ?? (file as File).name;
    if (label) headers['X-Trivial-Filename'] = label;
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${baseUrl()}/api/files/${encodeURIComponent(config.projectId)}`, {
      method: 'POST', headers, credentials: 'omit', body: file,
    });
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (!res.ok) {
      throw new TrivialDataError(res.status, (data as { error?: string })?.error || `Upload failed (${res.status})`);
    }
    return data as FileRef;
  },

  /**
   * A plain URL for a file — use it directly in `<img src>` / `<a href>`.
   *
   * **This works for files whose row anyone can read** (a `public` table). It carries no credentials,
   * because an `<img>` tag cannot send them — so for a file on an `owner` or `authenticated` table,
   * use `fileObjectUrl` instead. Passing null gives null, so it is safe on an empty column.
   */
  fileUrl(ref: FileRef | null | undefined): string | null {
    return ref?.id ? fileUrlFor(ref.id) : null;
  },

  /**
   * A URL for a file that needs the signed-in user's credentials — an `owner` table's photo, say.
   *
   * Fetches the bytes with your token and hands back a local object URL. **Call `URL.revokeObjectURL`
   * when the element goes away**, or the bytes stay in memory for the life of the page.
   */
  async fileObjectUrl(ref: FileRef | null | undefined): Promise<string | null> {
    if (!ref?.id || !isConfigured()) return null;
    const headers: Record<string, string> = {};
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(fileUrlFor(ref.id), { headers, credentials: 'omit' });
    if (!res.ok) throw new TrivialDataError(res.status, `Could not load the file (${res.status})`);
    return URL.createObjectURL(await res.blob());
  },
};

// ── useTable — the one-line React binding ────────────────────────────────────
//
// `const { rows, insert } = useTable('todos')` wires a component to a table:
// fetch on mount, refetch after your own mutations, and refetch when the
// signed-in user changes (so preview view-as / sign-in / sign-out all show the
// right rows). RLS scopes everything server-side — an `owner` table needs no
// user filtering in your code, ever.
//
// Narrow it with `where` / `order` / `count`, and the DATABASE does the work:
//
//   const { rows, total } = useTable('products', {
//     where: { in_stock: true, price: { lte: 2000 } },
//     sort: 'price', order: 'asc', limit: 20, count: true,
//   })
//
// Reach for that rather than `rows.filter(...)` in the component: a page holds
// the rows you fetched, so filtering it in the browser silently drops matches
// that were on page two.
//
// Types come from `./trivial-tables` (generated from src/trivial.manifest.json
// whenever you save the manifest): rows autocomplete your declared columns.
// Tables not in the manifest still work — their rows are just untyped.

/** Declared table names get autocomplete; any string is still allowed. */
type TableName = (keyof Tables & string) | (string & {});
type RowOf<K extends string> = K extends keyof Tables ? Tables[K] & Row : Row;

export interface UseTableResult<T extends Row> {
  rows: T[];
  /** Matching rows in total, ignoring paging — only when you pass `count: true`. */
  total?: number;
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
  opts: {
    limit?: number;
    /** Filtered server-side — `useTable('orders', { where: { status: 'paid' } })`. */
    where?: Where<RowOf<K & string>>;
    /** Sort by a column: `{ sort: 'price', order: 'asc' }`. */
    sort?: (keyof RowOf<K & string> & string) | (string & {});
    order?: 'asc' | 'desc';
    /** Ask for `total` as well as the page. */
    count?: boolean;
  } = {},
): UseTableResult<RowOf<K & string>> {
  type T = RowOf<K & string>;
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<TrivialDataError | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const { limit, order, sort, count } = opts;
  // `where` is tracked by VALUE, not by identity. `useTable('orders', { where: { status: 'paid' } })`
  // builds a fresh object every render, so depending on the object itself would refetch forever —
  // the classic React filter loop, and the one thing that would make this hook unusable for exactly
  // the case it was added for.
  const whereKey = opts.where && Object.keys(opts.where).length ? JSON.stringify(opts.where) : '';
  const refetch = useCallback(async () => {
    try {
      const page = await db.from(table).select({
        ...(limit != null ? { limit } : {}),
        ...(whereKey ? { where: JSON.parse(whereKey) as Where } : {}),
        ...(order != null ? { order } : {}),
        ...(sort != null ? { sort } : {}),
        ...(count ? { count: true } : {}),
      });
      if (!alive.current) return;
      setRows(page.rows as T[]);
      setTotal(page.total);
      setError(null);
    } catch (e) {
      if (!alive.current) return;
      setError(e instanceof TrivialDataError ? e : new TrivialDataError(0, String(e)));
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [table, limit, whereKey, order, sort, count]);

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

  return { rows, total, loading, error, insert, update, remove, refetch };
}
