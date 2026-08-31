# Pulse

Live audience polling for workshops. Mentimeter-style, simpler, branded for [Exploring AI in OD](https://github.com/jhlburke-code).

**Live URL:** https://jhlburke-code.github.io/pulse/

## What it does

- **Presenter** picks a question type (multiple choice / word cloud / rating 1–5), writes the question, and gets a 4-character join code + QR code.
- **Audience** scans the QR or visits the URL, enters the code, and submits a vote.
- **Presenter screen** shows live results — animated bars for MC, a word cloud that grows in real time, or rating distribution with running average.
- **Audience screen** confirms each vote with a "you were response #N" reveal.

## Question types

| Type | Audience input | Live result |
|---|---|---|
| Multiple choice | Tap one of 2–6 options | Bars + % + counts |
| Word cloud | One word or short phrase | Weighted words (popular = bigger + red) |
| Rating 1–5 | Tap a number 1–5 | Column chart + average |

## Stack

- Static site (no build step): plain HTML, CSS, vanilla JS.
- Backend: [Supabase](https://supabase.com) project `AI Academy` (eu-west-2) — two tables (`sessions`, `responses`) with permissive RLS.
- Realtime: Supabase postgres_changes channel on the `responses` table.
- Hosting: GitHub Pages from the default branch.
- QR code generation: `api.qrserver.com` (no auth, on-the-fly).

## Local development

```sh
# Just open index.html in a browser — or:
python3 -m http.server 8000
# then visit http://localhost:8000
```

No build step. No dependencies installed locally. The Supabase JS client is loaded via jsDelivr CDN.

## Files

- `index.html` — landing page (presenter vs. audience entry)
- `presenter.html` — presenter (create form + live results, toggled by `?session=` query param)
- `audience.html` — audience (join form + vote + thanks, toggled by `?session=` and `?done=`)
- `style.css` — full AIINOD brand styling (Urbanist, navy/red, 8px left bar, crosshair, diagonals)
- `app.js` — Supabase bootstrap, client logic, rendering, realtime subscription

## Configuration

The Supabase URL and anon key live at the top of `app.js`:

```js
const SUPABASE_URL = 'https://axwipqlykysnxudnejvi.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiI…';
```

Both are public/anonymous. RLS on the backend restricts writes to the two intended tables.

## Database schema

```sql
sessions (
  id              uuid pk,
  join_code       text unique,        -- 4 chars, e.g. "K7M2"
  presenter_name  text,
  question_text   text,
  question_type   text check in ('multiple_choice','word_cloud','rating'),
  options         jsonb,              -- null for word_cloud/rating
  is_closed       boolean default false,
  created_at      timestamptz
)

responses (
  id            uuid pk,
  session_id    uuid → sessions(id),
  response_data text,                 -- option label / word / rating number
  created_at    timestamptz
)
```

## Brand

Pulsing red left bar, navy background, Urbanist type, "AI, made human." slogan style applied throughout. Designed to fit alongside other AIINOD assets.

## Notes

- One vote per browser/device is not enforced — the MVP trusts the audience. Add rate-limiting later if needed.
- Sessions auto-expire only when closed manually by the presenter. No TTL cleanup yet.
- Realtime delivery on GitHub Pages works because both clients connect to the same Supabase project — no server-side fan-out needed.