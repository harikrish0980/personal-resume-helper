---
name: career-ops-web-builder
description: Project workflow for building and QA-ing the EaZy Job Apply web app on top of Career-Ops. Use when working in D:\Easy job apply, career-ops-web, or Career-Ops resume/job-analysis workflows.
---

# Career-Ops Web Builder Skill

Use this skill when helping build, debug, or plan the EaZy Job Apply web application that sits on top of the existing Career-Ops CLI project.

## What This Project Is

EaZy Job Apply is a local web application that wraps the Career-Ops workflow:

1. User pastes a job link or job description.
2. The app queues a background Career-Ops analysis.
3. The app generates a report and tailored resume PDF.
4. The user reviews the output and applies manually.
5. The app tracks jobs, applications, generated documents, and matching-job discovery.

Never auto-submit applications. The final apply step is always manual.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js `http` server in `server.mjs` using ES Modules |
| Frontend | Vanilla JS, HTML, CSS in `public/` |
| AI / Evaluation | Google Gemini API with graceful local fallback |
| Resume Source | Markdown/profile files inside `Career-Ops/` |
| PDF Generation | Web adapter renders Career-Ops resume HTML/PDF with Playwright |
| State / Storage | Local JSON through `lib/store.mjs` |
| Job Discovery | `lib/discovery.mjs` |
| App Tracking | `lib/tracker.mjs` plus local state |
| ATS Integration | `lib/careerOpsAdapter.mjs` |
| URL Safety | `lib/urlSafety.mjs` |

## Project Map

- Web app root: `D:\Easy job apply\career-ops-web`
- Career-Ops engine root: `D:\Easy job apply\Career-Ops`
- User documents and planning root: `D:\Easy job apply`
- Main app URL: `http://localhost:3013`
- Web app server: `career-ops-web\server.mjs`
- Frontend: `career-ops-web\public\index.html`, `public\app.js`, `public\styles.css`
- Career-Ops adapter: `career-ops-web\lib\careerOpsAdapter.mjs`
- Discovery logic: `career-ops-web\lib\discovery.mjs`
- Local state: `career-ops-web\lib\store.mjs`
- Application tracking: `career-ops-web\lib\tracker.mjs`
- URL safety: `career-ops-web\lib\urlSafety.mjs`
- Resume source: `Career-Ops\cv.md`
- Extra resume context: `Career-Ops\article-digest.md`, `config\profile.yml`, `modes\_profile.md`, `interview-prep\story-bank.md`
- Generated output: `Career-Ops\output`
- Reports: `Career-Ops\reports`
- Job descriptions: `Career-Ops\jds`

Keep new web-app changes in `career-ops-web`. Keep Career-Ops engine changes inside `Career-Ops`.

## Environment

Use:

```env
GEMINI_API_KEY=your_key_here
CAREER_OPS_PATH=D:\Easy job apply\Career-Ops
PORT=3013
```

Never hardcode API keys. Treat `.env`, resumes, PDFs, reports, and job tracking data as private.

## Working Style

Think through each change from these roles before implementation:

- Product Manager: user journey, MVP value, priority, confusion points.
- Architect: data flow, frontend/backend boundaries, storage model, reliability.
- Developer: smallest clean implementation matching existing code style.
- QA: smoke tests, edge cases, failure messages, regression risk.
- Research: compare with useful patterns from resume analyzers, matchers, ATS/job-discovery apps.
- UX: simple screens, clear actions, no mixed workflows, no confusing labels.

Do not stop at a plan when the user clearly wants execution. Implement, test, restart the app if needed, and report what changed.

## Core Product Rules

- Add Job is for a known job URL or pasted JD.
- Analyzed Jobs is for jobs already run through Career-Ops.
- Discovery Jobs is for finding latest relevant jobs before analysis.
- Applications is for manual apply tracking. The final apply action stays human-reviewed.
- Documents should clearly separate original resume, tailored resume, report, and cover letter.
- Keep Discovery Jobs and Analyzed Jobs separate.
- Avoid cluttered enterprise dashboards; make actions obvious and screens scan-friendly.

