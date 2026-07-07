# CURRENT_STATE.md

Last updated: 2026-06-29

## Project

Personal Resume Helper is a local-first web app on top of Resume Workspace.

Main app:
- `personal-resume-helper-web`
- URL: `http://127.0.0.1:3025`
- Start: `start-web.bat` or `npm start` inside `personal-resume-helper-web`

Resume Workspace engine and private resume data:
- `Resume Workspace`
- Main resume source: `cv.md`
- Extra resume context: `article-digest.md`, `config/profile.yml`, `modes/_profile.md`, `interview-prep/story-bank.md`

Private generated data stays out of Git:
- `Resume-Workspace/`
- `personal-resume-helper-web/data/`
- `.env`
- generated PDFs/reports/logs/state

## Current Working Features

- Add Job with URL or pasted JD.
- Resume Profile selector for role-specific resume sources.
- Local resume profiles under `Resume-Workspace/profiles`, with `Resume 1` as the default profile.
- Background Resume Workspace analysis runs.
- Greenhouse, Lever, Ashby, Workday, and known company ATS handling.
- Friendly fallback for Gemini quota/API failures.
- Resume PDF generation with `two_page` default and `one_page` ATS mode.
- Resume Tailoring QA in Run Detail.
- `article-digest.md` is read and selected bullets are shown in Resume QA.
- Profile-specific `cv.md` and `article-digest.md` can be used for resume generation.
- Analyzed Jobs, Applications, Documents, Profile & Resume, Settings.
- Discovery Jobs is disabled from the active app; old Discovery records are archived/hidden, not deleted.
- Scanner Inbox is active for Resume Workspace pipeline/API results; fresh direct ATS rows are prioritized and stale/history/search rows are separated by filters.
- Local JSON state with backup/export/import support.
- Local security hardening: local host binding, Host/Origin checks, URL safety.

## Recent Token/Speed Improvements

- Added local JD extraction cache under `personal-resume-helper-web/data/cache/job-descriptions`.
- Added local Gemini evaluation cache under `personal-resume-helper-web/data/cache/gemini-evaluations`.
- Gemini cache key uses model + exact JD text.
- Repeated analysis of the same JD can reuse the cached evaluation report instead of spending Gemini quota again.
- Cache writes are best-effort and never block a job run.
- Resume tailoring remains local and still generates fresh resume files per run/mode.

## Current Priorities

1. Stabilize the current local MVP before more feature work:
   - protect the existing resume formats from accidental redesign
   - keep generated files and private state local
   - use small, verified UI/reliability changes
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

- The 2026-05-15 stabilization pass intentionally avoids changing resume templates, Resume Workspace output format, or PDF generation internals.
- Safe UI fixes added: Add Job now validates URL/JD before queueing, successful queue clears the form, Run Detail refreshes only the selected run, Documents uses "Hide" wording, and Applications stops showing "Mark Applied" after applied.
- Temporary rollback backup folders and untracked scripts are not part of the product and should not be committed.
- Old Run Detail pages show old saved QA results. Run a fresh analysis to see new QA/cache behavior.
- If a JD asks for skills not supported by `cv.md` or `article-digest.md`, the app should not force fake claims.
- `article-digest.md` use can still be `0` when no relevant digest bullet safely matches the JD/resume.
- PDF generation can be blocked by local environment permissions; restart using `start-web.bat` when that happens.
- ScrapeGraph local/cloud is optional, disabled by default, and review-required.
- 2026-05-18 resume/run polish:
  - Profile & Resume now exposes full `article-digest.md` display plus file length, bullet count, and source health.
  - Resume generation still reads the full `Resume-Workspace/article-digest.md`, not the preview text.
  - Resume QA now records exact selected digest bullets and final bullet source trace instead of relying only on fuzzy overlap.
  - One-page resume keeps LinkedIn as the full URL in the header and moves GitHub into the Project section.
  - Re-running the same job and same resume mode supersedes the previous active run/docs while keeping old files on disk.
  - Documents support edit label, download, and non-destructive hide.
- 2026-05-18 multi-profile resume support:
  - Added generic local resume profiles named Resume 1 through Resume 6.
  - Each profile reads its own `cv.md` and `article-digest.md` under `Resume-Workspace/profiles/<profile>/`.
  - Personal source resumes are not part of the public repository.
  - Add Job now sends a selected `resumeProfileId`; backend resume generation reads that profile's source files.
  - Runs, documents, and applications record the resume profile used.
  - Rerun superseding now uses job + resume mode + resume profile, so profiles do not hide each other's artifacts.

