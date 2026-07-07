---
name: personal-resume-helper-builder
description: Project workflow for building, debugging, and QA-ing Personal Resume Helper, the local web app built on a Resume Workspace based engine.
---

# Personal Resume Helper Builder Skill

Use this skill when helping build, debug, document, or plan Personal Resume Helper.

## What This Project Is

Personal Resume Helper is a local-first web application for job search operations.

Core flow:

1. User selects a resume profile.
2. User pastes a job link or full job description.
3. App queues background analysis.
4. App generates report, Resume QA, PDF, DOCX, and HTML.
5. User reviews manually.
6. User applies manually on the company/ATS site.
7. App tracks applications, documents, and follow-ups.

Never auto-submit applications. The final apply step is always manual and human-reviewed.

## Naming And Ownership

- Product name: Personal Resume Helper.
- Current engine/base folder: `Resume-Workspace`.
- Treat Resume Workspace as the local engine dependency until a planned migration is done.
- Do not casually rename the `Resume-Workspace` folder because `RESUME_WORKSPACE_PATH`, output paths, scanner files, reports, profile sources, and document links depend on it.
- User-facing docs/UI should prefer Personal Resume Helper.
- Internal folder rename should be a separate tested migration.

## Stack

| Layer | Technology |
|---|---|
| Backend | Node.js `http` server in `server.mjs` using ES Modules |
| Frontend | Vanilla JS, HTML, CSS in `public/` |
| AI / Evaluation | Google Gemini API with local fallback |
| Resume Sources | Markdown profile files inside `Resume-Workspace/profiles`, each with its own `article-digest.md` |
| PDF/DOCX | Native local renderer from `resumeWorkspaceAdapter.mjs` and `reportlab_resume_pdf.py` |
| State / Storage | Local JSON through `lib/store.mjs` |
| Scanner Inbox | Resume Workspace pipeline/API rows, not old Discovery Jobs |
| App Tracking | Local Applications workflow |
| URL Safety | `lib/urlSafety.mjs` |

## Project Map

- Root: repository root
- Web app: `personal-resume-helper-web`
- Engine/private data: `Resume-Workspace`
- Main app URL: `http://127.0.0.1:3025`
- Server: `personal-resume-helper-web\server.mjs`
- Frontend: `personal-resume-helper-web\public\index.html`, `public\app.js`, `public\styles.css`
- Adapter: `personal-resume-helper-web\lib\resumeWorkspaceAdapter.mjs`
- State: `personal-resume-helper-web\lib\store.mjs`
- Resume profiles: `Resume-Workspace\profiles`
- Per-profile digest: `Resume-Workspace\profiles\<profile>\article-digest.md`
- Generated output: `Resume-Workspace\output`
- Reports: `Resume-Workspace\reports`
- Scanner pipeline: `Resume-Workspace\data\pipeline.md`

Keep web-app changes in `personal-resume-helper-web`. Keep engine/profile/output changes inside `Resume-Workspace`.

## Environment

Use:

```env
GEMINI_API_KEY=your_key_here
RESUME_WORKSPACE_PATH=..\Resume-Workspace
PORT=3025
```

Never hardcode API keys. Treat `.env`, resumes, PDFs, DOCX files, reports, logs, and application tracking data as private.

## Working Roles

Think through meaningful changes from these roles:

- Product Manager: workflow value, MVP scope, confusion points.
- Architect: data flow, storage, boundaries, reliability.
- Developer: smallest clean implementation matching the codebase.
- QA: regression checks, failure cases, smoke tests.
- Research: compare useful patterns, but avoid copying risky automation.
- UX: clear screens, obvious actions, no mixed workflows.

Do not stop at a plan when the user clearly wants execution. Implement, test, restart the app if needed, and report what changed.

## Core Product Rules

- Add Job is for a known job URL or pasted JD.
- Resume Profile selector controls which `cv.md` source is used.
- Analyzed Jobs is for jobs already run through the app.
- Scanner Inbox is for reviewing saved scanner/API jobs before analysis.
- Applications is for manual tracking only.
- Documents should clearly separate resume, report, HTML, DOCX, log, and cover letter.
- Discovery Jobs is disabled unless explicitly re-designed later.
- No auto-apply, no logged-in scraping, no cloud upload without a privacy design.

## Resume Profile Rules

Enabled profiles include:

- Resume 1
- Resume 2
- Resume 3
- Resume 4
- Resume 5
- Resume 6

Rules:

- Summaries use the user's own resume source.
- Selected profile `cv.md` is the primary source.
- The selected profile's own `article-digest.md` is the experience bank.
- Digest bullets are selected only when they match the JD and add value.
- Do not repeat the same idea or metric in summary and experience.
- Do not invent unsupported skills.
- Resume profiles should not borrow unsupported claims from other profiles.
- Resume QA must show the profile used and selected digest bullets.

## Resume Formatting Rules

- Prefer stable formatting over risky keyword highlighting.
- Inline JD keyword bolding stays disabled unless PDF and DOCX spacing is fully verified.
- Safe bolding only: section headings, role/company lines, skill labels, project title.
- No `Core Competencies`.
- Full LinkedIn URL in header.
- GitHub only in Project section.
- Resume file name should stay clean, such as `candidate_resume.pdf`, `.docx`, `.html`.
- Folder names may include company, title, date, and profile family.
- Check for joined words: `SQLPython`, `DevelopedPySpark`, `SnowflakeCloud`, `TableauDesktop`.

## Scanner Inbox Rules

Scanner Inbox is the safe replacement for old Discovery Jobs.

Preferred flow:

1. Resume Workspace scanner/API writes rows to pipeline/history.
2. Web app reads saved rows.
3. Fresh direct ATS/company rows appear first.
4. User reviews and chooses Analyze, Hide, or Open Link.
5. Analyze sends the job through Add Job flow.
6. Final apply remains manual.

Do not restore old noisy Discovery Jobs without a new relevance plan.

## Job Analysis Rules

Supported paths:

- Pasted JD fallback
- Greenhouse
- Lever
- Ashby
- Workday CXS/company pages
- SmartRecruiters and selected public ATS pages
- Bullhorn public extraction when available; otherwise paste JD

If Gemini quota/API/local process fails, create a useful fallback report when possible and keep the UI readable.

## Development Commands

From `personal-resume-helper-web`:

```powershell
npm run check
```

Start app:

```powershell
Start-Process -FilePath 'node' -ArgumentList 'server.mjs' -WorkingDirectory 'personal-resume-helper-web' -WindowStyle Hidden
```

Check port:

```powershell
netstat -ano | findstr :3025
```

Stop app:

```powershell
Stop-Process -Id <PID> -Force
```

## Smoke Test Checklist

After major changes:

1. Run `npm run check`.
2. Restart server on `3025`.
3. Open Dashboard.
4. Open Add Job and confirm Resume Profile and resume mode controls.
5. Run one pasted JD analysis.
6. Confirm Run Detail shows profile, QA, report, PDF, DOCX/HTML where generated.
7. Confirm no `Core Competencies`.
8. Confirm no joined words in PDF/DOCX text.
9. Check Analyzed Jobs.
10. Check Scanner Inbox.
11. Check Applications.
12. Check Documents.
13. Check Profile & Resume.
14. Check Settings.

## Final Response Pattern

Keep final updates short:

- What changed
- Where it changed
- What was tested
- Any blocker or cleanup note
- Current app URL if useful

Do not paste raw logs unless the user asks.
