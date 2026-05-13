# EaZy Job Apply / Career-Ops Web

EaZy Job Apply is a local web application built on top of the existing Career-Ops CLI workflow. The goal is to make job searching easier by letting the user paste a job link or job description, run Career-Ops in the background, generate tailored documents, discover matching jobs, and track applications while keeping the final apply action manual and human-reviewed.

## Project Structure

```text
D:\Easy job apply
├── README.md
├── SKILL.md
├── plan.md
├── career-ops-web
│   ├── server.mjs
│   ├── public
│   │   ├── index.html
│   │   ├── app.js
│   │   └── styles.css
│   └── lib
│       ├── careerOpsAdapter.mjs
│       ├── discovery.mjs
│       ├── job_sources.mjs
│       ├── store.mjs
│       └── tracker.mjs
└── Career-Ops
    ├── cv.md
    ├── article-digest.md
    ├── config\profile.yml
    ├── modes\_profile.md
    ├── interview-prep\story-bank.md
    ├── jds
    ├── reports
    └── output
```

## Main Folders

- `career-ops-web`: web app frontend, backend, state, discovery, API routes, and Career-Ops integration.
- `Career-Ops`: original Career-Ops project, resume source, Gemini evaluator, reports, generated PDFs, job descriptions, and CLI-related files.
- Root folder: planning docs, instructions, and shared project notes.

## App URL

```text
http://localhost:3013
```

## Environment

The web app uses:

```text
D:\Easy job apply\career-ops-web\.env
```

Important values:

```env
GEMINI_API_KEY=your_key_here
CAREER_OPS_PATH=D:\Easy job apply\Career-Ops
PORT=3013
```

Try to use free/local options where possible. Gemini quota errors should be handled gracefully with a fallback report.

## Current Product Flow

1. Add a job link or paste a job description.
2. Web app queues a background Career-Ops run.
3. Backend extracts job details from supported ATS/company pages.
4. Career-Ops analyzes the job.
5. Web app shows score, recommendation, matching skills, missing skills, report, resume PDF, and apply link.
6. User manually reviews and applies.
7. App tracks applications and generated documents.

## Pages

### Dashboard

Shows recent runs, job metrics, applications, documents, and next actions.

### Add Job

Used for analyzing a known job.

Inputs:

- Job URL
- Optional job description
- Notes
- Generate resume PDF
- Resume PDF type:
  - `1-page ATS resume`
  - `2-page detailed resume` default
- Generate cover letter later
- Save to tracker after analysis

### Analyzed Jobs

Shows jobs that have already been analyzed by Career-Ops. This is separate from Discovery Jobs.

### Discovery Jobs

Used to find latest matching jobs before analysis.

Planned and active concepts:

- Search by target job title
- Resume upload or pasted resume text
- Resume-based matching
- Source filters
- Minimum match score
- Direct apply links when possible
- Avoid random remote-only results unless the user selects remote-only sources

### Applications

Tracks manual application workflow.

Target statuses:

- Saved
- Analyzing
- Resume Ready
- Applied
- Recruiter Screen
- Technical Round
- Final Round
- Offer
- Rejected
- Archived

### Documents

Shows generated and source documents:

- Original Resume
- Tailored Resume PDF
- Career-Ops Report
- Cover Letter later

### Profile & Resume

Shows Career-Ops profile and resume source data.

### Settings

Checks local setup, Gemini key status, Career-Ops paths, and required files.

## Resume Generation

The web app currently uses these files to generate tailored resumes:

- `Career-Ops\cv.md`
- `Career-Ops\article-digest.md`
- `Career-Ops\config\profile.yml`
- `Career-Ops\modes\_profile.md`
- `Career-Ops\interview-prep\story-bank.md`

### Two-Page Resume

Default mode. Keeps the current detailed template and richer experience/project content.

### One-Page ATS Resume

Compact mode added in Phase 2.

Rules:

- Exactly one Letter page.
- Simple ATS-friendly layout.
- No decorative blocks.
- No Core Competencies section.
- Compact skills.
- Strongest job-relevant bullets only.
- Natural, human-sounding summary.
- Avoid repeated metrics between summary and experience.

