# handlers/ — your project's server routes

Each file here owns ONE route: `handlers/<name>.ts` answers `/api/<name>`
(lowercase letters, digits, dashes or underscores — so a snake_case table like
`blog_posts` can own its route 1:1). Every `.ts` file in this folder
is treated as a live route and must export the contract below — keep drafts
elsewhere.

The contract (enforced automatically at write and publish):

- export a NAMED `function buildApp(ctx)` returning a Hono app; register
  routes with the full `/api/<name>` prefix.
- imports: `hono`, `drizzle-orm`, `zod`, `nanoid`, `date-fns`, and your own
  project files only. No node builtins, no fetch/eval/process.
- data goes through `ctx` ONLY — `ctx.list(table, {cursor?, limit?})`,
  `ctx.insert(table, values)`, `ctx.update(table, id, values)`,
  `ctx.remove(table, id)`. No raw SQL, no DB drivers. Rows are scoped by the
  access declared in `src/trivial.manifest.json` — the platform generates
  all row security; never write policies yourself.

Example (`handlers/notes.ts` → `/api/notes`):

```ts
import { Hono } from 'hono';

export function buildApp(ctx) {
  const app = new Hono();
  app.get('/api/notes', async (c) => c.json(await ctx.list('notes', { limit: 50 })));
  return app;
}
```

In the workshop this runs against build-side data; published, the same code
runs server-side. Same wire, same behavior.

## Calling your routes from pages

```ts
import { apiFetch } from '../src/lib/trivial-auth';

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