- 2026-06-25 scanner inbox integration:
  - Added Scanner Inbox as the safe replacement for old Discovery Jobs.
  - Scanner Inbox reads `Resume-Workspace/data/pipeline.md` and enriches rows with `data/scan-history.tsv` when available.
  - Scanner Inbox supports Analyze, Hide, and Open Link without running live scanning automatically.
  - Settings now shows scanner health for `portals.yml`, pipeline, scan history, and source counts.
  - `/api/discovery/*` remains disabled; old Discovery UI is not restored.
- 2026-06-26 scanner quality fix:
  - Scanner Inbox now defaults to fresh analyzable jobs instead of showing all old pipeline rows.
  - Rows are classified as fresh, stale, expired, review/search page, or processed history.
  - Search-page rows no longer keep warning text inside the URL.
  - Added a Run API Scanner button backed by in-process Greenhouse/Ashby/Lever API scanning to avoid Windows child-process blocking.
  - Direct scanner sources expanded from 1 to 22 API-detectable Greenhouse/Ashby/Lever companies in `Resume-Workspace/portals.yml`.
  - Added a US/Remote location filter for API scans so non-US rows such as UK-only jobs are removed before saving.
  - Current direct scan found 4 fresh analyzable jobs seen on 2026-06-26: Anthropic Data Engineer, Anthropic Data Engineering Manager Product, Boomi Senior Data Engineer - Agentic AI Engineering, and Cohere Data Engineer Data Foundations.
  - Scanner history now tracks live verification using backward-compatible status values like `live:2026-06-29`; Scanner Inbox displays these as `Verified today` after a current API refresh.
  - API scanner now fetches direct ATS sources concurrently and applies a route-level source timeout so slow company boards do not hang the UI.
  - Broad WebSearch sources remain configured in `portals.yml` but are not run automatically from the web app.
- 2026-06-29 scanner inbox verification:
  - /api/scanner/run-api?dryRun=1 now stays read-only and reports No - dry run.
  - Scanner Inbox rows are sorted by usefulness: fresh ready jobs first, then processed history, stale rows, review/search pages, and expired rows.
  - Browser verification confirmed the default Scanner Inbox view shows 4 fresh ready jobs with live status, locations, and Ready to analyze tags.
  - Old Resume Workspace pipeline rows are still recoverable through filters, but they no longer dominate the default working list.
- 2026-06-29 documents/applications polish:
  - Documents now render as collapsed job/run groups by default, with expandable file rows.
  - Document group headers show file count, resume profile, resume mode, newest date, and QA status when available.
  - Applications cards now surface manual action links for Apply, Resume, Report, Run, and Edit when those artifacts exist.
  - Application cards mark due follow-ups with a visible badge while keeping the final apply step manual.
  - Browser smoke verification passed for Dashboard, Add Job, Analyzed Jobs, Scanner Inbox, Applications, Documents, Profile & Resume, and Settings.
- 2026-06-29 cover letter and tailoring polish:
  - Add Job now labels the option as Generate cover letter because local cover-letter generation is implemented.
  - Cover letters now avoid negative gap wording and use role-aware paragraphs for BI/analytics, database/support, AWS/cloud, AI/ML, and general data engineering roles.
  - Resume bullet ordering now uses broader JD skill extraction and weighted scoring for multi-word tools, platform terms, production/support terms, action verbs, and impact metrics.
  - The app still keeps cover letters local under Resume Workspace output folders and keeps final application submission manual.
## Standard Check

Run from `personal-resume-helper-web`:

```powershell
npm run check
```

Expected:
- `server.mjs` passes syntax check
- `lib/resumeWorkspaceAdapter.mjs` passes syntax check
- `lib/discovery.mjs` passes syntax check
- `lib/store.mjs` passes syntax check
- `lib/urlSafety.mjs` passes syntax check
- `public/app.js` passes syntax check

## GitHub

Repo:
- `https://github.com/harikrish0980/Eazy-Job-Apply`

Commit after each stable change so future work can use `git diff` instead of rereading the whole project.
