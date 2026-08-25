# AGENTS.md - building this Trivial web app

You are working in a **Trivial** project: real Vite + React + TypeScript source that publishes to a
live web app. Edit these files directly. This file orients any coding agent (Claude Code, Cursor,
Copilot) to the conventions that keep your work working. Read it first. Deeper references are linked
at the end.

## Read these first - the rules that keep you from fighting the platform

**This is a Trivial app, not a bare Vite app.** Do not add another framework or a separate backend
(no Next.js, no Express, no standalone API server, no Prisma). The backend is the `handlers/` folder,
reached through `ctx`. The database and user accounts are *declared*, not wired. Do not add build or
deploy scripts. Use `trivial dev` for the supported local runtime; a local server is not a deploy,
and publishing happens through Trivial.

**Data: declare it, never wire it.** Tables live in `src/trivial.manifest.json` - top level MUST
carry `"version": 1`, and `tables`/`columns` are OBJECTS KEYED BY NAME, never arrays. The exact
shape:

```json
{
  "version": 1,
  "tables": {
    "posts": {
      "access": "public",
      "insert": "anyone",
      "columns": { "author": "text", "message": "text" }
    },
    "todos": {
      "access": "owner",
      "ownerColumn": "created_by",
      "columns": { "title": "text", "done": "boolean" }
    }
  }
}
```

The platform generates ALL row security from that manifest. **Never write SQL, RLS policies,
migrations, or a database driver.** Model changes at publish are additive: nothing is dropped,
and a rename is old-kept + new-empty - data does not move. Read and write only through the vendored SDK:
- In a component: `const { rows, loading, error, insert, update, remove } = useTable('todos')`.
- Elsewhere: `db.from('todos')` (`.select()` / `.insert()` / `.update()` / `.delete()`).

**Narrow the read in the DATABASE, not in the component.** Both `useTable` and
`.select()` take `{ where, sort, order, limit, count }`:

```ts
const { rows, total } = useTable('products', {
  where: { in_stock: true, price: { lte: 2000 }, title: { contains: query } },
  sort: 'price', order: 'asc', limit: 20, count: true,
})
```

Operators: `eq` `ne` `gt` `gte` `lt` `lte` `in` `contains` — a bare value means
equals, `null` means "empty", and `contains` is a case-insensitive substring
match on a text column (the search box). `count: true` adds `total`, the number
of matching rows. `select()` returns `nextCursor`; pass it back as `cursor` for
the next page and never construct one yourself.
`rows.filter(...)` in a component filters only the page you fetched, so it drops
matches that were on the next one — reach for `where` instead.
Rows are typed from `src/lib/trivial-tables.ts` (regenerated on every manifest save; every
declared column is nullable in TS, `id` is a number, `created_at` an ISO string). RLS scopes rows
server-side; **never filter rows by the current user in app code.**

**The access vocabulary is closed.** Each table in the manifest declares an `access`:
- `public` - everyone reads; by default all writes are denied (the owner curates rows in the Data
  app). Two optional public-only keys change that:
  - `write` - who may write from the LIVE app: `"admin"` (the maker signed into their own app with
    the admin grant - a blog, a menu, a catalogue), `"owner"` + `ownerColumn` (any signed-in user
    may create, each edits only their own - a forum, listings), `"authenticated"`, or `"role"` +
    `role`.
  - `visibleWhen: { "column": <a declared text|boolean column>, "equals": <literal> }` - only
    matching rows are served to readers; rows that do not match (including NULL - unset means
    draft) stay visible to whoever can write them, plus admin. This is THE way to do
    drafts/published - a status column your UI filters on hides nothing (see below).
- `authenticated` - any signed-in end-user.
- `owner` + `ownerColumn` - each end-user sees only their own rows (the platform stamps the owner;
  never set it yourself).
- `role` + `role`, or `managed` + `ownerColumn` (owner-or-admin).
- `group` + `groupColumn` + `membershipTable` - a TEAM's rows, shared by everyone in it (a shared
  workspace, a company account, a family plan). The membership table says who is in which team; it
  must declare `ownerColumn` and must NOT be writable by end-users (`write: "server"` or
  `"admin"`), because whoever can write it can join any team. Publishing refuses it otherwise.
- `insert: 'anyone'` - the one modifier that lets signed-out people CREATE rows (a guestbook /
  contact form). Valid only with `public` or `owner`. For a signed-out-write form, add a hidden field
  named `_hp` (a honeypot); the platform silently drops bot submissions that fill it.
Anything outside this vocabulary is rejected at write.

**Names are `snake_case`.** Table and column names are lowercase `snake_case` (`client_projects`,
`created_by`), never camelCase (Postgres folds it and the data layer 404s). Do not declare `id` or
`created_at` - they are implicit. Some names are reserved and rejected.

