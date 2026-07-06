# Local Setup

EaZy Job Apply is designed to run on the user's own computer. This keeps resumes, API keys, generated files, and job tracking data private.

## Requirements

- Node.js 20 or newer
- A Gemini API key for AI evaluation
- Git
- A private local `Career-Ops/` folder copied from `templates/Career-Ops/`

## 1. Clone The Repository

```powershell
git clone <your-repo-url>
cd "Easy job apply"
```

## 2. Create Your Private Workspace

Copy the safe template folder:

```powershell
Copy-Item -Recurse templates\Career-Ops Career-Ops
```

The new `Career-Ops/` folder is ignored by Git. This is where the user's private resume data, job descriptions, reports, and generated documents live.

## 3. Add Resume Details

Edit:

```text
Career-Ops/profiles/resume-1/cv.md
```

Paste the resume content for the first profile. Keep it clean, factual, and current.

## 4. Add Work Proof Points

Edit:

```text
Career-Ops/profiles/resume-1/article-digest.md
```

Use this file for reusable career evidence:

- project summaries
- metrics and impact
- tools and technologies
- domain experience
- strong bullets that should only be used when relevant to the job

Each resume profile has its own `article-digest.md`, so users can keep different proof points for different resume directions.

## 5. Add API Key And Settings

Create `.env` from the example file:

```powershell
Copy-Item career-ops-web\.env.example career-ops-web\.env
```

Edit:

```text
career-ops-web/.env
```

Set:

```env
GEMINI_API_KEY=your_google_ai_studio_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
CAREER_OPS_PATH=../Career-Ops
PORT=3013
```

## 6. Start The App

```powershell
cd career-ops-web
npm start
```

Open:

```text
http://127.0.0.1:3013
```

## 7. Use The App

1. Select a resume profile, such as `Resume 1`.
2. Paste a job URL or full job description.
3. Run the analysis.
4. Review the fit score, matched skills, missing skills, generated resume, and supporting files.
5. Manually apply on the official company or ATS website.
6. Save and track the application locally.

## Resume Profiles

The public app labels are generic:

- Resume 1
- Resume 2
- Resume 3
- Resume 4
- Resume 5
- Resume 6

Each profile has its own folder:

```text
Career-Ops/profiles/resume-1/cv.md
Career-Ops/profiles/resume-1/article-digest.md
Career-Ops/profiles/resume-2/cv.md
Career-Ops/profiles/resume-2/article-digest.md
```

Use more profiles when you want separate resume variants, such as one for data engineering, one for analytics, one for support, or one for leadership.

## Before Sharing Your Fork

Run:

```powershell
git status --short
git grep -n -E "your-name|your-email|your-phone|your-linkedin|GEMINI_API_KEY"
```

Replace the example search terms with your real identifiers. Do not publish real resumes, API keys, generated documents, reports, or application history.

## Troubleshooting

If the app cannot find profile files, confirm `CAREER_OPS_PATH=../Career-Ops` and confirm the `Career-Ops/` folder exists at the repository root.

If the app starts but AI evaluation fails, confirm the Gemini API key is valid and saved in `career-ops-web/.env`.

If port `3013` is already in use, change `PORT` in `.env`.
