# Local Setup

EaZy Job Apply is designed to run on the user's own computer. This keeps resumes, API keys, generated files, and job tracking data private.

## Requirements

- Node.js 20 or newer
- A free Gemini API key for AI evaluation
- Git
- A private local `Resume-Workspace/` folder copied from `templates/Resume-Workspace/`

## 1. Clone The Repository

```powershell
git clone <your-repo-url>
cd personal-resume-helper
```

## 2. Create Your Private Workspace

Copy the safe template folder:

```powershell
Copy-Item -Recurse templates\Resume-Workspace Resume-Workspace
```

The new `Resume-Workspace/` folder is ignored by Git. This is where the user's private resume data, job descriptions, reports, and generated documents live.

## 3. Add Resume Details

Edit:

```text
Resume-Workspace/profiles/resume-1/cv.md
```

Paste the resume content for the first profile. Keep it clean, factual, and current. This file is the primary source for the generated resume, so include the user's real work history, skills, education, projects, certifications, and contact details.

## 4. Add Work Proof Points

Edit:

```text
Resume-Workspace/profiles/resume-1/article-digest.md
```

Use this file for reusable career evidence that supports the resume:

- client-wise or company-wise project summaries
- real metrics and business impact
- tools and technologies used
- domain experience
- strong bullets that should only be used when relevant to the job description

Each resume profile has its own `article-digest.md`, so users can keep different proof points for different resume directions.

Do not add fake achievements or AI-created points that are not supported by real experience.

## 5. Add API Key And Settings

Create `.env` from the example file:

```powershell
Copy-Item personal-resume-helper-web\.env.example personal-resume-helper-web\.env
```

Edit:

```text
personal-resume-helper-web/.env
```

Set:

```env
GEMINI_API_KEY=your_google_ai_studio_key_here
GEMINI_MODEL=gemini-2.5-flash-lite
RESUME_WORKSPACE_PATH=../Resume-Workspace
PORT=3025
```

Use `RESUME_WORKSPACE_PATH` for this setup. `PORT=3025` is the default local app port for everyone; change it only if that port is already used on the user's machine.

## 6. Start The App

```powershell
cd personal-resume-helper-web
npm start
```

Open:

```text
http://127.0.0.1:3025
```

## 7. Verify Your Setup

Before analyzing jobs, confirm the app can read the user's files:

1. Open `Profile & Resume`.
2. Select `Resume 1`.
3. Confirm `cv.md loaded` shows `Yes`.
4. Confirm `article-digest.md loaded` shows `Yes`.
5. Open `Settings`.
6. Confirm `Enabled Resume Profiles` shows the expected profiles.
7. Confirm `Gemini API` shows `Configured` after adding a real key. If it says `Not configured`, check `personal-resume-helper-web/.env`.

## 8. Use The App

1. Select a resume profile, such as `Resume 1`.
2. Paste a job URL or full job description.
3. Run the analysis.
4. Review the fit score, matched skills, missing skills, generated resume, and supporting files.
5. Use the score and gaps to decide whether to apply.
6. Open the generated PDF or Word/DOCX resume and make any final edits if needed.
7. Manually apply on the official company or ATS website.
8. Save and track the application locally.

## Why This Helps Job Seekers

- Tailoring a resume with real experience points becomes easier.
- Users can quickly see whether their profile is a good fit for a job.
- Users save time because they do not manually rewrite and reformat every resume.
- The app supports 1-page ATS and 2-page detailed resume formats.
- Generated resumes can be reviewed as PDF, Word/DOCX, or HTML before applying.
- The app is most useful for people with real working experience who are searching for relevant jobs that match their profile.

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
Resume-Workspace/profiles/resume-1/cv.md
Resume-Workspace/profiles/resume-1/article-digest.md
Resume-Workspace/profiles/resume-2/cv.md
Resume-Workspace/profiles/resume-2/article-digest.md
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

If the app cannot find profile files, confirm `RESUME_WORKSPACE_PATH=../Resume-Workspace` and confirm the `Resume-Workspace/` folder exists at the repository root.

If the app starts but AI evaluation fails, confirm the Gemini API key is valid and saved in `personal-resume-helper-web/.env`.

If port `3025` is already in use, change `PORT` in `.env`.
