# Your Trivial project

This is a [Trivial](https://trivial.so) web app — real Vite + React + TypeScript source that
publishes to a live site, with data and user accounts declared rather than wired.

- **Pages** live in `src/pages/` (file-based routes — `index.tsx` is `/`).
- **Data** is declared in `src/trivial.manifest.json` (create it when the app needs a table); read
  and write it through the vendored SDK (`src/lib/trivial-data.ts`). Sign-in is `src/lib/trivial-auth.ts`
  and turns on with the first non-public table. The starter declares none: it begins as one empty page.
- **Build conventions** (the rules that keep your work working): `AGENTS.md`.
- **Documentation**: https://docs.trivial.so

## Run it locally

```bash
pnpm install && pnpm dev
```

Or use the [`trivial` CLI](https://docs.trivial.so) to run it with its data, sync Draft changes
both ways, and publish: `trivial dev`.
