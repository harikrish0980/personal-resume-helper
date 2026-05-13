# CURRENT_STATE.md

Last updated: 2026-05-13

## Project

EaZy Job Apply is a local-first web app on top of Career-Ops.

Main app:
- `D:\Easy job apply\career-ops-web`
- URL: `http://127.0.0.1:3013`
- Start: `start-web.bat` or `npm start` inside `career-ops-web`

Career-Ops engine and private resume data:
- `D:\Easy job apply\Career-Ops`
- Main resume source: `cv.md`
- Extra resume context: `article-digest.md`, `config/profile.yml`, `modes/_profile.md`, `interview-prep/story-bank.md`

Private generated data stays out of Git:
- `Career-Ops/`
- `career-ops-web/data/`
- `.env`
- generated PDFs/reports/logs/state

## Current Working Features

- Add Job with URL or pasted JD.
- Background Career-Ops analysis runs.
- Greenhouse, Lever, Ashby, Workday, and known company ATS handling.
- Friendly fallback for Gemini quota/API failures.
- Resume PDF generation with `two_page` default and `one_page` ATS mode.
- Resume Tailoring QA in Run Detail.
- `article-digest.md` is read and selected bullets are shown in Resume QA.
- Analyzed Jobs, Discovery Jobs, Applications, Documents, Profile & Resume, Settings.
- Discovery Jobs is separate from Analyzed Jobs.
- Local JSON state with backup/export/import support.
- Local security hardening: local host binding, Host/Origin checks, URL safety.

## Recent Token/Speed Improvements

- Added local JD extraction cache under `career-ops-web/data/cache/job-descriptions`.
- Added local Gemini evaluation cache under `career-ops-web/data/cache/gemini-evaluations`.
- Gemini cache key uses model + exact JD text.
- Repeated analysis of the same JD can reuse the cached evaluation report instead of spending Gemini quota again.
- Cache writes are best-effort and never block a job run.
- Resume tailoring remains local and still generates fresh resume files per run/mode.

## Current Priorities

1. Keep improving Discovery relevance:
   - direct company/ATS jobs first
   - stronger role-family filtering
   - direct apply links
   - useful match reasons
2. Keep improving resume tailoring:
   - smarter bullet ordering by JD
   - clearer `article-digest.md` bullet usage
   - avoid repeated metrics in summary and experience
3. Improve Applications workflow:
   - follow-up date
   - recruiter/contact
   - interview stage
   - outcome/rejection reason
4. Improve Documents:
   - group by job/run
   - clearer labels for one-page vs two-page resume
   - show QA status beside resumes
5. Keep local-first privacy:
   - no auto-apply
   - no LinkedIn/Indeed logged-in scraping
   - no cloud resume upload unless explicitly designed later

## Known Notes

- Old Run Detail pages show old saved QA results. Run a fresh analysis to see new QA/cache behavior.
- If a JD asks for skills not supported by `cv.md` or `article-digest.md`, the app should not force fake claims.
- `article-digest.md` use can still be `0` when no relevant digest bullet safely matches the JD/resume.
- PDF generation can be blocked by local environment permissions; restart using `start-web.bat` when that happens.
- ScrapeGraph local/cloud is optional, disabled by default, and review-required.

## Standard Check

Run from `D:\Easy job apply\career-ops-web`:

```powershell
npm run check
```

Expected:
- `server.mjs` passes syntax check
- `lib/careerOpsAdapter.mjs` passes syntax check
- `lib/discovery.mjs` passes syntax check
- `lib/store.mjs` passes syntax check
- `lib/urlSafety.mjs` passes syntax check
- `public/app.js` passes syntax check

## GitHub

Repo:
- `https://github.com/harikrish0980/Eazy-Job-Apply`

Commit after each stable change so future work can use `git diff` instead of rereading the whole project.