## Important Resume Quality Rules

Avoid phrases that sound AI-written or suspicious:

- `Focused fit for this role`
- `Relevant strengths include`
- `where data engineering overlaps with AI use cases`

Avoid repeating specific metrics in both summary and experience, for example:

- `0.5-2 TB/day`
- `50K-300K operational records`

The resume should be tailored based on the job description, but still sound natural.

## Supported Job Sources

Current important source support:

- Greenhouse
- Lever
- Ashby
- Workday/company career pages
- Pasted JD fallback

Workday extraction should use Workday CXS API where possible.

Known good Workday test link:

```text
https://q2ebanking.wd5.myworkdayjobs.com/Q2/job/Cary-North-Carolina/Data-Engineer_REQ-12425?source=LinkedIn
```

## Run The App

From PowerShell:

```powershell
cd "D:\Easy job apply\career-ops-web"
node server.mjs
```

Or start hidden:

```powershell
Start-Process -FilePath 'C:\Users\harik\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' -ArgumentList 'server.mjs' -WorkingDirectory 'D:\Easy job apply\career-ops-web' -WindowStyle Hidden
```

Check the port:

```powershell
netstat -ano | findstr :3013
```

Stop the server:

```powershell
Stop-Process -Id <PID> -Force
```

Note: if the server needs to write into `Career-Ops\jds`, `Career-Ops\reports`, or `Career-Ops\output`, it may need to run outside the sandbox.

## Syntax Checks

Run from `career-ops-web`:

```powershell
node --check public\app.js
node --check server.mjs
node --check lib\careerOpsAdapter.mjs
```

## One-Page Resume Verification

Check generated PDF page count:

```powershell
python -c "from pypdf import PdfReader; print(len(PdfReader(r'<PDF_PATH>').pages))"
```

Expected:

```text
1
```

## Smoke Test Checklist

After any major change:

1. Run syntax checks.
2. Restart app on port `3013`.
3. Open Dashboard.
4. Open Add Job and confirm run options.
5. Analyze one known job.
6. Confirm run completes.
7. Open report.
8. Open resume PDF.
9. Confirm no Core Competencies in web resume.
10. Confirm no garbled or non-English card summaries.
11. Check Analyzed Jobs.
12. Check Applications.
13. Check Documents.
14. Check Discovery Jobs.
15. Check Settings.

## Phase 1 Summary

Phase 1 focused on making the web app usable on top of Career-Ops:

- Add Job page.
- Background Career-Ops runs.
- Run detail page.
- Generated report and resume PDF links.
- Analyzed Jobs page.
- Discovery Jobs separation.
- Applications tracker foundation.
- Documents library foundation.
- Profile and settings pages.
- Workday extraction fix.
- Resume template cleanup.
- Removed Core Competencies from generated web resumes.
- Improved summary wording.
- Improved English-only UI behavior.
- Better labels and statuses.

## Phase 2 Started

Phase 2 starts with deeper document and discovery quality.

Completed at Phase 2 start:

- Added resume PDF type setting.
- Default is `2-page detailed resume`.
- Added `1-page ATS resume`.
- One-page PDF was smoke tested and confirmed as exactly one page.

Next Phase 2 work:

- Improve Discovery Jobs relevance.
- Make resume upload/paste the main matching input.
- Add location, remote/hybrid/onsite, sponsorship, and contract/full-time filters.
- Keep only strong matches by default.
- Improve direct apply links.
- Improve Applications workflow.
- Improve document previews and naming.
- Add cover letter generation later.
- Continue enterprise-style polish after the core flow is reliable.

## Current Design Direction

The app should feel like a practical job command center for an IT/data employee:

- Clear workflows.
- Few distractions.
- Useful status and next actions.
- Strong document generation.
- Relevant job discovery.
- Manual final apply step.
- Reliable fallback behavior.

## Notes

This is a local-first project. Treat personal resume files, generated documents, job tracking, and API keys as private. Do not upload or transmit files unless the user explicitly asks.
