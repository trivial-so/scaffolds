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

/** Keep this privately BEFORE calling upload with it. It can be serialized for
 * recovery after reload; never put it in a URL, shared row, log or file reference.
 * The SDK does not persist it or rotate its token for you. */
interface UploadRequestFields {
  readonly token: string;
  readonly projectId: string;
  readonly endpoint: string;
  readonly userId: string | null;
}

/** Version 1 binds a Live caller; version 2 binds a Local storage epoch. */
export type UploadRequest = UploadRequestFields & (
  | { readonly version: 1 }
  | { readonly version: 2; readonly localEpoch: string }
);

export type UploadStatus =
  | { state: 'complete'; file: FileRef }
  | { state: 'retired'; code: 'RUN_BLOB_RETIRED' }
  | { state: 'removed'; code: 'RUN_BLOB_REMOVED' }
  | { state: 'unconfirmed'; code: 'RUN_BLOB_UNCONFIRMED' }
  /** Absence is only an observation: an earlier request may still commit. */
  | { state: 'not_found'; code: 'RUN_BLOB_REQUEST_NOT_FOUND' };

/** Thrown on any non-2xx data-API response. `status` mirrors the HTTP status.
 * `code`, when present, is the server's machine-readable outcome. A 503 alone
 * cannot distinguish confirmed cleanup from an unconfirmed upload. */
export class TrivialDataError extends Error {
  constructor(public readonly status: number, message: string, public readonly code?: string) {
    super(message);
    this.name = 'TrivialDataError';
  }
}

function responseError(status: number, data: unknown, fallback: string): TrivialDataError {
  const body = data as { error?: unknown; code?: unknown } | null | undefined;
  return new TrivialDataError(status,
    typeof body?.error === 'string' && body.error ? body.error : fallback,
    typeof body?.code === 'string' ? body.code : undefined);
}

// Same-origin: dataApiBaseUrl is '' → baseUrl() is '' → tableUrl() is the RELATIVE
// `/api/data/...`, which the browser resolves against the app's own <handle>.trivial.build origin
// (nginx proxies that location to the API workers). A non-empty value — the rejected cross-origin
// CORS fallback — is used verbatim with its trailing slash trimmed.
const baseUrl = (): string => config.dataApiBaseUrl.replace(/\/$/, '');
const tableUrl = (table: string): string =>
  `${baseUrl()}/api/data/${encodeURIComponent(config.projectId)}/${encodeURIComponent(table)}`;

function uploadPreview(): { userId: string | null } | null {
  // Read the existing preview signal; owned older auth files need no new export.
  const preview = typeof window === 'undefined' ? null
    : (window as unknown as { __TRIVIAL_VIEWAS__?: unknown }).__TRIVIAL_VIEWAS__;
  if (!preview || typeof preview !== 'object') return null;
  const userId = (preview as { userId?: unknown }).userId;
  if (userId == null || userId === '') return { userId: null };
  if (typeof userId !== 'string' || userId.length > 128) {
    throw new TrivialDataError(412, 'The Local upload caller could not be identified.', 'RUN_BLOB_REQUEST_IDENTITY');
  }
  return { userId };
}

function uploadEndpoint(): string {
  requireConfigured();
  return new URL(`${baseUrl()}/api/files/${encodeURIComponent(config.projectId)}`,
    typeof location === 'undefined' ? undefined : location.href).href;
}

const uploadEpoch = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

function assertLocalUploadEndpoint(endpoint: string): void {
  let sameOrigin = false;
  try { sameOrigin = typeof location !== 'undefined' && new URL(endpoint).origin === new URL(location.href).origin; } catch { /* Invalid retained URL refuses below. */ }
  if (!sameOrigin) {
    throw new TrivialDataError(412, 'Local uploads require the original project preview.', 'RUN_BLOB_REQUEST_SCOPE');
  }
}

