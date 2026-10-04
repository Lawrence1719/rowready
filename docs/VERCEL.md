# Deploy RowReady on Vercel Hobby

Use two projects from the same Git repository: a static React app and a small NestJS API. CSV files stay in the browser; the API serves recipes and validates recipe settings. No database or storage service is required.

Vercel Hobby is free for personal, noncommercial use and has usage limits. This personal portfolio demo fits that scope; keep both projects on Hobby. [Hobby plan](https://vercel.com/docs/plans/hobby)

## Project settings

Import the repository twice in Vercel. The app directories contain `vercel.json` files that install all workspace dependencies and build `packages/shared` before Vercel builds either app. Commit these files along with the package manifests and lockfile. Configure these settings before deploying:

| Setting | Web | API |
| --- | --- | --- |
| Suggested project name | `row-ready` | `row-ready-api` |
| Root Directory | `apps/web` | `apps/api` |
| Framework Preset | Vite | NestJS |
| Node.js version | 22.x | 22.x |
| Install Command | Provided by `apps/web/vercel.json` | Provided by `apps/api/vercel.json` |
| Build Command | `npm run build` | Default; leave override off |
| Output Directory | `dist` | Default; leave override off |

For **both** projects, enable **Include source files outside of the Root Directory in the Build Step**. This makes the root lockfile and `packages/shared` available. The repository root contains the only `package-lock.json`. [Monorepo setup](https://vercel.com/docs/monorepos), [shared packages](https://vercel.com/docs/monorepos/monorepo-faq#can-i-share-source-files-between-projects-are-shared-packages-supported)

Both config files use this Install Command, executed from their app directory:

```sh
cd ../.. && npm ci --include=dev && npm run build -w @rowready/shared
```

The extra build creates `packages/shared/dist` before either framework resolves `@rowready/shared`. Keep development dependencies installed because the TypeScript compiler is needed. These commands are specific to this repository's npm workspace layout. [Build settings](https://vercel.com/docs/builds/configure-a-build)

NestJS uses the conventional `apps/api/src/main.ts` entry point and `app.listen()`. Vercel builds that entry point into one Function. Do not configure `dist` as a static API output directory. [NestJS deployment guide](https://vercel.com/kb/guide/ship-a-nestjs-app-on-vercel)

The API config explicitly sets `framework` to `nestjs`. If a previously created project reports a missing `public` output directory, open its Build and Deployment settings, select **NestJS**, and turn off the **Build Command** and **Output Directory** overrides. Keep the Root Directory at `apps/api`, then deploy the updated commit. The API uses Vercel's NestJS runtime rather than a static output folder.

## Connect the projects

1. Deploy the API first. Copy its stable production origin, such as `https://row-ready-api.vercel.app`.
2. In the **web** project's Production environment variables, set `VITE_API_URL` to that origin, without `/api` or a trailing slash.
3. Deploy the web project. Use its actual production origin for the API project's `WEB_ORIGINS`, for example `https://row-ready.vercel.app`.
4. Redeploy the API after changing `WEB_ORIGINS`. Redeploy the web app after changing `VITE_API_URL`, because Vite embeds it at build time.

`WEB_ORIGINS` accepts comma-separated, exact origins, with no URL paths or trailing slashes. For local development it allows `http://localhost:5173` and `http://127.0.0.1:5173` by default. It is a CORS allowlist, not authentication. `VITE_API_URL` is public browser configuration; never put a secret in a `VITE_*` variable. [Vite environment variables](https://vite.dev/guide/env-and-mode)

For Preview deployments, configure `VITE_API_URL` in the Preview environment too. Add the specific preview frontend origin to the API allowlist when testing it. A Vercel-protected API preview will require separate access configuration; use the public production recipe API for a simple portfolio preview. The bundled recipe catalog keeps CSV work available when the API cannot be reached.

The desired `row-ready.vercel.app` name is subject to availability. Confirm the assigned domain in the web project's Domains settings; the examples above are not reserved URLs. Vercel provides a free `vercel.app` domain for deployments. [Generated domains](https://vercel.com/docs/deployments/generated-urls)

## Verify the deployment

- Open the API's `/api/health`, `/api/recipes`, and `/api/docs`.
- Open RowReady, choose a recipe, preview the sample cleanup, apply it, undo it, and export a CSV.
- Import a local CSV and inspect the browser Network panel: requests may include recipe settings, but must never contain file names, headers, or cell values.
- Check the Vercel build and function logs if the API fails. A missing `@rowready/shared/dist` usually means the outside-root option or shared build command was omitted.

The settings above are prepared from the current official documentation; a successful local build does not by itself verify a deployed Vercel Function.

## Search indexing and link previews

The frontend SEO metadata targets `https://rowready-web.vercel.app/`.
No additional environment variables or database are required. The HTML includes
a canonical URL, search description, Open Graph/Twitter previews, and WebApplication
structured data. Public assets include `/robots.txt`, `/sitemap.xml`, and
`/social-preview.png`.

After deployment, verify your frontend property in Google Search Console and
submit `https://rowready-web.vercel.app/sitemap.xml`. Indexing is controlled by
search engines and is not immediate. The workbench is a client-rendered application;
metadata is available in the initial HTML, while interactive content requires JavaScript.

If the frontend domain changes, update the URLs in `apps/web/index.html`,
`apps/web/public/robots.txt`, and `apps/web/public/sitemap.xml` together.
The API domain is not the canonical website URL.
