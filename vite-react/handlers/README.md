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
- **Your reads are scoped to whoever called the route**, the same as they are in a page. A handler
  does not see more than its caller just by being server code.

  One exception, and you opt into it: a table declared `access: "owner"` **with `write: "server"`**
  can be read WHOLE by the server, because that is what lets a webhook find the order it has to mark
  paid when there is no signed-in buyer to scope by. Ask for it and it is yours:

  ```ts
  const mine = await ctx.list('orders');                       // the caller's rows
  const one  = await ctx.list('orders', {                       // the server's view - on purpose
    where: { stripe_id: id }, as: 'server',
  });
  ```

  Only `'server'` turns it on; a typo leaves the read scoped, which is the safe way to fail.
- `ctx.batch([...ops])` runs several writes in ONE transaction — all of them
  commit or none do. Reach for it when two writes must not be able to
  half-happen: taking payment and recording fulfilment, the two sides of a
  transfer. Results come back positionally, and a failure names which op failed.
- `ctx.user` is who is calling: `{ id, role }`, or `null` when the request is
  anonymous. The id comes from the visitor's verified token, never from
  anything the request can claim, and it is the same identity your `ctx` reads
  and writes are scoped to — so it is what you check when the rule is "only a
  member may do this". Handle the `null` case: most requests have no user.
- `ctx.site` is your app's own address, e.g. `https://yourhandle.trivial.build`. Use it
  for anything that has to point back here — a payment provider's return
  URL, a redirect, a link in an email. The request itself cannot tell you:
  your code runs behind a proxy, so its own URL is a loopback address.
- `ctx.batch([...])` takes operation SPECS and runs them in one transaction. It does not take
  `ctx.insert()` promises, and `Promise.all` is not atomic:

  ```ts
  const [note, audit] = await ctx.batch([
    { op: 'insert', table: 'notes', values: { title, status: 'pending' } },
    { op: 'insert', table: 'audit', values: { action: 'submitted' } },
  ]);
  ```

  Up to 20 ops are allowed. A failure throws with `batchIndex` and rolls the whole transaction back.
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

## Two people writing the same row

`ctx.update(table, id, values, { where })` writes only if the row still matches — a
compare-and-set, and how you claim a seat or take the last item without handing it
out twice.

**A lost race THROWS** (status `412`, code `RUN_DATA_PRECONDITION`). It does not
return `null`. Catch it, re-read, decide again, and bound the loop:

```ts
try {
  await ctx.update('seats', id, { taken_by: who }, { where: { taken_by: null } });
} catch (e) {
  if (e.status !== 412) throw e;   // a real failure, not a lost race
  // somebody got there first — read again and re-decide
}
```

Then check you actually succeeded. A handler with the wrong branch upholds every
invariant and sells one item out of ten, silently — a shop that has stopped selling
looks exactly like a shop with no customers.

## Streaming, and the one rule that comes with it

Answer with `content-type: text/event-stream` and the platform pipes your response
through instead of buffering it.

**Write anything you need to keep BEFORE the stream starts.** When the client stops
reading — which every well-behaved client does once it has what it came for — the
connection closes and your handler is torn down with it. Code after the last byte may
never run, so metering, logging and cleanup belong before the first byte.

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