function uploadUserId(token: string | null): string | null {
  if (!token) return null;
  // This binds the request to the credential actually sent, including a token
  // refreshed during getToken(). It grants no authority; the server verifies it.
  try {
    const encoded = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
    const payload = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof payload?.sub === 'string' && payload.sub) return payload.sub;
  } catch { /* Never turn an unreadable signed-in credential into anonymous. */ }
  throw new TrivialDataError(412, 'The upload caller could not be identified. Sign in again before preparing an upload.', 'RUN_BLOB_REQUEST_IDENTITY');
}

function retainedUploadRequest(value: UploadRequest): UploadRequest {
  if (!value || (value.version !== 1 && value.version !== 2)
    || (value.version === 2 && !uploadEpoch(value.localEpoch)) || typeof value.token !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.token) || typeof value.projectId !== 'string'
    || typeof value.endpoint !== 'string'
    || !(value.userId === null || (typeof value.userId === 'string' && value.userId))) {
    throw new TrivialDataError(400, 'Use the original request returned by prepareUpload().', 'RUN_BLOB_REQUEST_TOKEN');
  }
  // Copy before any await so caller-side mutation cannot redirect an in-flight
  // request or replace its token between the status check and the POST.
  const fields = { token: value.token, projectId: value.projectId, endpoint: value.endpoint, userId: value.userId };
  const request: UploadRequest = Object.freeze(value.version === 2
    ? { ...fields, version: 2 as const, localEpoch: value.localEpoch }
    : { ...fields, version: 1 as const });
  assertUploadScope(request);
  return request;
}

function assertUploadScope(request: UploadRequest): void {
  const preview = uploadPreview();
  if (request.version === 2) {
    if (!preview) throw new TrivialDataError(412, 'Open the original Local preview to continue this request.', 'RUN_BLOB_REQUEST_SCOPE');
    assertLocalUploadEndpoint(request.endpoint);
    if (request.userId !== null && request.userId !== preview.userId) {
      throw new TrivialDataError(412, 'Preview as the original upload caller to continue this request.', 'RUN_BLOB_REQUEST_IDENTITY');
    }
  } else if (preview) {
    throw new TrivialDataError(412, 'Open the original Live app to continue this request.', 'RUN_BLOB_REQUEST_SCOPE');
  }
  if (request.endpoint !== uploadEndpoint() || request.projectId !== config.projectId) {
    throw new TrivialDataError(412, 'Open the original app to check or send this upload request.', 'RUN_BLOB_REQUEST_SCOPE');
  }
}

