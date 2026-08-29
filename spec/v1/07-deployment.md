# 07 — Deployment

Two delivery modes:

1. **Docker (primary)** — what rokko self-hosts on a server or a coop
   laptop with Docker installed. M0 ships this.
2. **Desktop bundle (M4)** — a signed double-click installer that hides
   Docker entirely. Same codebase, different shell.

## Docker

### What's in the repo

- `Dockerfile` — multi-stage: `deps` (install pnpm deps) → `builder`
  (`pnpm build`) → `runner` (Node 20 slim with just the standalone output,
  static assets, migrations folder, and `mapping.config.json`).
- `docker-compose.yml` — single `app` service, port `3000:3000`, bind-mounts
  `./data` and the mapping config, healthcheck against `/api/health`.
- `.dockerignore` — excludes `node_modules`, `.next`, `data`, secrets, the
  spec/docs files we don't need at runtime.

### Quick start

```sh
cp .env.example .env
docker compose up -d --build
open http://localhost:3000
```

State lives in `./data` (SQLite database + uploaded CSVs + generated
exports). The mapping config is mounted read-only from
`./mapping.config.json` so editing it on the host and `docker compose
restart app` is enough — no rebuild.

### Image size

Final image is ~150 MB (Node 20 slim + Next.js standalone + native modules).
Targeting `node:20-bookworm-slim` rather than alpine because better-sqlite3
prebuilds for glibc are smoother than musl.

### Running migrations in production

`db:migrate` is **not** in the container `CMD`. Migrations are a deliberate
step. On first deploy and on any version bump that ships a new migration:

```sh
docker compose run --rm app node -e "import('./src/lib/db/migrate.js')"
```

(M2 may automate this into a sidecar init container — decision deferred.)

## Configuration

All runtime knobs are env vars, parsed and validated by
`src/lib/config.ts`. Missing or invalid → server refuses to start.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | `development` | `development \| test \| production` |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_URL` | `./data/r2c.db` | SQLite file path |
| `DATA_DIR` | `./data` | Uploads + exports + DB root |
| `ENRICH_CONCURRENCY` | `5` | Parallel books being enriched |
| `ENRICH_CACHE_TTL_DAYS` | `30` | Per-source cache lifetime |
| `ENRICH_TIMEOUT_MS` | `10000` | Per-source request timeout |
| `GOOGLE_BOOKS_API_KEY` | — | Optional, raises Google quota |
| `OPEN_LIBRARY_USER_AGENT` | `r2c-magic/0.1 (mailto:tech@rokko.coop)` | Required by Open Library policy |
| `INCLUDE_ERROR_COLUMN` | `true` | Append `_enrichment_errors` column |
| `ERROR_COLUMN_NAME` | `_enrichment_errors` | Override the column name |

When CB adapter lands (M3), add:

| `CB_API_BASE_URL` | — | CB Webservices base URL |
| `CB_API_USERNAME` | — | rokko's `aansluitnummer` |
| `CB_API_PASSWORD` | — | Webservice password |

## Self-hosting topology

Recommended for rokko's self-hosted install:

```
   Internet
      │
      ▼
  ┌───────────┐
  │  Caddy /  │   Handles TLS, basic auth if needed
  │  Nginx    │   (since R2C Magic has no auth in v1)
  └─────┬─────┘
        │  http://r2c-magic:3000
        ▼
  ┌───────────┐
  │ r2c-magic │   Docker container
  │  (this)   │
  └─────┬─────┘
        │
        ▼
   ./data volume
   (SQLite + CSVs)
```

The "no auth in v1" decision (spec/01-overview.md #6) assumes the reverse
proxy gates access. If exposing to the open internet, add basic auth at
the proxy.

## Backups

The entire app state is `./data/`. A daily `tar czf data-$(date +%F).tar.gz
./data/` is sufficient. SQLite + WAL files copy safely because we don't
need point-in-time consistency for what is a job log; the worst case is
losing in-flight runs.

## Desktop bundle (M4)

Planned approach:

- Tauri 2 shell project under `desktop/`.
- Tauri main process spawns `node server.js` (the Next.js standalone
  output) on a free local port at app start.
- Opens a WebView window pointed at `http://127.0.0.1:<port>`.
- Bundles per-target prebuilt `better-sqlite3` binaries.
- SQLite + uploads live in the OS app-data directory (auto-detected by
  Tauri) instead of `./data/`.

Per-OS installers via GitHub Actions on `v*` tags:

| OS | Installer |
|---|---|
| macOS | `.dmg` (universal binary, signed + notarized — secrets needed) |
| Windows | `.msi` (signed if cert provided, otherwise unsigned but warning-prone) |
| Linux | `.AppImage` (portable) and `.deb` for Debian-likes |

Decisions still to make in M4:

- Signing identity for macOS (rokko Apple Developer ID? skip and accept
  Gatekeeper warning?)
- Auto-update channel (Tauri updater is opt-in)
- Where users put `mapping.config.json` — bundled default vs. user-editable
  in OS config dir

## Logs

- pino structured JSON in production (`NODE_ENV=production`)
- pretty-printed in dev (`NODE_ENV=development`)
- Container logs via `docker compose logs -f app`
- Job-level context (`{ runId, ean, source }`) is always attached so
  filtering with `jq` works:

  ```sh
  docker compose logs app | jq -c 'select(.runId == "01HXYZ...")'
  ```

## Updating

```sh
git pull
docker compose up -d --build
# if a new migration shipped:
docker compose run --rm app node ./src/lib/db/migrate.js
```

Versioning follows SemVer once we cut a `v1.0.0`. Until then, `0.x` and
breaking changes can happen between any two commits — the changelog is
the source of truth (added in M3).
