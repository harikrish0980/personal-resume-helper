# Career-Ops Web App

Local-first web interface for the existing Career-Ops setup.

## Run

From this web app folder:

```powershell
cd 'career-ops-web'
$env:CAREER_OPS_PATH='..\Career-Ops'
$env:PORT='3025'
node server.mjs
```

Then open:

```text
http://localhost:3025
```

Or double-click:

```text
start-web.bat
```

## Free API Key

Create:

```text
career-ops-web\.env
```

Add:

```env
GEMINI_API_KEY=your_google_ai_studio_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
CAREER_OPS_PATH=..\Career-Ops
PORT=3025
```

Free key: https://aistudio.google.com/apikey

If a normal Node/npm install is available later, this also works from this folder:

```bash
npm run web
```

## Phase 1 Scope

- Paste a job URL and optional job description.
- Create a background run with status updates.
- Use the existing `gemini-eval.mjs` Career-Ops evaluator when `GEMINI_API_KEY` is configured.
- Fall back to a local review-needed report when the API key is missing.
- Generate a resume PDF through the existing `generate-pdf.mjs` renderer.
- Save completed runs into the web application state and `data/applications.md`.
- Browse jobs, applications, generated documents, profile, and health status.

## Important Boundaries

- The app does not auto-submit applications.
- The worker validates job URLs and blocks localhost/private/metadata URLs.
- User data stays in the local Career-Ops folder.
- This is intentionally dependency-light so the first working product does not require Redis, Postgres, or a Next.js install.
