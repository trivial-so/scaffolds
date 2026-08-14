# Trivial scaffolds

The starting point [Trivial](https://trivial.so) writes into a new project — published here so you
can read it before you sign up, and so changes to it are visible.

`vite-react/` is what `trivial create` gives you today: real Vite + React + TypeScript source, file-based
routes, Tailwind, a small set of shadcn-style components, and two vendored libraries that talk to the
platform's data and end-user auth. No hidden runtime, no proprietary framework — the files in this repo
are the files in your project, and you own them from the first commit.

## What's in it

```
vite-react/
├── src/pages/            file-based routes — index.tsx is /
├── src/components/       shell + shadcn-style UI primitives
├── src/lib/trivial-data.ts    read/write your project's data (RLS-backed, end-user scoped)
├── src/lib/trivial-auth.ts    end-user sign-in for your app's visitors
├── src/trivial.manifest.json  declare your tables here; the platform provisions them
├── handlers/             optional server-side routes
├── AGENTS.md             the build conventions, written for your coding agent
└── vite.config.ts        publishes from build/
```

The two `trivial-*.ts` libraries are vendored on purpose: they are dependency-free fetch wrappers you
can read end to end, and the only credential either one attaches is your visitor's own bearer token.

## Using it

The scaffold is designed to arrive with a project attached, which is what makes data, auth and publishing
work:

```sh
curl -fsSL https://trivial.so/cli/install.sh | sh
trivial login
trivial create my-app
```

You can also clone this repo directly and run `pnpm install && pnpm dev` to read the code and click
around. Data and sign-in stay dormant in that mode — both need a project id, which the platform issues.

## How this repo relates to the platform

The platform is the source of truth: this repo is generated from it on release, and a check fails our
deploy if the two ever differ. That is deliberate — the scaffold ships into every new project, so it has
to be reviewed and released the same way the rest of the product is.

Issues and pull requests are welcome. A PR gets applied upstream and lands here on the next sync rather
than being merged directly, so what you read here always matches what `trivial create` actually writes.

## License

MIT — see [LICENSE](./LICENSE). The scaffold is yours to keep, change, and ship.