## Pages And Purpose

| Page | Purpose |
|---|---|
| Dashboard | Recent runs, metrics, applications, documents, next actions |
| Add Job | Paste job URL or JD and trigger Career-Ops analysis |
| Analyzed Jobs | Jobs already processed by Career-Ops |
| Discovery Jobs | Find new matching jobs before analysis |
| Applications | Manual application tracking with status workflow |
| Documents | Generated PDFs, reports, original resume, cover letters later |
| Profile & Resume | Career-Ops profile and resume source data |
| Settings | Gemini key status, paths, setup health check |

## Add Job Inputs

- Job URL
- Optional pasted job description
- Notes
- Generate resume PDF
- Resume PDF type:
  - `1-page ATS resume`
  - `2-page detailed resume` default
- Generate cover letter later
- Save to tracker after analysis

## Resume Rules

Career-Ops web resumes should be generated mainly from:

- `cv.md`
- `article-digest.md`
- `config/profile.yml`
- `modes/_profile.md`
- `interview-prep/story-bank.md`

Do not show `Core Competencies` in generated web resumes.

The app supports two resume modes:

- `two_page`: default, detailed resume, keep current template behavior.
- `one_page`: compact ATS resume, one page only, simple black-and-white format, centered name/contact, section rules, compact skills, focused bullets, education/certifications at end.

For one-page resumes:

- Keep it exactly one Letter page.
- Prefer ATS-safe structure over decorative design.
- Use compact, job-relevant bullets.
- Avoid suspicious AI phrases such as `Focused fit for this role`, `Relevant strengths include`, or `where data engineering overlaps with AI use cases`.
- Avoid repeating the same metrics in summary and experience.
- Keep job-specific summary natural and human-sounding.
- Use active verbs like designed, built, developed, led, optimized, implemented, automated, improved.
- Avoid generic filler and vague AI-sounding language.

## Discovery Jobs Rules

Discovery should find current, relevant jobs from multiple boards and direct company/ATS pages.

Preferred flow:

1. User enters target job title and/or uploads/pastes resume.
2. App infers role family from resume if title is blank.
3. App searches trusted sources.
4. App ranks by resume/skills/preferences.
5. Show only useful matches, ideally 4/5 or stronger by default.
6. Each result should have a direct company or ATS apply link when possible.

Filters to keep or add:

- Role title
- Location
- Remote/hybrid/onsite
- Sponsorship/H1B
- Full-time/contract
- Minimum match score
- Source scope

Do not fill Discovery with random remote jobs. Remote-only sources should be optional, not the default.

## Job Analysis Rules

Career-Ops should handle:

- Greenhouse
- Lever
- Ashby
- Workday/company career pages
- Pasted JD fallback

For Workday URLs, use Workday CXS APIs when possible.

If Gemini quota/API fails, show a friendly message and create a useful fallback report when possible. Do not expose long raw quota errors as the primary UI text.

## Gemini Error Handling

- Wrap Gemini calls and parsing in recoverable error handling.
- On quota/rate-limit/API-key errors, continue with a local fallback report when possible.
- Log raw technical details to logs, not as the primary UI message.
- The UI should return quickly after queueing; background work handles analysis.
- Do not block all progress because Gemini quota is exhausted.

## Frontend UX Rules

- Keep app screens quiet, work-focused, and clear.
- Do not mix Discovery and Analyzed job flows.
- Add empty states with a clear next action.
- Use clear status labels:
  - Queued
  - Running
  - Fetching Job
  - Analyzing
  - Generating Resume
  - Resume Ready
  - Needs Review
  - Applied
  - Rejected
  - Archived
- Avoid non-English or garbled text in cards.
- Do not show raw rubric/report text as a card summary if it reads like an evaluator table.

## Application Status Workflow

Use this status direction:

