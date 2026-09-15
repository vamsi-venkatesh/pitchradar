# Local setup

Requirements: Node 22+ and PostgreSQL 15+. Everything below runs offline; no external service is contacted unless you supply an API key.

## 1. Database

```bash
createdb pitchradar_dev
```

## 2. Environment

```bash
cp .env.example .env
```

`.env.example` ships with every secret blank — fill in only what you need:

- `PITCHRADAR_DATABASE_URL` — e.g. `postgresql:///pitchradar_dev`. Leave it empty to run entirely on the committed fixture catalogue.
- `PITCHRADAR_AUTH_MODE` — `disabled` for local work; production must use `required` (generate the hash with `npm run auth:hash`).
- `PITCHRADAR_LLM_API_KEY` — optional. Without it the deterministic core answers every owner turn.

Nothing else is required to build, test or generate a report.

## 3. Install

```bash
npm ci
```

## 4. Schema and fixtures

```bash
npm run db:migrate    # applies db/migrations in order, then prints a health report
npm run db:seed       # loads the source registry and the fixture operator profile
```

The seed is written never to overwrite an answer the operator gave: once the intake has any answer, or the menu has been confirmed, the row belongs to the operator and the fixture only fills genuine blanks.

## 5. Tests

```bash
npm test              # 507 tests across 36 files, including the adapter replay harness
npm run eval:golden   # 90 golden cases across 8 suites, DB-isolated and model-free
```

`eval:golden` refuses to start if `PITCHRADAR_DATABASE_URL` is set — the suites must never write into an operating database. It runs against the fixture catalogue with a throwaway runtime directory and a cleared model key.

## 6. The weekly report

```bash
npm run report -- --now=2026-07-27T09:00:00+02:00 --out=reports/sample --fixtures
```

Writes the decision brief (HTML) and the operational register (XLSX, evidence sheets inside) for the ISO week containing `--now`. `--fixtures` forces the committed fixture catalogue even when a database is configured, which is how the committed sample is produced; the generator prints which catalogue it used rather than leaving you to guess. It reads no network and no clock other than `--now`, so the same inputs produce byte-identical output.

## 7. Running it

```bash
npm run dev           # Vite dev server with the API mounted
npm run agent         # API/server only
npm run build         # tsc -b && vite build
```

Other useful commands: `npm run sources:check` (health-probe the registry), `npm run sources:collect` / `sources:normalize` / `intelligence:refresh` / `relevance:backfill` / `bookings:lifecycle` (individual stages), and `npm run cycle` (the whole operating cycle once, behind its advisory lock).
