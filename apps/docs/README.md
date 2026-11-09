# Rooq docs

The documentation site for Rooq. It's a standalone Next.js app with its own hostname.

```bash
pnpm dev:docs     # http://localhost:3300
pnpm --filter @rooq/docs build
pnpm --filter @rooq/docs start
```

## Where things are

- `content/*.md`: one file per page. `{{app_url}}`, `{{docs_url}}` and `{{support_email}}` are filled in when a page loads.
- `lib/manifest.ts`: page order, titles and descriptions. A page has to be listed here to exist.
- `lib/visibility.ts`: the table behind the "See Rooq as" control on the privacy page.
- `lib/deployment.ts`: contract addresses for the Contracts page. Fill in the three `null` addresses after the private broadcast.
- Search, `/llms.txt` and `/<page>.md` are generated from the same files.

## Hostname

The hostname is one value, `NEXT_PUBLIC_DOCS_URL`, read in `packages/config/src/sites.ts`. The default is `https://docs.rooq.trade`. The web app's docs links use the same value, so set it the same way on both apps.

Other values in that file are `NEXT_PUBLIC_APP_URL` (links back to the app) and `NEXT_PUBLIC_SUPPORT_EMAIL` (shown in the terms and privacy policy).

## DNS

The site is built to run on Vercel. Create a Vercel project with root directory `apps/docs`, add `docs.rooq.trade` under its Domains settings, then add this record in Namecheap under Domain List, Manage, Advanced DNS:

| Type | Host | Value | TTL |
| --- | --- | --- | --- |
| CNAME Record | `docs` | `cname.vercel-dns.com.` | Automatic |

If Vercel's Domains page shows a different target for your project, use the one it shows. A change of subdomain only needs a new `Host` value and a new `NEXT_PUBLIC_DOCS_URL`.
