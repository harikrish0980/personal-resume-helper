# Profile Data Guide

This guide explains how to prepare the two most important local files:

- `Resume-Workspace/profiles/resume-1/cv.md`
- `Resume-Workspace/profiles/resume-1/article-digest.md`

Use `resume-2`, `resume-3`, and the other profile folders the same way when you want separate resume directions.

## 1. What Happens When A User Adds Their Resume?

The user should paste their real resume details into `cv.md`.

The app reads `cv.md` as the source resume for that profile. It uses those details to create generated resume files for a specific job description, including PDF, Word/DOCX, and HTML outputs.

Important:

- The app does not currently import a PDF or Word resume and automatically rewrite `cv.md`.
- The user should manually paste or convert their resume content into `cv.md`.
- The app should not invent experience. It should tailor and format from the real details the user provides.
- Generated files are created in the local `Resume-Workspace/output/` folder.
- The original `cv.md` stays as the user's source file unless the user edits it.

## 2. Recommended `cv.md` Format

Keep `cv.md` clean, factual, and ATS-friendly. Avoid tables, columns, images, icons, and heavy formatting.

Recommended sections:

```text
# Candidate Name

City, State | email@example.com | phone | LinkedIn | GitHub/Portfolio

## Professional Summary

2-4 lines explaining target role, years of experience, core skills, domain, and business impact.

## Technical Skills

- Languages:
- Cloud/Data:
- Databases:
- Tools:

## Professional Experience

### Job Title | Company Name | City, State
Month YYYY - Month YYYY

- Action + tool/skill + scope + result + metric when true.
- Action + business problem + solution + stakeholder/result.

## Projects

### Project Name | Tools Used

- What was built, why it mattered, and measurable or observable outcome.

## Education

Degree or certification | School or Provider | Year

## Certifications

- Certification Name, Issuer, Year
```

Good bullet style:

```text
- Automated weekly data validation using Python and SQL, reducing manual review time from 6 hours to 1 hour per cycle.
```

Weak bullet style:

```text
- Worked on Python and SQL.
```

## 3. What Is `article-digest.md`?

`article-digest.md` is a proof bank. It stores extra real experience points that may not fit in the main resume but can help tailor a resume to a job description.

Use it for:

- client-wise or company-wise project details
- real metrics and business impact
- tools, platforms, and domains used
- STAR stories
- reusable achievements
- interview-defensible details

Do not use it for:

- fake metrics
- responsibilities the user did not perform
- copied job-description requirements
- AI-created achievements that are not true
- a full duplicate copy of the resume

## 4. Recommended `article-digest.md` Format

Use one section per client, company, role, or major project.

```text
## Client Or Company: Company Name

Role: Job Title
Dates: Month YYYY - Month YYYY
Domain: Banking, healthcare, retail, SaaS, telecom, government, or other real domain
Tools: Python, SQL, Azure, AWS, Power BI, Tableau, Spark, Docker, etc.

- Built [real system/process/report] using [tools] for [team/client], resulting in [real outcome or metric].
- Improved [performance/reliability/quality/process] by [real action], reducing [time/cost/errors] by [real metric if known].
- Partnered with [stakeholders/team] to solve [business problem], delivering [real result].
- Migrated, automated, supported, or documented [real work] with [tools/platforms] and [impact].
```

Project-specific section:

```text
## Project: Project Name

Problem: What business or technical problem did this solve?
Your contribution: What did you personally do?
Tools: Tools and platforms used
Outcome: What changed after the work?

- Designed and implemented [specific work] using [tool], improving [result] by [metric if true].
- Supported [system/process] for [users/team/client], improving reliability, accuracy, speed, or reporting quality.
```

## 5. Bullet Formula

Use this structure for strong points:

```text
Action + Tool/Skill + Scope + Result + Metric
```

Examples:

```text
- Built SQL reconciliation checks for daily finance feeds, reducing downstream reporting errors by 30%.
- Created Power BI dashboards for operations leaders, replacing manual Excel reports and saving 5 hours per week.
- Migrated legacy batch jobs to cloud workflows, improving monitoring and reducing failed runs during month-end processing.
```

If there is no exact metric, use a truthful observable result:

```text
- Documented production support runbooks, helping new team members resolve recurring incidents with less escalation.
```

## 6. How Much Detail Should Users Add?

For each real job or client:

- 3-8 strong bullets
- tools used
- domain
- dates or approximate period
- team, system, or user scope
- metrics only when true

For each major project:

- problem
- user contribution
- tools
- result
- 2-4 reusable bullets

More is useful, but quality matters more than volume.

## 7. Before Running A Job Analysis

Check:

- `cv.md` has the current resume source.
- `article-digest.md` has real proof points.
- `personal-resume-helper-web/.env` has a real Gemini API key.
- The app shows `cv.md loaded: Yes`.
- The app shows `article-digest.md loaded: Yes`.
- The selected resume profile is correct.

## 8. What The App Produces

After the user provides a job description and selects a resume profile, the app can produce:

- fit score
- matched skills
- missing skills
- resume QA notes
- tailored resume HTML
- tailored resume PDF
- tailored resume Word/DOCX
- 1-page or 2-page resume format

The user should always review the generated resume before applying.
