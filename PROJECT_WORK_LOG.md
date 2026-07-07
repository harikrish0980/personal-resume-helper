# PROJECT_WORK_LOG.md

Last updated: 2026-06-30

## Project Idea

Personal Resume Helper is a local-first web application for job search operations. It started as a web layer on top of the existing Resume Workspace CLI project, then grew into a practical command center for analyzing jobs, generating role-specific resumes, tracking documents, reviewing scanner results, and managing manual applications.

The goal is to help an IT/data professional apply more efficiently without auto-submitting applications or losing control of private resume data.

## Product Goal

The app should help the user:

- paste a job URL or job description,
- choose the right resume profile,
- analyze the job fit,
- see matching skills and missing skills,
- generate a tailored ATS-friendly resume,
- create PDF, DOCX, and HTML outputs,
- review Resume QA before applying,
- save useful jobs to Applications,
- track manual application status and follow-ups,
- review scanner/API job leads without noisy Discovery results.

Final apply remains manual and human-reviewed.

## Base Used

The project uses Resume Workspace as the local engine/base:

- Gemini evaluation workflow
- source resume files
- job description storage
- reports
- scanner pipeline/history
- generated output folders

Personal Resume Helper adds the local web app, multi-profile resume flow, document management, scanner inbox, application tracker, native PDF/DOCX generation, and local QA around resume tailoring.

## Current Architecture

```text
User
  -> Personal Resume Helper web UI
  -> Node.js local backend
  -> Resume Workspace adapter
  -> selected resume profile cv.md
  -> shared article-digest.md
  -> Gemini evaluation or local fallback
  -> report + Resume QA + PDF/DOCX/HTML
  -> Documents + Applications
```

Important folders:

- `personal-resume-helper-web`: web app and API routes
- `Resume Workspace`: engine/private data/output
- `Resume-Workspace/profiles`: role-specific `cv.md` files
- `Resume-Workspace/article-digest.md`: shared experience bank
- `Resume-Workspace/output`: generated resumes and documents
- `personal-resume-helper-web/data`: local app state, cache, logs, runtime files

## Main Features Built

### Add Job

- Paste job URL or full JD.
- Select resume profile.
- Select one-page or two-page resume.
- Queue background run.
- Clear readable status messages.
- Pasted JD fallback for blocked pages.

### Run Detail

- Score and recommendation.
- Matching and missing skills.
- Resume profile used.
- Resume QA checks.
- Selected article-digest bullets.
- Report, PDF, DOCX, HTML, and log links.
- Save to Applications action.

### Resume Profiles

Enabled profiles:

- Resume 1
- Resume 2
- Resume 3
- Resume 4
- Resume 5
- Resume 6

Disabled until source resumes are added:

- Additional resume profiles can be added by creating new profile folders.

Each profile has its own `cv.md` and its own `article-digest.md`.

### Resume Generation

- One-page ATS resume.
- Two-page detailed resume.
- Native PDF generation.
- DOCX generation.
- HTML output.
- Stable simple formatting.
- Clean output file names such as `candidate_resume.pdf`.
- Output folders include job/date/profile context.

### Resume QA

Checks include:

- profile used,
- JD keyword coverage,
- parsed client experience,
- selected article-digest bullets,
- missing JD terms,
- suspicious AI phrases,
- repeated high-signal metrics,
- unsupported claims,
- AWS/Azure profile contamination.

### Scanner Inbox

Scanner Inbox replaced old Discovery Jobs.

- Reads Resume Workspace pipeline/API jobs.
- Prioritizes fresh direct ATS/company rows.
- Separates stale/review/search/history rows.
- Supports Analyze, Hide, and Open Link.
- Does not auto-run broad noisy discovery.

### Applications

- Manual application tracker.
- Statuses such as Saved, Resume Ready, Applied, Recruiter Screen, Technical Round, Final Round, Offer, Rejected, Archived.
- Notes, contact/recruiter fields, follow-up dates, and artifact links.

### Documents

- Grouped/collapsed by job/run.
- Shows resume profile, resume mode, QA status, and file count.
- Supports open, preview, download, edit label, and hide.
- Hide is non-destructive.

## Important Fixes Completed

### Resume Format Fixes

