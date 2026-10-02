# Deploy on Vercel

Three projects already exist on the **adubank** team. After this lands on `main`, redeploy those projects. Do not create new projects, attach a database, or add a custom domain.

| Vercel project | URL | Root directory |
| --- | --- | --- |
| `vkyc-api` | https://vkyc-api.vercel.app | `apps/api` |
| `vkyc-agent` | https://vkyc-agent.vercel.app | `apps/agent-dashboard` |
| `vkyc-customer` | https://vkyc-customer.vercel.app | `apps/customer-webview` |

Install uses pnpm from the repo root (`packageManager` in the root `package.json`). The Vite projects set that install in their `vercel.json`. The API has no build step: Vercel bundles the Express app.

## API

Vercel loads `apps/api/index.ts`. That file imports Express and default-exports the app. `src/app.ts` is the route factory. It is not the entry: it has no default export, and an earlier deploy that loaded it did not boot.

`apps/api/vercel.json` sets Fluid compute and region `sin1` (Singapore).

- `app.listen` runs only when `VERCEL` is unset, on `127.0.0.1`.
- When `VERCEL` is set, the app sets `trust proxy` so `req.protocol` is the client protocol behind Vercel.
- Recording attach prefers `RECORDING_ATTACH_ORIGIN`. If that is unset and `VERCEL_URL` is set, attach uses `https://$VERCEL_URL`. Otherwise it uses `http://127.0.0.1:$PORT`.

Sessions, stills, and fallback recordings stay in memory on the Fluid instance. A new instance starts empty. There is no database.

Set these names on `vkyc-api` (values live in the Vercel project, not in git):

| Name | Production value |
| --- | --- |
| `CUSTOMER_APP_ORIGIN` | `https://vkyc-customer.vercel.app` |
| `CORS_ORIGINS` | `https://vkyc-agent.vercel.app,https://vkyc-customer.vercel.app` |
| `LIVEKIT_URL` | LiveKit WebSocket URL |
| `LIVEKIT_API_KEY` | LiveKit key |
| `LIVEKIT_API_SECRET` | LiveKit secret |
| `RECORDING_ATTACH_ORIGIN` | optional; unset uses `https://$VERCEL_URL` |
| `EGRESS_S3_BUCKET` | optional |
| `EGRESS_S3_REGION` | optional |
| `EGRESS_S3_ACCESS_KEY` | optional |
| `EGRESS_S3_SECRET` | optional |
| `EGRESS_S3_ENDPOINT` | optional |
| `EGRESS_S3_FORCE_PATH_STYLE` | optional |
| `EGRESS_FILEPATH` | optional |
| `EGRESS_PUBLIC_BASE_URL` | optional |
| `CRM_STUB_WEBHOOK_URL` | optional |
| `DATALAKE_STUB_WEBHOOK_URL` | optional |
| `DISPOSITION_STUB_LOG_PATH` | optional; the instance filesystem is ephemeral |

`VERCEL` and `VERCEL_URL` are set by Vercel.

## Agent and customer

Both are Vite static builds. `vercel.json` installs with `pnpm install --frozen-lockfile` from the repo root, then builds that workspace. The customer app rewrites unknown paths to `index.html` so `/join/<token>` loads the client.

Set these at build time on both `vkyc-agent` and `vkyc-customer`:

| Name | Production value |
| --- | --- |
| `VITE_API_BASE` | `https://vkyc-api.vercel.app` |
| `VITE_LIVEKIT_URL` | same WebSocket URL as `LIVEKIT_URL` |

Vite inlines `VITE_*` at build time. Change them, then redeploy the UI project.
