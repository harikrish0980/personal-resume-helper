# EaZy Job Apply

EaZy Job Apply is a local-first job search workspace. It helps a job seeker compare a job description against their own resume, generate tailored resume drafts, create supporting documents, and track applications without uploading private career data to a shared web service.

The app does not auto-apply. The final application is always reviewed and submitted manually by the user.

## Why It Is Useful

- Keeps resumes, work history, generated files, and application notes on the user's own computer.
- Lets users keep multiple resume profiles, such as `Resume 1`, `Resume 2`, and `Resume 3`.
- Gives each resume profile its own `article-digest.md` so proof points and project details can be tailored per profile.
- Helps users understand fit, missing skills, matching skills, and resume quality before applying.
- Creates reusable local records for applications, reports, generated resumes, and follow-up notes.

## How It Works

1. The user clones this repository.
2. The user copies `templates/Career-Ops/` to a private local `Career-Ops/` folder.
3. The user adds their resume text to `Career-Ops/profiles/resume-1/cv.md`.
4. The user adds work proof points, project details, metrics, and reusable achievements to `Career-Ops/profiles/resume-1/article-digest.md`.
5. The user adds their own API key in `career-ops-web/.env`.
6. The user starts the local web app and opens `http://127.0.0.1:3013`.
7. The user pastes a job URL or job description, selects a resume profile, and reviews the generated outputs.

## Project Layout

```text
<repo>
|-- README.md
|-- docs
|   |-- SETUP_LOCAL.md
|   `-- PRIVACY.md
|-- templates
|   `-- Career-Ops
|       |-- profiles
|       |   |-- resume-1
|       |   |   |-- cv.md
|       |   |   `-- article-digest.md
|       |   `-- resume-2 ... resume-6
|       |-- data
|       |-- jds
|       |-- output
|       `-- reports
|-- career-ops-web
|   |-- server.mjs
|   |-- .env.example
|   |-- public
|   `-- lib
`-- start-web.bat
```

The real `Career-Ops/` folder is private and ignored by Git. It is created locally from `templates/Career-Ops/`.

## Quick Start

```powershell
git clone <your-repo-url>
cd "Easy job apply"
Copy-Item -Recurse templates\Career-Ops Career-Ops
Copy-Item career-ops-web\.env.example career-ops-web\.env
```

Edit:

```text
Career-Ops/profiles/resume-1/cv.md
Career-Ops/profiles/resume-1/article-digest.md
career-ops-web/.env
```

Start the app:

```powershell
cd career-ops-web
npm start
```

Open:

```text
http://127.0.0.1:3013
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
Career-Ops/profiles/resume-1/cv.md
Career-Ops/profiles/resume-1/article-digest.md
Career-Ops/profiles/resume-2/cv.md
Career-Ops/profiles/resume-2/article-digest.md
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

Create `career-ops-web/.env` from `career-ops-web/.env.example`.

```env
GEMINI_API_KEY=your_google_ai_studio_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
CAREER_OPS_PATH=../Career-Ops
PORT=3013
```

Never commit `.env`, real resumes, generated documents, reports, logs, or private application data.

## Quality Checks

Run:

```powershell
cd career-ops-web
npm run check
```

## Deployment Plan

The recommended public release is a GitHub repository that users run locally. That is safer than a public hosted app right now because the current app uses local files for resumes, API keys, reports, and generated documents.

A hosted multi-user version can be built later, but it should first add authentication, per-user storage, encrypted secrets, upload controls, and data deletion/export controls.

## Privacy

Read [docs/PRIVACY.md](docs/PRIVACY.md) before publishing or sharing the repository.