- Removed `Core Competencies` from web resumes.
- Fixed target-role banner issue.
- Added full LinkedIn URL.
- Moved GitHub into Project section only.
- Fixed PDF browser header/footer issue by moving away from browser PDF rendering where needed.
- Fixed spacing and word-joining issues caused by risky keyword bolding.
- Disabled inline keyword bolding for stable formatting.
- Kept only safe bolding for section headings, company/role lines, skill labels, and project title.
- Fixed one-page/two-page output naming.
- Added top spacing and cleaner simple ATS layout.

### Profile And Resume Source Fixes

- Added multi-profile support.
- Generic profile folders can be customized into profile-specific `cv.md` files.
- Summary text comes from the user's own resume source.
- Each user supplies their own client/project experience.
- Profile-specific digest files prevent unrelated profile bullets from leaking across profiles.
- Added profile-aware digest filtering.
- Added AWS/Azure contamination QA checks.

### Job Extraction Fixes

- Workday CXS support.
- Greenhouse, Lever, Ashby handling.
- SmartRecruiters support.
- Bullhorn best-effort public extraction with pasted JD fallback.
- Long pasted JD is prioritized over URL extraction.
- Friendly messages for blocked pages.

### Reliability Fixes

- Gemini quota/API fallback report.
- Local runtime/cache folders.
- Safer file writes and fallback paths for Windows permission issues.
- Native PDF/DOCX generation path.
- Run superseding by job + resume profile + resume mode.
- Documents hide superseded artifacts by default.
- Better error messages for blocked PDF/browser workers.

### UI/UX Fixes

- Discovery Jobs disabled because it produced noisy/random jobs.
- Scanner Inbox added as controlled replacement.
- Documents collapsed by default.
- Applications action links improved.
- Run Detail action buttons moved higher.
- Profile & Resume shows profile source health and previews.
- Settings shows local health checks.

## Issues Faced

- Gemini quota/rate-limit errors.
- Browser/PDF worker blocked by Windows security or local environment.
- EPERM file-write/rename errors in JSON state and Resume Workspace folders.
- Local folder naming confusion can happen if multiple copies of the repo exist.
- Old Discovery Jobs returning random or stale jobs.
- Scanner pipeline containing expired/search/history rows.
- Garbled/non-English text in old cards from AI output.
- PDF spacing problems from inline bold keyword rendering.
- Profile templates initially require user-provided resume text and proof points.
- `jdTerms is not defined` runtime bug during resume generation.
- Dirty `Resume Workspace` git status and old path index-lock warning.

## Recent Validation

Latest validation checked:

- Generic resume profiles generated PDF/DOCX.
- `npm run check` passed.
- Generated text checks passed for:
  - no `SQLPython`,
  - no `DevelopedPySpark`,
  - no `SnowflakeCloud`,
  - no `TableauDesktop`,
  - no `Core Competencies`,
  - candidate experience summary present,
  - user-provided client sections present,
  - unrelated profile claims do not leak into generated output.

## Rename Decision

Renaming the product is a good idea. The product should be called Personal Resume Helper.

Renaming the `Resume Workspace` folder right now is risky because many working paths depend on it:

- `RESUME_WORKSPACE_PATH`,
- adapter code,
- scanner files,
- reports,
- output links,
- profile files,
- generated document paths,
- existing local state.

Recommended rename approach:

1. Keep `Resume Workspace` as the internal engine folder for now.
2. Update user-facing docs/UI to say Personal Resume Helper.
3. Later rename code variables from Resume Workspace wording to neutral `engine` wording.
4. Support both old and new folder names during migration.
5. Rename folder only after full tests pass.

Do not do a direct folder rename without a migration plan.

## Next Useful Work

High value next steps:

- Add a controlled rename/migration plan if full rebranding is desired.
- Clean old validation outputs when user asks.
- Improve scanner source freshness and direct ATS coverage.
- Add a safe profile editor for resume source health.
- Add better DOCX style parity with PDF.
- Add export/backup workflows for local state.
- Keep testing generated PDF/DOCX text after resume formatting changes.

## Safety Rules

- Do not auto-apply.
- Do not scrape logged-in LinkedIn/Indeed.
- Do not upload resumes or API keys to cloud by default.
- Do not delete generated files unless the user explicitly asks.
- Prefer archive/hide over destructive delete.
- Keep private data local.
- Use smallest root-cause fixes.
