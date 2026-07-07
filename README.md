# EaZy Job Apply

EaZy Job Apply is a local-first job search workspace. It helps a job seeker compare a job description against their own resume, generate tailored resume drafts, create supporting documents, and track applications without uploading private career data to a shared web service.

The app does not auto-apply. The final application is always reviewed and submitted manually by the user.

## Why It Is Useful

- Keeps resumes, work history, generated files, and application notes on the user's own computer.
- Lets users keep multiple resume profiles, such as `Resume 1`, `Resume 2`, and `Resume 3`.
- Gives each resume profile its own `article-digest.md` so proof points and project details can be tailored per profile.
- Tailors resumes with real experience points according to the job description, without manually rewriting the resume every time.
- Helps users quickly understand whether they are a good fit for a role before applying.
- Saves time and effort by producing resume drafts, fit analysis, and supporting files from one workflow.
- Creates reusable local records for applications, reports, generated resumes, and follow-up notes.
- Exports resume files in PDF, Word/DOCX, and HTML formats, with both 1-page ATS and 2-page detailed resume options.

## Real Experience Only

EaZy Job Apply should not invent new experience, fake metrics, or unrelated AI-generated achievements. It is built for people who have real working experience and want to target new jobs more efficiently.

The best results come from:

- a truthful resume in `Resume-Workspace/profiles/resume-1/cv.md`
- real client, project, tool, metric, and business-impact points in `Resume-Workspace/profiles/resume-1/article-digest.md`
- reviewing the generated resume before applying

## How It Works

1. The user clones this repository.
2. The user copies `templates/Resume-Workspace/` to a private local `Resume-Workspace/` folder.
3. The user adds their resume text to `Resume-Workspace/profiles/resume-1/cv.md`.
4. The user adds work proof points, project details, metrics, and reusable achievements to `Resume-Workspace/profiles/resume-1/article-digest.md`.
5. The user adds their own API key in `personal-resume-helper-web/.env`.
6. The user starts the local web app and opens `http://127.0.0.1:3025`.
7. The user pastes a job URL or job description, selects a resume profile, and reviews the generated outputs.

## Project Layout

```text
<repo>
|-- README.md
|-- docs
|   |-- SETUP_LOCAL.md
|   `-- PRIVACY.md
|-- templates
|   `-- Resume-Workspace
|       |-- profiles
|       |   |-- resume-1
|       |   |   |-- cv.md
|       |   |   `-- article-digest.md
|       |   `-- resume-2 ... resume-6
|       |-- data
|       |-- jds
|       |-- output
|       `-- reports
|-- personal-resume-helper-web
|   |-- server.mjs
|   |-- .env.example
|   |-- public
|   `-- lib
`-- start-web.bat
```

The real `Resume-Workspace/` folder is private and ignored by Git. It is created locally from `templates/Resume-Workspace/`.

## Quick Start

```powershell
git clone <your-repo-url>
cd personal-resume-helper
Copy-Item -Recurse templates\Resume-Workspace Resume-Workspace
Copy-Item personal-resume-helper-web\.env.example personal-resume-helper-web\.env
```

Edit:

```text
Resume-Workspace/profiles/resume-1/cv.md
Resume-Workspace/profiles/resume-1/article-digest.md
personal-resume-helper-web/.env
```

Start the app:

```powershell
cd personal-resume-helper-web
npm start
```

Open:

```text
http://127.0.0.1:3025
```

For full setup details, see [docs/SETUP_LOCAL.md](docs/SETUP_LOCAL.md).

## Resume Profiles

The app uses generic public labels:

- Resume 1
- Resume 2
- Resume 3
- Resume 4
- Resume 5
- Resume 6

Each profile has its own resume and article digest:

```text
Resume-Workspace/profiles/resume-1/cv.md
Resume-Workspace/profiles/resume-1/article-digest.md
Resume-Workspace/profiles/resume-2/cv.md
Resume-Workspace/profiles/resume-2/article-digest.md
```

Use separate profiles for different job targets, industries, or seniority levels.

## Core Workflow

1. Add resume details and proof points to a local profile.
2. Start the local app.
3. Paste a job URL or full job description.
4. Select the resume profile to use.
5. Generate analysis and resume output.
6. Review everything manually.
7. Apply on the company or ATS website.
8. Track the application status locally.

## Configuration

Create `personal-resume-helper-web/.env` from `personal-resume-helper-web/.env.example`.

```env
GEMINI_API_KEY=your_google_ai_studio_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
RESUME_WORKSPACE_PATH=../Resume-Workspace
PORT=3025
```

Get a free Gemini API key from Google AI Studio: https://aistudio.google.com/apikey

Use `RESUME_WORKSPACE_PATH` for this setup. `PORT=3025` is the default local app port for everyone; users can change it only if another local app already uses that port.

Never commit `.env`, real resumes, generated documents, reports, logs, or private application data.

## Quality Checks

Run:

```powershell
cd personal-resume-helper-web
npm run check
```

## Deployment Plan

The recommended public release is a GitHub repository that users run locally. That is safer than a public hosted app right now because the current app uses local files for resumes, API keys, reports, and generated documents.

A hosted multi-user version can be built later, but it should first add authentication, per-user storage, encrypted secrets, upload controls, and data deletion/export controls.

## Privacy

Read [docs/PRIVACY.md](docs/PRIVACY.md) before publishing or sharing the repository.