async function uploadHeaders(request: UploadRequest): Promise<Record<string, string>> {
  assertUploadScope(request);
  const headers: Record<string, string> = { 'X-Trivial-Upload-Token': request.token };
  if (request.version === 2) {
    headers['X-Trivial-Upload-Epoch'] = request.localEpoch;
    headers['X-Trivial-Upload-Identity'] = JSON.stringify(request.userId).replace(/[^\x20-\x7e]/g,
      char => '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
    return headers;
  }
  // An original anonymous request remains anonymous even after sign-in. A
  // signed-in request requires that same user again, never another identity.
  if (request.userId !== null) {
    const token = await getToken();
    if (!token || uploadUserId(token) !== request.userId) {
      throw new TrivialDataError(412, 'Sign in as the original upload caller to continue this request.', 'RUN_BLOB_REQUEST_IDENTITY');
    }
    headers.Authorization = `Bearer ${token}`;
  }
  assertUploadScope(request);
  return headers;
}

function uploadFileRef(value: unknown): FileRef | null {
  if (!value || typeof value !== 'object') return null;
  const ref = value as FileRef;
  if (typeof ref.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(ref.id)
    || !(ref.name === null || typeof ref.name === 'string') || !Number.isSafeInteger(ref.size)
    || ref.size < 0 || typeof ref.type !== 'string' || !ref.type) return null;
  return { id: ref.id, name: ref.name, size: ref.size, type: ref.type };
}

async function readUploadStatus(request: UploadRequest, headers: Record<string, string>): Promise<UploadStatus> {
  assertUploadScope(request);
  const res = await fetch(`${request.endpoint}/uploads/status`, {
    method: 'GET', headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
  });
  const body = await res.json().catch(() => null);
  if (res.status === 404 && body?.code === 'RUN_BLOB_REQUEST_NOT_FOUND') {
    return { state: 'not_found', code: 'RUN_BLOB_REQUEST_NOT_FOUND' };
  }
  if (res.status === 404) {
    throw new TrivialDataError(412, 'This app runtime does not support recoverable uploads. Keep the original request.', 'RUN_BLOB_RECOVERY_UNAVAILABLE');
  }
  if (!res.ok) throw responseError(res.status, body, `Upload status failed (${res.status})`);
  if (res.status === 200 && body?.state === 'complete') {
    const file = uploadFileRef(body.file);
    if (file) return { state: 'complete', file };
  }
  if (res.status === 200 && body?.state === 'retired' && body.code === 'RUN_BLOB_RETIRED') {
    return { state: 'retired', code: 'RUN_BLOB_RETIRED' };
  }
  if (res.status === 200 && body?.state === 'removed' && body.code === 'RUN_BLOB_REMOVED') {
    return { state: 'removed', code: 'RUN_BLOB_REMOVED' };
  }
  if (res.status === 202 && body?.state === 'unconfirmed' && body.code === 'RUN_BLOB_UNCONFIRMED') {
    return { state: 'unconfirmed', code: 'RUN_BLOB_UNCONFIRMED' };
  }
  throw new TrivialDataError(502, 'The upload status response was invalid. Keep the original request.', 'RUN_BLOB_STATUS_INVALID');
}

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
    throw responseError(res.status, data, `Request failed (${res.status})`);
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

/** A bound query builder for a single table, typed from your manifest when the table name is one
 *  it declares — so `db.from('posts').select()` gives back `PostsRow[]`, not bare objects. A name
 *  the manifest doesn't know still works and falls back to `Row`. */
class TableQuery<T extends Row = Row> {
  constructor(private readonly table: string) {}

  /** Keyset-paginated read, filtered and ordered server-side. RLS scopes the result to the caller
   *  (own rows for owner tables; all for public). Returns an empty page when the project isn't wired
   *  yet (inert flag-off behaviour). */
  async select(opts: SelectOptions<T> = {}): Promise<Page<T>> {
    if (!isConfigured()) return { rows: [], nextCursor: null };
    return request<Page<T>>('GET', `${tableUrl(this.table)}${selectQuery(opts as SelectOptions)}`);
  }

  /** Insert a row. The owner column is stamped server-side from the verified token — any `owner` in
   *  `values` is ignored. Requires a configured project (throws otherwise). */
  async insert(values: Row): Promise<T> {
    requireConfigured();
    return request<T>('POST', tableUrl(this.table), values);
  }

  /** Update an owned row by id. RLS scopes which rows are visible/writable; `id`/`owner` are immutable. */
  async update(id: string | number, values: Row): Promise<T> {
    requireConfigured();
    return request<T>('PATCH', `${tableUrl(this.table)}/${encodeURIComponent(String(id))}`, values);
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
  from: <K extends keyof Tables | (string & {})>(table: K): TableQuery<RowOf<K & string>> =>
    new TableQuery<RowOf<K & string>>(table as string),

  /** Prepare and privately retain a request BEFORE sending its file:
   *
   *   const request = await db.prepareUpload()
   *   // Retain request in your app's private recovery state before continuing.
   *   const ref = await db.upload(file, undefined, request)
   *
   * A lost response can be checked with uploadStatus(request). Keep the same
   * request for that upload; a new token can create a second upload and charge.
   * Local requests also retain their device storage epoch; older runtimes refuse.
   */
  async prepareUpload(): Promise<UploadRequest> {
    const endpoint = uploadEndpoint(), projectId = config.projectId;
    const preview = uploadPreview();
    let localEpoch: string | undefined;
    const userId = preview ? preview.userId : uploadUserId(await getToken());
    if (preview) {
      assertLocalUploadEndpoint(endpoint);
      const response = await fetch(`${endpoint}/uploads/limits`, {
        credentials: 'omit', redirect: 'error', cache: 'no-store',
      });
      let limits: { protocol?: unknown; recoveryProtocol?: unknown; epoch?: unknown } | null = null;
      try { limits = await response.json(); } catch { /* Old runtimes must not accept bytes. */ }
      if (!response.ok && response.status !== 404) {
        throw responseError(response.status, limits, 'Local upload recovery could not be checked.');
      }
      if (response.status !== 200 || limits?.protocol !== 'local-file-intake-v1'
        || limits.recoveryProtocol !== 'local-file-receipts-v1' || !uploadEpoch(limits.epoch)) {
        throw new TrivialDataError(412, 'Recoverable Local uploads are unavailable. Reload the project before preparing a request.', 'RUN_BLOB_RECOVERY_UNAVAILABLE');
      }
      localEpoch = limits.epoch;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const token = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return retainedUploadRequest(localEpoch
      ? { version: 2, token, projectId, endpoint, userId, localEpoch }
      : { version: 1, token, projectId, endpoint, userId });
  },

  /** Observe the original request once, without replay or polling. A complete
   * result recovers its FileRef, not byte access or row attachment authority.
   * not_found is not proof of failure: an earlier request may still commit.
   * Original anonymous requests stay anonymous after sign-in; signed-in ones
   * require the original user. No credential or token is persisted by the SDK.
   */
  async uploadStatus(value: UploadRequest): Promise<UploadStatus> {
    const request = retainedUploadRequest(value);
    return readUploadStatus(request, await uploadHeaders(request));
  },

  /**
   * Upload a file and get the reference to save in a `file` column.
   *
   *   const ref = await db.upload(input.files[0])
   *   await db.from('posts').insert({ title, photo: ref })
   *
   * The Blob is sent as the request body. The Local runtime uses bounded buffering.
   * Save the returned reference to a row to attach the file to the app's data;
   * upload success alone does not confirm a row attachment.
   */
  async upload(file: Blob, name?: string, value?: UploadRequest): Promise<FileRef> {
    requireConfigured();
    const request = value === undefined ? null : retainedUploadRequest(value);
    const headers: Record<string, string> = {
      'Content-Type': file.type || 'application/octet-stream',
    };
    const label = name ?? (file as File).name;
    if (label) headers['X-Trivial-Filename'] = label;
    if (request) {
      const authorization = await uploadHeaders(request);
      Object.assign(headers, authorization);
      // Require the exact recovery contract before sending bytes. A missing receipt
      // is not proof of failure; the server's atomic token binding still decides
      // admission if an earlier POST races this explicit same-token attempt.
      const status = await readUploadStatus(request, authorization);
      if (status.state !== 'not_found') {
        throw new TrivialDataError(409, 'This request already has an upload outcome. Check uploadStatus() before starting another upload.', 'RUN_BLOB_REQUEST_EXISTS');
      }
      assertUploadScope(request);
    } else {
      const token = await getToken();
      if (token) headers.Authorization = `Bearer ${token}`;
    }
    const res = await fetch(request?.endpoint ?? `${baseUrl()}/api/files/${encodeURIComponent(config.projectId)}`, {
      method: 'POST', headers, credentials: 'omit', body: file,
      ...(request ? { redirect: 'error' as const, cache: 'no-store' as const } : {}),
    });
    const text = await res.text();
    let data: unknown;
    try { data = text ? JSON.parse(text) : undefined; } catch { data = undefined; }
    if (!res.ok) {
      throw responseError(res.status, data, `Upload failed (${res.status})`);
    }
    if (request) {
      const ref = res.status === 201 ? uploadFileRef(data) : null;
      if (!ref) throw new TrivialDataError(502, 'The upload response was invalid. Check the original request status before sending again.', 'RUN_BLOB_RESPONSE_INVALID');
      return ref;
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
    if (!res.ok) {
      const data: unknown = await res.json().catch(() => undefined);
      throw responseError(res.status, data, `Could not load the file (${res.status})`);
    }
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