**Server routes** live in `handlers/<name>.ts` and answer `/api/<name>` (lowercase letters,
digits, dashes or underscores - so `handlers/blog_posts.ts` owns `/api/blog_posts`). Export a named
`function buildApp(ctx)` returning a Hono app; reach data through `ctx` only
(`ctx.list` / `ctx.insert` / `ctx.update` / `ctx.remove`). You may import any package this project declares in `package.json`, plus your own project
files — add a dependency the ordinary way and a route can use it. Never a Node builtin
(`fs`/`net`/`child_process`/…) or a database driver. In a handler, these are refused at write: `eval`, `Function`,
`process`, `require`, `importScripts`, `WebSocket`, `XMLHttpRequest`, and the global objects
`globalThis` / `global` / `self` / `window` (pages are a normal browser app and may use `window`
freely - this list is handlers only). Ordinary `fetch` DOES work and is the project's egress
channel, so third-party SDKs work as written - but it reaches only services enabled for this
project (Site tab, External services), and anything else is refused with `egress blocked`.
Enabling a service and setting its key are separate steps. API keys go in project secrets, read as
`ctx.secrets.NAME` - never written into source. The egress lock applies to handlers only (pages
are a normal browser app and may call public APIs). Reserved route names
(data, auth, admin, login, webhooks, health, and similar) are refused. Handlers are
request/response only - no timers outliving the request, no cron. Full contract:
`handlers/README.md`.

**Sign-in** uses the vendored `trivial-auth` toolkit (`src/lib/trivial-auth.ts`):
`signIn` / `signOut` / `getUser` / `onUser` / `useUser` / `sendPasswordReset`. `signIn()` navigates
to the hosted sign-in page on the app's own origin (registration happens there too) and brings the
visitor back - it resolves with no value, so read the user via `useUser()` / `getUser()`; in the
workshop preview it opens the test-user picker. Build the sign-in button and the
signed-in/out states - never password forms. Auth turns on when a non-public table is declared.

**Design** uses the shipped design system - semantic tokens only (`bg-background`, `text-foreground`,
`bg-primary`), never raw Tailwind colors and never AI-indigo. Full rules: `DESIGN.md`.

**Dependencies.** A curated pool of popular libraries (framer-motion, lucide-react, recharts,
zustand, @tanstack/react-query, react-hook-form, zod, date-fns, three, and the common Radix
primitives) auto-installs on any plan when you import it and save (the full pool list ships in
the docs: https://docs.trivial.so/md/reference/dependencies.md). Packages outside the pool work
within the plan's dependency quota:
Plus auto-installs them on save; Basic installs them on an explicit Build or Publish. Handlers
resolve their imports from what this project declares in `package.json`, not from the pool.

**Ownership.** These files ARE the app's real source, in an open format. You edit them in place.
The `trivial` CLI can create or clone the project into a folder, run it locally with its data, move
Draft changes both ways (`pull`, `push`, `sync`), review proposals, build, and Publish. The project
also exposes an authenticated Git remote. For a one-way copy, Site -> Download source gives a
`.tar.gz` that runs with `pnpm install && pnpm dev`. The maker owns and keeps every file.

## The guardrails enforce this

The platform checks these at write and publish (the manifest validator, the handler contract, the
write guard). If you break a rule, the write is rejected with the rule and the line - read it, fix,
and rewrite. Docs guide; the platform enforces. So when in doubt, make the smallest change and let
the build tell you.

## Where things are

- `src/pages/*.tsx` - your pages (the app's routes). `src/pages/index.tsx` is `/`; the starter also
  ships `src/pages/entries.tsx` (`/entries`), a sign-in-gated page where each user saves and sees
  their own rows. Everything in the starter is deliberately unbranded placeholder ("Placeholder",
  "Your important text") - rename, reshape, or delete freely; nothing in it is a direction.
- `src/components/shell.tsx` - the shared header/nav/footer shell both starter pages wrap in. The
  Sign in button lives here.
- `src/trivial.manifest.json` - the data model (tables + access). The starter declares one
  owner-scoped `entries` table; edit or remove it like anything else.
- `src/lib/trivial-data.ts` - the data SDK (`useTable`, `db`). `src/lib/trivial-tables.ts` - generated row types.
- `src/lib/trivial-auth.ts` - the auth toolkit.
- `handlers/` - server routes (see `handlers/README.md`).
- `jobs/` - work that runs on a schedule, with no URL (see `jobs/README.md`).
- `DESIGN.md` - the design system (read before styling).
- `src/components/ui/` - shared components.

## The stack

Vite 6 + React 19 + TypeScript + Tailwind. Output is a fast static build, plus the dynamic run-layer
(data, auth, server handlers) when the manifest declares it. You never configure the toolchain: edit
source, and the platform builds it.

---

*Canonical build knowledge is single-sourced with Trio (Trivial's built-in AI), so this file, Trio,
and the human docs stay in sync. Full docs: https://docs.trivial.so*

> **A `public` table is public to the internet, row for row — unless you declare otherwise.**
> Without `visibleWhen`, `access: "public"` compiles to a `SELECT USING (true)` policy, and
> `GET /api/data/<projectId>/<table>` has no authentication at all — anyone with the project id
> (which ships in your published bundle) can read **every row**, regardless of what your UI renders.
> A `status`/`draft` column your UI filters on hides **nothing** by itself.
>
> The supported pattern for drafts is row security, not UI filtering:
>
> ```jsonc
> { "access": "public", "write": "admin",
>   "visibleWhen": { "column": "status", "equals": "published" } }
> ```
>
> Now only `status = "published"` rows are served to the world; drafts (any other value, or unset)
> are visible only to whoever can write them, plus admin — and the author edits from the live app
> by signing into it with the admin grant. "The world reads, the author writes" is `write`, with or
> without `visibleWhen`. If some rows must stay private from a different audience shape, a separate
> `access: "owner"` table still works.
