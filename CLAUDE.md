# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Ciente IE** is a sports intelligence platform (in Portuguese) for athletic clubs. It is a vanilla HTML/JS web app with no build step, hosted on Firebase. The stack is:

- **Firebase Hosting** — `apps/` is the public root (see `firebase.json`)
- **Firestore** — main database
- **Firebase Auth** — email/password authentication
- **Tailwind CSS** — loaded via CDN at runtime (no PostCSS/build)
- **Firebase SDK v11** — loaded via ES module imports from `https://www.gstatic.com/firebasejs/11.0.1/`

## Deployment

```bash
# Deploy everything
firebase deploy

# Deploy only hosting
firebase deploy --only hosting

# Deploy only Firestore rules
firebase deploy --only firestore:rules
```

There is no build step. Files in `apps/` are served as-is.

## Architecture

### Directory Layout

```
apps/                        ← Firebase Hosting root
  core/                      ← Shared services (imported by all pages)
    firebase.js              ← Firebase init; exports `db` and `auth`
    authGuard.js             ← Redirects unauthenticated users to login.html
    atletas.js               ← Athlete CRUD logic
    dailyMetrics.service.js  ← Central write API for all athlete data
    neuroFeatures.service.js ← Calculates neuro analytics (z-score, trend)
    hrv_save.js              ← HRV-specific wrapper over dailyMetrics service
  components/
    sidebar.html             ← Staff sidebar markup (fetched dynamically)
    layout.js                ← Injects sidebar into pages via fetch()
  staff/                     ← Staff/admin views (dashboard, prontidao, etc.)
  assessments/               ← Evaluation forms (functional, physical, Big Five)
  login.html / login.js      ← Entry point for auth
  selecionar_atleta.html/.js ← Athlete selection for data collection flows
  coleta_pre.html/.js        ← Pre-training/game data collection
  coleta_pos.html/.js        ← Post-training/game data collection
  neuroscore.html            ← Cognitive test (1–25 sequential click)
  hrv.html                   ← HRV measurement via Polar H10
firestore.rules              ← Role-based rules (auth required, clubId-scoped)
storage.rules                ← Auth required for read and write on athlete photos
```

### Authentication & Routing

- After login, `userContext` is saved to `localStorage` with `{ uid, role, clubId, teamId, ... }`.
- `role === "staff"` or `"admin"` → redirected to `staff/index.html` (splash) → `staff/dashboard.html`.
- Other roles → `selecionar_atleta.html` for data collection flows.
- `authGuard.js` should be included on every protected page via `<script type="module" src="./core/authGuard.js"></script>`.

### Multi-tenancy

Athletes and daily metrics are scoped by `clubId`. Queries always filter by `clubId` (read from `localStorage.userContext.clubId` with a Firestore fallback). Athletes also optionally carry `teamId`.

### Data Model

**`athletes`** collection — one doc per athlete:
- Fields: `nome`, `categoria`, `posicao`, `data_nascimento`, `ultimo_clube`, `ativo`, `clubId`, `teamId`, `fotoUrl`

**`daily_metrics`** collection — doc ID is `{athleteId}_{date}` (e.g. `abc123_2025-04-05`):
- Top-level: `athleteId`, `date`, `clubId`, `teamId`, `meta.createdAt`, `meta.updatedAt`, `meta.origem[]`
- Data blocks (written independently): `pre`, `post`, `neuro`, `features`, `scores`
- Allowed blocks are enforced in `upsertDailyMetrics`.

**`users`** collection — one doc per Firebase Auth UID:
- Fields: `role`, `clubId`, `teamId`

### Central Write API

All data writes go through `upsertDailyMetrics()` in `apps/core/dailyMetrics.service.js`:

```js
await upsertDailyMetrics({ athleteId, date, block, data });
// block must be one of: "pre", "post", "neuro", "features", "scores"
```

This function merges into the `{athleteId}_{date}` document using Firestore `setDoc(..., { merge: true })`, and automatically inherits `clubId`/`teamId` from the athlete document.

### Sidebar (Staff Pages)

Staff pages include `<div id="sidebar-container"></div>` and load `layout.js`, which fetches `/components/sidebar.html` and injects it. The sidebar reads `localStorage.userContext.clubId` to display the club name and handles logout.

### Module Imports

Pages use `<script type="module">` with CDN imports. Firebase modules are always imported from:
```
https://www.gstatic.com/firebasejs/11.0.1/firebase-*.js
```
Local shared modules are imported as absolute paths like `/core/firebase.js` or relative paths like `./core/firebase.js` depending on the page location.

## Modelo MIHBD-TE

4 sistemas de monitoramento:
- Subjetivo: Hooper Index (IH)
- Autonômico: HRV (IA)
- Neuromuscular: CMJ (INM)
- Cognitivo: NeuroScore (IC)

Score global: 80% média dos sistemas / 20% pior sistema

Thresholds gerais:
- ≥70 → Estável
- 60-69 → Atenção Leve
- 50-59 → Atenção
- <50 → Crítico

Thresholds CMJ (específicos):
- ≥60 → Estável
- 50-59 → Atenção Leve
- 40-49 → Atenção
- <40 → Crítico

ISP 2.0 (Índice Semanal de Adaptação):
- Labels: Alto / Regular / Limitado / Insuficiente
- Incorpora qualidade do treino (post.qualidade) como multiplicador

Notação de microciclo: MD-X relativo à data do jogo (ex: MD-3, MD-1, MD+1)
No período Competição, dias sem jogo anterior exibem D1/D2

## Security

### Firestore Rules
Role-based and production-ready. All collections require authentication (`request.auth != null`) and are scoped by `clubId`. Staff/admin operations use the `isStaff()` helper which verifies `role` from the `users` collection.

### Firebase Storage Rules
Athlete photos (`/atletas/`) require authentication for both read and write.

### Firebase API Key
The `apiKey` in `apps/core/firebase.js` is intentionally public — it identifies the project, not a secret. Security is enforced by Firestore and Storage rules.
