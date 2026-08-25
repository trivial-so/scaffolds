# handlers/ — your project's server routes

Each file here owns ONE route: `handlers/<name>.ts` answers `/api/<name>`
(lowercase letters, digits, dashes or underscores — so a snake_case table like
`blog_posts` can own its route 1:1). Every `.ts` file in this folder
is treated as a live route and must export the contract below — keep drafts
elsewhere.

The contract (enforced automatically at write and publish):

- export a NAMED `function buildApp(ctx)` returning a Hono app; register
  routes with the full `/api/<name>` prefix.
- imports: any package this project declares in `package.json`, plus your own
  project files. No node builtins (`fs`/`net`/`child_process`/…), no database
  drivers, no `eval`/`process`/`require`/`WebSocket`/`globalThis`/`self`.
- outbound calls: ordinary `fetch` is this project's egress channel, so
  third-party SDKs work as written. It reaches only services enabled for this
  project (Site tab, External services); anything else is refused with
  `egress blocked`. It works only while handling a request.
- API keys: the project owner sets them as secrets and a route reads them as
  `ctx.secrets.NAME`. Never write a key into a file. Enabling a service and
  setting its key are two separate steps.
- data goes through `ctx` ONLY — `ctx.list(table, opts?)`,
  `ctx.insert(table, values)`, `ctx.update(table, id, values)`,
  `ctx.remove(table, id)`. No raw SQL, no DB drivers. Rows are scoped by the
  access declared in `src/trivial.manifest.json` — the platform generates
  all row security; never write policies yourself.
- `ctx.list` narrows in the DATABASE, so reach for it before you loop:
  `{ where, sort, order, limit, cursor, count }`.
  - `where` — `{ status: 'paid', price: { lte: 2000 }, id: { in: [1,2,3] } }`.
    Operators: `eq` `ne` `gt` `gte` `lt` `lte` `in` `contains`. A bare value
    means equals, and `null` means "empty". `contains` is a case-insensitive
    substring match on a text column — the search box.
  - `sort` — a column name; `order` is `'asc'` (default) or `'desc'`.
  - `count: true` also returns `total`, the number of matching rows.
  - `nextCursor` comes back with every page — hand it back as `cursor` to get
    the next one. Never build one yourself; a sorted page's cursor is opaque.
  Fetching rows and filtering them in JavaScript only ever filters the page you
  fetched, so it silently misses matches that were on the next one.

Example (`handlers/notes.ts` → `/api/notes`):

```ts
import { Hono } from 'hono';

export function buildApp(ctx) {
  const app = new Hono();
  app.get('/api/notes', async (c) => c.json(await ctx.list('notes', {
    where: { archived: false }, sort: 'created_at', order: 'desc', limit: 50,
  })));
  return app;
}
```

In the workshop this runs against build-side data; published, the same code
runs server-side. Same wire, same behavior.

## Calling your routes from pages

```ts
import { apiFetch } from '@/lib/trivial-auth';

const { rows } = await (await apiFetch('/api/notes')).json();
await apiFetch('/api/notes', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ body: 'hello' }),
});
```

`apiFetch` attaches the signed-in visitor's token (see `src/lib/trivial-auth.ts`
— `signIn()` / `useUser()` are there too). Plain `fetch` also works: signed-out
calls are anonymous, and row security decides what they can see. In the canvas
preview the frame's test identity rides along automatically — same code, both
worlds.
