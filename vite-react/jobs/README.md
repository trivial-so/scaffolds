# jobs/ — work that runs on a schedule

A file here is a **job**: code the platform runs on a timer. Nobody can call it over the web — a
job has no URL at all — so this is where work belongs that should happen whether or not anyone is
using your app. A nightly digest, an hourly rollup, a sweep for bookings that need a reminder,
fetching something from another service and saving it.

```ts
// jobs/digest.ts
export const schedule = 'daily@09:00';

export async function run(ctx) {
  const { rows } = await ctx.list('orders', {
    where: { status: 'paid' },
    sort: 'created_at', order: 'desc', limit: 200,
  });
  await ctx.insert('digests', { orders: rows.length });
}
```

Two exports, both required:

- **`schedule`** — a plain string, one of:
  `15m` · `30m` · `1h` · `6h` · `12h` · `daily` · `daily@HH:MM`
  Always **UTC**. It has to be written out literally — the platform reads it without running your
  code, so `schedule = INTERVALS[0]` is refused.
- **`run(ctx)`** — what to do. The same `ctx` a route gets: `ctx.list` / `ctx.insert` / `ctx.update` /
  `ctx.remove` / `ctx.batch`, `fetch` through your project's egress policy, and `ctx.secrets`.

## What to expect

- **It runs at clock times**, not "every hour from whenever it last ran". `1h` fires at :00.
- **A slot can be missed, but never doubled.** If a run is still going when the next slot comes
  round, that slot is skipped — a job never overlaps itself, and downtime does not build a backlog
  of catch-up runs.
- **It stops if it takes too long**, the same way a route does, and your plan sets how long.
- **Nothing captures what `run` returns.** A job reports by *writing* — to your own tables, like
  anything else.
- **A job cannot be reached from the web.** If you also want a URL for the same work, put a route in
  `handlers/` and have both call a shared function. `handlers/` and `jobs/` share one name space, so
  you cannot have `handlers/digest.ts` and `jobs/digest.ts` at once.

## Seeing whether it worked

Because there is no URL to try, the platform records every run: when it last ran, when it runs next,
whether it succeeded, how long it took, and the error if it failed.

```
GET /api/projects/<projectId>/jobs
```

## Limits

Your plan caps how many jobs a project may have and how often the fastest one may run. Publishing
tells you straight away if a job asks for more than that, and names the schedule that would work
instead — it is never silently slowed down.