```text
Saved -> Analyzing -> Resume Ready -> Applied ->
Recruiter Screen -> Technical Round -> Final Round ->
Offer / Rejected / Archived
```

## Coding Rules

1. Use ES Modules: `import/export`, not `require()`.
2. Keep the app local-first.
3. Never auto-apply.
4. Handle external API failures gracefully.
5. Syntax check changed JS/MJS files before finishing.
6. Keep port `3013` unless the user explicitly changes it.
7. No `Core Competencies` in generated web resumes.
8. For Workday, try CXS API before generic page scraping.
9. Avoid unrelated refactors when fixing a targeted issue.
10. Do not commit or expose private resume/API-key data.

## Development Commands

From `D:\Easy job apply\career-ops-web`:

```powershell
node --check public\app.js
node --check server.mjs
node --check lib\careerOpsAdapter.mjs
```

Start the app:

```powershell
Start-Process -FilePath 'C:\Users\harik\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' -ArgumentList 'server.mjs' -WorkingDirectory 'D:\Easy job apply\career-ops-web' -WindowStyle Hidden
```

Check the port:

```powershell
netstat -ano | findstr :3013
```

Stop the app:

```powershell
Stop-Process -Id <PID> -Force
```

If the server must write into `Career-Ops\jds`, `Career-Ops\reports`, or `Career-Ops\output`, it may need to be started outside the sandbox.

## Smoke Test Checklist

After any major change:

1. Run syntax checks.
2. Restart server on `3013`.
3. Open Dashboard and confirm it loads.
4. Open Add Job and confirm run options are visible.
5. Run one known Workday/Greenhouse job analysis.
6. Confirm the run completes or fails with a human-readable message.
7. Confirm report opens.
8. Confirm tailored resume PDF opens.
9. Confirm no `Core Competencies` in web resume.
10. Confirm no Spanish/garbled snippets in visible cards.
11. Check Analyzed Jobs.
12. Check Applications.
13. Check Documents.
14. Check Discovery Jobs.
15. Check Settings.

For one-page resume:

```powershell
python -c "from pypdf import PdfReader; print(len(PdfReader(r'<PDF_PATH>').pages))"
```

Expected result: `1`.

## Known Good Test Job

Workday Q2 Data Engineer:

```text
https://q2ebanking.wd5.myworkdayjobs.com/Q2/job/Cary-North-Carolina/Data-Engineer_REQ-12425?source=LinkedIn
```

This is useful for testing Workday extraction, job analysis, report generation, and tailored resume PDF generation.

## Phase Notes

Phase 1 is mostly complete:

- Add Job with background Career-Ops runs.
- Run detail page with report and PDF links.
- Analyzed Jobs page.
- Discovery Jobs separated from analyzed jobs.
- Applications tracker foundation.
- Documents library foundation.
- Profile and Settings pages.
- Workday extraction fix.
- Resume template cleanup.
- Removed Core Competencies from web-generated resumes.
- Improved summary wording and English-only UI behavior.
- Better labels and statuses.

Phase 2 is in progress:

- Done: resume PDF type setting.
- Done: one-page ATS resume confirmed working.
- Next: improve Discovery Jobs relevance.
- Next: make resume upload/paste the main matching input.
- Next: add location, remote/hybrid/onsite, sponsorship, contract/full-time filters.
- Next: strong matches only by default.
- Next: improve direct apply links.
- Next: improve Applications workflow.
- Next: improve document previews and naming.
- Later: cover letter generation.
- Later: enterprise-style polish.

## Design Direction

The app should feel like a practical job command center for an IT/data professional:

- Clear workflows.
- No distractions.
- Useful status indicators and next actions.
- Strong document generation.
- Relevant job discovery, quality over quantity.
- Manual final apply step always preserved.
- Reliable fallback behavior on all errors.

## Final Response Pattern

Keep final updates short:

- What changed
- Where it changed
- What was tested
- Any blocker or cleanup note
- Current app URL if server is running

Do not overwhelm the user with raw logs unless they ask.
