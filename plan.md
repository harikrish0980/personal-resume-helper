A job-search dashboard for an IT employee who wants to find matching jobs, generate tailored resumes, and track applications.

Not just:

“Paste job link and generate resume.”

The better version is:

User profile + resume
        ↓
Latest matching jobs
        ↓
Resume Workspace scoring
        ↓
Tailored resume / PDF
        ↓
Apply link
        ↓
Application tracker
        ↓
Follow-up / interview prep


Idea: 
I want to build a web application on top of my existing Resume Workspace setup.

Context:
I am an IT employee searching for a new job. I want an application that helps me find matching jobs, analyze them, generate tailored resumes, save jobs, and track applications.

I already have Resume Workspace set up and working locally in this repository/environment. Resume Workspace can take a job link or job ID, analyze the job, generate a result/report, and create a tailored resume PDF.

Now I want to build a user-friendly web app so I do not need to paste job links into CLI or Codex manually.

Main goal:
Build a web app where I can paste a job link, click Analyze, and the backend runs Resume Workspace in the background. When it finishes, the app should show the match score, recommendation, report, generated resume PDF, and apply link.

Design reference:
I have attached screenshots for the starting UI idea.

The app should have:
1. A left sidebar navigation
2. An Add Job page with job link and job description input
3. A Job Board page showing job cards with filters
4. An Applications/Applied page to track jobs
5. A Profile & Resume page
6. A Settings page

Use the screenshots only as layout inspiration. Do not copy branding from any reference website.

Important:
This should be a human-in-the-loop job search assistant, not an auto-apply spam bot.
The app can find jobs, analyze jobs, generate resumes, and prepare documents, but the user should manually review and apply.

Tech stack:
Use the existing project setup if it already has a stack.
Otherwise use:
- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui if available
- Prisma
- PostgreSQL or SQLite for local development
- BullMQ + Redis for background jobs
- Node.js worker
- Existing Resume Workspace as the backend engine

Main user flow:
1. User opens the app.
2. User goes to Add Job.
3. User pastes a job link.
4. User optionally pastes the job description.
5. User clicks Analyze Job.
6. Backend creates a JobRun record with status "queued".
7. Background worker runs Resume Workspace.
8. Resume Workspace generates analysis/report/tailored resume PDF.
9. Backend saves the result.
10. UI shows status updates.
11. When complete, user can view score, report, resume PDF, and apply link.
12. User can save the job to the application tracker.

Do not run Resume Workspace directly inside the HTTP request.
Use a background queue so the browser does not hang.

Pages to build:

1. Dashboard
Show:
- New matching jobs today
- Jobs recommended to apply
- Resume generation queue
- Applications in progress
- Follow-ups due
- Recently generated resumes

2. Add Job page
Fields:
- Job Link
- Job Description optional
- Notes optional

Options:
- Generate tailored resume
- Generate cover letter
- Save to tracker after analysis

Button:
- Analyze Job

After submit:
- Create JobRun with status "queued"
- Add background queue job
- Redirect to run detail page

3. Run Detail page
Show status:
- queued
- running
- fetching_job
- analyzing
- generating_resume
- completed
- failed

When completed show:
- company
- job title
- match score
- recommendation: Apply / Maybe / Skip
- summary
- matching skills
- missing skills
- risks
- Resume Workspace report
- tailored resume PDF download/view link
- apply link

Actions:
- Save to Applications
- Open Apply Link
- Download Resume
- Reject Job

4. Job Board page
Build a job board similar to the screenshot.

Filters:
- Search title or company
- Last 24 Hours
- Last 3 Days
- Last 7 Days
- Last 30 Days
- Domain
- Work Type
- Level
- Industry
- Certification
- Remote / Hybrid / On-site
- Salary range
- Match score

Each job card should show:
- job title
- company
- location
- posted date
- salary
- remote type
- employment type
- experience level
- industry
- skills/tags
- match score if available

Buttons:
- Analyze
- Save
- Apply

5. Applications page
Build a Kanban board with these statuses:
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

Each application card should show:
- company
- role
- match score
- applied date
- resume used
- next follow-up date
- notes

6. Documents page
Show generated documents:
- tailored resume PDFs
- resume markdown files
- Resume Workspace reports
- cover letters
- recruiter messages
- interview prep notes

7. Profile & Resume page
Fields:
- upload resume
- current role
- years of experience
- target roles
- target locations
- remote preference
- salary expectation
- visa/work authorization
- preferred tech stack
- avoided roles
- avoided companies
- preferred industries
- proof bank entries

Proof bank means reusable achievements/projects from my experience.
Example:
Project: Payment API migration
Impact: Reduced latency by 35%
Tech: Java, Spring Boot, AWS, PostgreSQL
Domain: FinTech

8. Settings page
Include:
- Resume Workspace path
- storage path
- API keys/config if needed
- queue/worker status
- app preferences

Backend requirements:
Create APIs for:
- POST /api/jobs/analyze
- GET /api/jobs/runs/:id
- GET /api/jobs
- POST /api/applications
- PATCH /api/applications/:id
- GET /api/documents
- GET /api/profile
- PATCH /api/profile

Resume Workspace integration:
Create a module called resumeWorkspaceAdapter.

It should expose:
- runResumeWorkspaceAnalysis(input)
- parseResumeWorkspaceOutput(output)
- findGeneratedArtifacts(input)

Expected adapter output:
{
  "status": "completed",
  "company": "Example Corp",
  "title": "Backend Engineer",
  "score": 86,
  "recommendation": "Apply",
  "summary": "Strong backend/API/cloud match.",
  "matchingSkills": ["Java", "Spring Boot", "AWS"],
  "missingSkills": ["Kubernetes", "Terraform"],
  "risks": ["Role asks for stronger Kubernetes experience."],
  "reportPath": "reports/example-corp-backend.md",
  "resumePdfPath": "output/example-corp-backend-resume.pdf",
  "applyUrl": "https://example.com/apply"
}

If Resume Workspace does not currently return JSON, create a wrapper script that:
1. Runs Resume Workspace
2. Reads the generated output/report files
3. Extracts structured data
4. Returns JSON to the app

Example wrapper command:
node scripts/run-resume-workspace-job.mjs --url "https://company.com/job/123" --json

Security rules:
- Use child_process.spawn, not exec with shell strings
- Never directly interpolate untrusted job URLs into shell commands
- Validate URLs before processing
- Allow only https URLs
- Block localhost URLs
- Block private IP ranges
- Block metadata IP 169.254.169.254
- Add timeout for Resume Workspace runs
- Save stdout/stderr logs
- Show useful error messages in UI
- Do not auto-submit applications

Database models:
Create or update models for:
- User
- UserProfile
- Resume
- JobPosting
- JobRun
- JobScore
- GeneratedDocument
- Application
- ApplicationEvent
- JobSource
- FollowUp

JobRun statuses:
- queued
- running
- fetching_job
- analyzing
- generating_resume
- completed
- failed

Application statuses:
- saved
- analyzing
- resume_ready
- applied
- recruiter_screen
- technical_round
- final_round
- offer
- rejected
- archived

Future job discovery:
Prepare the app so later we can add automatic job discovery from:
- Resume Workspace scan
- Greenhouse public job boards
- Lever postings
- Ashby postings
- Remotive API
- company career pages
- manual job links

For now, focus on Phase 1:
Manual Add Job → Resume Workspace background run → result/report/PDF → save to tracker.

Acceptance criteria:
- I can paste a job URL and click Analyze Job.
- The HTTP request returns quickly with a run ID.
- Resume Workspace runs in the background.
- The UI shows queued/running/completed/failed status.
- I can refresh the run detail page and see the latest status.
- When completed, I can see score, recommendation, report, and generated resume PDF.
- I can save the job to the application tracker.
- I can view saved/applied jobs in a Kanban board.
- Failed runs show useful error messages and logs.
- Code is typed, clean, reusable, and easy to extend.
- Do not break the existing Resume Workspace setup.

Before coding:
1. Inspect the existing repository structure.
2. Identify how Resume Workspace is currently run.
3. Propose a short implementation plan.
4. Then implement Phase 1.


next, after Phase 1 works:

Now add automatic job discovery.

Goal:
The app should find latest jobs that match my profile so I do not need to manually search job boards every day.

Requirements:
1. Add user job preferences:
   - target roles
   - preferred skills
   - target locations
   - remote preference
   - salary preference
   - excluded keywords
   - companies to watch
   - companies to avoid

2. Add job source connectors:
   - Resume Workspace scan
   - Greenhouse public job boards
   - Lever postings API
   - Ashby public postings
   - Remotive API

3. Normalize all jobs into the JobPosting model.

4. Deduplicate jobs using:
   - company + title + location
   - job URL
   - apply URL
   - external ATS job ID
   - description similarity if needed

5. Add quick match scoring before running Resume Workspace.
Quick score should consider:
   - title match
   - skills match
   - location match
   - remote preference
   - salary match
   - experience level
   - job freshness
   - excluded keywords

6. Only run Resume Workspace deep analysis for jobs above a configurable score threshold.

7. Update the Job Board page to show:
   - New today
   - Strong matches
   - Maybe matches
   - Skipped jobs with reason

8. Add a daily scheduled discovery job.

9. Add a manual “Run Discovery Now” button.

10. Save discovery logs and errors.

Important:
Prefer public APIs and company career pages.
Do not scrape websites in a way that violates terms.
Do not auto-apply.
The user should still review and apply manually.



-- Sample plan or helping info :

project.

# Personal Resume Helper Web App

A web application built on top of an existing **Resume Workspace** setup.

This app helps an IT employee searching for a new job by:

- Finding latest matching jobs
- Analyzing job fit using Resume Workspace
- Generating tailored resume PDFs
- Saving matching jobs
- Tracking applications
- Managing generated documents
- Preparing application information in one place

The goal is to avoid using CLI/Codex manually every time. Instead, the user can paste a job link in the web app, and the backend will run Resume Workspace in the background.

---

## 1. Product Goal

The main use case is:

> I am an IT employee looking for a new job.  
> I want to find jobs matching my profile, generate a tailored resume, save the job, apply manually, and track the full application process.

The app should not be a blind auto-apply bot.

The app should be a **human-in-the-loop job search assistant**.

AI can:

- Find jobs
- Analyze jobs
- Score fit
- Generate resume
- Generate cover letter
- Prepare application notes
- Track progress

The user should:

- Review results
- Download resume
- Open apply link
- Submit application manually
- Update application status

---

## 2. Core Features

### Phase 1 — Manual Job Link Analysis

User can paste a job URL and optional job description.

The backend should:

1. Create a job run
2. Queue the job
3. Run Resume Workspace in the background
4. Generate job evaluation
5. Generate tailored resume PDF
6. Save report and generated documents
7. Show results in the app

Main flow:

```text
User pastes job link
        ↓
Backend creates JobRun
        ↓
Queue starts background worker
        ↓
Worker runs Resume Workspace
        ↓
Resume Workspace generates result and PDF
        ↓
App saves output
        ↓
User sees score, report, resume PDF, and apply link
Phase 2 — Job Board

The app should show latest jobs matching the user profile.

Job board should include:

Search by title or company
Last 24 hours
Last 3 days
Last 7 days
Last 30 days
Domain filter
Work type filter
Level filter
Industry filter
Certification filter
Remote / Hybrid / On-site filter
Salary filter
Match score filter

Each job card should show:

Job title
Company
Location
Posted date
Salary range
Work type
Employment type
Experience level
Industry
Skills/tags
Match score
Action buttons

Recommended buttons:

Analyze
Generate Resume
Save
Apply
Phase 3 — Application Tracker

A Kanban-style tracker for saved and applied jobs.

Statuses:

Saved
Analyzing
Resume Ready
Applied
Recruiter Screen
Technical Round
Final Round
Offer
Rejected
Archived

Each application card should show:

Company
Role
Match score
Applied date
Resume used
Next follow-up date
Status
Notes
Phase 4 — Documents

For every job, the app should store generated documents.

Document types:

Tailored resume PDF
Tailored resume Markdown
Resume Workspace report
Cover letter
Recruiter message
Application answers
Interview prep notes
Phase 5 — Profile & Resume

User profile is important because matching depends on the user's data.

Profile page should include:

Upload resume
Current role
Years of experience
Target roles
Target locations
Remote preference
Salary expectation
Visa/work authorization
Preferred tech stack
Avoided roles
Avoided companies
Preferred industries
Proof bank

Example proof bank entry:

Project: Payment API migration
Impact: Reduced latency by 35%
Tech: Java, Spring Boot, AWS, PostgreSQL
Domain: FinTech
3. Main Screens
Sidebar Navigation

Recommended sidebar:

Dashboard
Job Board
Add Job
Resume Queue
Applications
Documents
Profile & Resume
Settings
Dashboard

The dashboard should answer:

What should I do today?

Show:

New matching jobs today
Jobs recommended to apply
Resume generation queue
Applications in progress
Follow-ups due
Recently applied jobs
Skill gaps

Example:

Today

12 new jobs found
5 strong matches
3 resumes ready
2 follow-ups due
1 interview tomorrow
Add Job Page

This screen is for manual job analysis.

Fields:

Job Link
Job Description
Priority
Notes

Options:

Generate tailored resume
Generate cover letter
Save to tracker after analysis

Button:

Analyze Job

After clicking the button:

Create JobRun
Set status = queued
Add queue job
Redirect user to Run Detail page
Run Detail Page

Show current status:

queued
running
fetching_job
analyzing
generating_resume
completed
failed

When completed, show:

Company
Title
Match score
Recommendation
Summary
Matching skills
Missing skills
Risks
Resume Workspace report
Tailored resume PDF
Apply link

Actions:

Save to Applications
Open Apply Link
Download Resume
Reject Job
Job Board Page

Similar to the reference screenshot.

Filters:

Search title/company
Last 24 Hours
Last 3 Days
Last 7 Days
Last 30 Days
Domain
Work Type
Level
Industry
Certification
Remote Type
Salary Range
Match Score

Job card example:

Software Engineer
Company: Example Corp
Location: Remote
Posted: 8 hours ago

Badges:
Remote | Full-time | 4+ years | $120k - $180k | Technology

Skills:
Java | Spring Boot | AWS | PostgreSQL | Microservices

Match Score: 87%

Reason:
Strong backend/API/cloud match.

Actions:
Analyze | Generate Resume | Save | Apply
Applications Page

Kanban board columns:

Saved
Analyzing
Resume Ready
Applied
Recruiter Screen
Technical Round
Final Round
Offer
Rejected
Archived
Documents Page

Show all generated files:

Resume PDFs
Reports
Cover letters
Recruiter messages
Interview notes

Each document should link back to the related job.

Profile & Resume Page

Fields:

Resume upload
Current role
Years of experience
Target roles
Target locations
Remote preference
Salary expectation
Visa/work authorization
Preferred tech stack
Avoided roles
Avoided companies
Preferred industries
Proof bank
4. Technical Architecture

Recommended stack:

Frontend: Next.js + TypeScript
UI: Tailwind CSS + shadcn/ui
Backend: Next.js API routes or NestJS
Database: PostgreSQL
ORM: Prisma
Queue: BullMQ
Queue Backend: Redis
Worker: Node.js
Storage: Local disk for MVP, S3 later
Automation Engine: Existing Resume Workspace
Browser Automation: Playwright

Architecture:

Next.js Web App
        ↓
API Routes
        ↓
PostgreSQL Database
        ↓
Redis Queue
        ↓
Worker Service
        ↓
Resume Workspace Adapter
        ↓
Resume Workspace Project
        ↓
Reports / PDFs

Important rule:

Do not run Resume Workspace directly inside an HTTP request.

Correct approach:

User clicks Analyze
        ↓
API returns runId immediately
        ↓
UI polls run status
        ↓
Worker runs Resume Workspace in background
        ↓
UI updates when completed
5. Resume Workspace Integration

Resume Workspace is already installed and working locally.

The web app should not directly depend on interactive CLI behavior forever.

Create an adapter module:

resumeWorkspaceAdapter

It should expose:

runResumeWorkspaceAnalysis(input)
parseResumeWorkspaceOutput(output)
findGeneratedArtifacts(input)

Expected result shape:

{
  "status": "completed",
  "company": "Example Corp",
  "title": "Backend Engineer",
  "score": 86,
  "recommendation": "Apply",
  "summary": "Strong backend/API/cloud match.",
  "matchingSkills": ["Java", "Spring Boot", "AWS"],
  "missingSkills": ["Kubernetes", "Terraform"],
  "risks": ["Role asks for more Kubernetes experience."],
  "reportPath": "reports/example-corp-backend.md",
  "resumePdfPath": "output/example-corp-backend-resume.pdf",
  "applyUrl": "https://example.com/apply"
}

If Resume Workspace does not return JSON, add a wrapper script that:

Runs Resume Workspace
Reads generated report/output files
Extracts structured data
Returns JSON

Example wrapper command:

node scripts/run-resume-workspace-job.mjs --url "https://company.com/job/123" --json
6. Background Worker Flow

When user submits a job link:

POST /api/jobs/analyze
        ↓
Create JobRun with status queued
        ↓
Add BullMQ job
        ↓
Worker picks job
        ↓
Set status running
        ↓
Run Resume Workspace
        ↓
Set status generating_resume
        ↓
Parse result
        ↓
Save report/PDF paths
        ↓
Set status completed

If failure happens:

Set status failed
Save stderr/logs/error message
Show useful error in UI
7. API Endpoints
Create job analysis
POST /api/jobs/analyze

Request:

{
  "jobUrl": "https://company.com/careers/software-engineer",
  "jobDescription": "Optional job description",
  "generateResume": true,
  "generateCoverLetter": false,
  "saveToTracker": true
}

Response:

{
  "runId": "run_123",
  "status": "queued"
}
Get job run
GET /api/jobs/runs/:id

Response:

{
  "id": "run_123",
  "status": "completed",
  "company": "Example Corp",
  "title": "Backend Engineer",
  "score": 86,
  "recommendation": "Apply",
  "summary": "Strong match.",
  "reportPath": "/files/reports/report.md",
  "resumePdfPath": "/files/resumes/resume.pdf"
}
Get jobs
GET /api/jobs

Supports filters:

search
postedWithin
domain
workType
level
industry
remoteType
salaryMin
salaryMax
matchScoreMin
Save application
POST /api/applications

Request:

{
  "jobPostingId": "job_123",
  "status": "saved",
  "notes": "Good backend role."
}
Update application status
PATCH /api/applications/:id

Request:

{
  "status": "applied",
  "appliedAt": "2026-01-01T10:00:00.000Z"
}
8. Database Models

Minimum models:

User
UserProfile
Resume
JobPosting
JobRun
JobScore
GeneratedDocument
Application
ApplicationEvent
JobSource
FollowUp
UserProfile

Important fields:

userId
currentRole
yearsOfExperience
targetRoles
targetLocations
remotePreference
salaryExpectation
workAuthorization
preferredTechStack
avoidedRoles
avoidedCompanies
preferredIndustries
proofBank
Resume
id
userId
filePath
markdownPath
isPrimary
createdAt
updatedAt
JobPosting
id
source
externalId
title
company
location
remoteType
employmentType
experienceLevel
salaryMin
salaryMax
currency
jobUrl
applyUrl
description
skills
industry
postedAt
discoveredAt
isActive
JobRun
id
userId
jobPostingId
jobUrl
jobDescription
status
resumeWorkspaceCommand
rawOutput
errorMessage
startedAt
completedAt
createdAt
updatedAt
JobScore
id
jobRunId
overallScore
roleMatchScore
skillsMatchScore
experienceMatchScore
locationMatchScore
salaryMatchScore
freshnessScore
recommendation
summary
matchingSkills
missingSkills
risks
GeneratedDocument
id
userId
jobRunId
jobPostingId
type
filePath
fileName
createdAt

Document types:

resume_pdf
resume_markdown
resume_workspace_report
cover_letter
recruiter_message
application_answers
interview_prep
Application
id
userId
jobPostingId
jobRunId
status
appliedAt
resumeDocumentId
coverLetterDocumentId
nextFollowUpAt
notes
createdAt
updatedAt
ApplicationEvent
id
applicationId
type
oldStatus
newStatus
note
createdAt
JobSource
id
name
type
config
enabled
lastSyncedAt
createdAt
updatedAt
FollowUp
id
applicationId
dueAt
completedAt
note
createdAt
9. Prisma Schema Draft
model User {
  id           String        @id @default(cuid())
  email        String        @unique
  name         String?
  profile      UserProfile?
  resumes      Resume[]
  jobRuns      JobRun[]
  applications Application[]
  documents    GeneratedDocument[]
  createdAt    DateTime      @default(now())
  updatedAt    DateTime      @updatedAt
}

model UserProfile {
  id                   String   @id @default(cuid())
  userId               String   @unique
  currentRole          String?
  yearsOfExperience    Int?
  targetRoles          Json?
  targetLocations      Json?
  remotePreference     String?
  salaryExpectation    String?
  workAuthorization    String?
  preferredTechStack   Json?
  avoidedRoles         Json?
  avoidedCompanies     Json?
  preferredIndustries  Json?
  proofBank            Json?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  user User @relation(fields: [userId], references: [id])
}

model Resume {
  id           String   @id @default(cuid())
  userId       String
  filePath     String
  markdownPath String?
  isPrimary    Boolean  @default(false)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt

  user User @relation(fields: [userId], references: [id])
}

model JobPosting {
  id              String   @id @default(cuid())
  source          String?
  externalId      String?
  title           String
  company         String?
  location        String?
  remoteType      String?
  employmentType  String?
  experienceLevel String?
  salaryMin       Int?
  salaryMax       Int?
  currency        String?
  jobUrl          String   @unique
  applyUrl        String?
  description     String?
  skills          Json?
  industry        String?
  postedAt        DateTime?
  discoveredAt    DateTime @default(now())
  isActive        Boolean  @default(true)

  runs         JobRun[]
  applications Application[]
  documents    GeneratedDocument[]
}

model JobRun {
  id                String    @id @default(cuid())
  userId            String
  jobPostingId      String?
  jobUrl            String
  jobDescription    String?
  status            String
  resumeWorkspaceCommand  String?
  rawOutput         String?
  errorMessage      String?
  startedAt         DateTime?
  completedAt       DateTime?
  createdAt         DateTime  @default(now())
  updatedAt         DateTime  @updatedAt

  user        User        @relation(fields: [userId], references: [id])
  jobPosting  JobPosting? @relation(fields: [jobPostingId], references: [id])
  score       JobScore?
  documents   GeneratedDocument[]
  applications Application[]
}

model JobScore {
  id                    String @id @default(cuid())
  jobRunId              String @unique
  overallScore          Int?
  roleMatchScore        Int?
  skillsMatchScore      Int?
  experienceMatchScore  Int?
  locationMatchScore    Int?
  salaryMatchScore      Int?
  freshnessScore        Int?
  recommendation        String?
  summary               String?
  matchingSkills        Json?
  missingSkills         Json?
  risks                 Json?

  jobRun JobRun @relation(fields: [jobRunId], references: [id])
}

model GeneratedDocument {
  id            String   @id @default(cuid())
  userId        String
  jobRunId      String?
  jobPostingId  String?
  type          String
  filePath      String
  fileName      String?
  createdAt     DateTime @default(now())

  user       User        @relation(fields: [userId], references: [id])
  jobRun     JobRun?     @relation(fields: [jobRunId], references: [id])
  jobPosting JobPosting? @relation(fields: [jobPostingId], references: [id])
}

model Application {
  id                    String    @id @default(cuid())
  userId                String
  jobPostingId          String
  jobRunId              String?
  status                String
  appliedAt             DateTime?
  resumeDocumentId      String?
  coverLetterDocumentId String?
  nextFollowUpAt        DateTime?
  notes                 String?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  user       User       @relation(fields: [userId], references: [id])
  jobPosting JobPosting @relation(fields: [jobPostingId], references: [id])
  jobRun     JobRun?    @relation(fields: [jobRunId], references: [id])
  events     ApplicationEvent[]
  followUps  FollowUp[]
}

model ApplicationEvent {
  id            String   @id @default(cuid())
  applicationId String
  type          String
  oldStatus     String?
  newStatus     String?
  note          String?
  createdAt     DateTime @default(now())

  application Application @relation(fields: [applicationId], references: [id])
}

model JobSource {
  id           String    @id @default(cuid())
  name         String
  type         String
  config       Json?
  enabled      Boolean   @default(true)
  lastSyncedAt DateTime?
  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt
}

model FollowUp {
  id            String    @id @default(cuid())
  applicationId String
  dueAt         DateTime
  completedAt   DateTime?
  note          String?
  createdAt     DateTime  @default(now())

  application Application @relation(fields: [applicationId], references: [id])
}
10. Environment Variables

Example .env:

DATABASE_URL="postgresql://postgres:postgres@localhost:5432/resume_workspace_web"
REDIS_URL="redis://localhost:6379"

RESUME_WORKSPACE_PATH="/absolute/path/to/resume-workspace"
RESUME_WORKSPACE_TIMEOUT_MS="300000"

APP_BASE_URL="http://localhost:3000"

FILE_STORAGE_DRIVER="local"
LOCAL_FILE_STORAGE_PATH="./storage"

NEXTAUTH_SECRET="change-me"
NEXTAUTH_URL="http://localhost:3000"
11. Suggested Folder Structure
personal-resume-helper-web/
  apps/
    web/
      app/
        dashboard/
        jobs/
          page.tsx
          new/
            page.tsx
          [id]/
            page.tsx
        runs/
          [id]/
            page.tsx
        applications/
          page.tsx
        documents/
          page.tsx
        profile/
          page.tsx
        settings/
          page.tsx
      components/
      lib/
      api/
    worker/
      src/
        index.ts
        processors/
          analyzeJob.ts
  packages/
    db/
      prisma/
        schema.prisma
      src/
    resume-workspace-adapter/
      src/
        index.ts
        runResumeWorkspaceAnalysis.ts
        parseResumeWorkspaceOutput.ts
        validateJobUrl.ts
    shared/
      src/
  storage/
    reports/
    resumes/
    logs/
  README.md
12. Security Requirements

Important security rules:

Do not use shell string execution with untrusted input.
Use child_process.spawn.
Validate URLs.
Allow only https: URLs.
Block localhost URLs.
Block private IP ranges.
Block cloud metadata IPs.
Add timeout for Resume Workspace runs.
Save logs for debugging.
Do not auto-submit job applications.

Bad:

exec(`resume-workspace ${jobUrl}`)

Good:

spawn("node", ["scripts/run-resume-workspace-job.mjs", "--url", jobUrl, "--json"], {
  cwd: process.env.RESUME_WORKSPACE_PATH,
  shell: false
})

Block these:

http://localhost
http://127.0.0.1
http://0.0.0.0
http://169.254.169.254
http://10.x.x.x
http://172.16.x.x - 172.31.x.x
http://192.168.x.x
13. Job Discovery

Later, the app should automatically find latest matching jobs.

Recommended sources:

Resume Workspace scan
Greenhouse public job boards
Lever postings API
Ashby public job postings
Remotive API
Company career pages
Manual job links

Avoid scraping LinkedIn first. It can be fragile and may violate terms.

Recommended discovery flow:

Daily scheduler
        ↓
Read user profile
        ↓
Read target roles and locations
        ↓
Fetch jobs from sources
        ↓
Normalize jobs
        ↓
Deduplicate jobs
        ↓
Run quick match score
        ↓
Run Resume Workspace only on promising jobs
        ↓
Show best matches in Job Board
14. Matching Logic

Use two levels of scoring.

Level 1 — Quick Score

Fast and cheap.

Use:

Role title match
Skills match
Location match
Salary match
Experience level match
Freshness
Avoided keywords

Only run Resume Workspace if quick score is good enough.

Example:

Run Resume Workspace only if quick score >= 70
Level 2 — Resume Workspace Deep Score

Resume Workspace should generate:

Overall score
Recommendation
Summary
Matching skills
Missing skills
Risks
Tailored resume
Report
15. Job Freshness

Fresh jobs should rank higher.

Example:

Posted today: high freshness score
Posted within 3 days: good freshness score
Posted within 7 days: okay freshness score
Posted older than 30 days: likely stale
16. Duplicate Detection

Avoid showing the same job multiple times.

Check:

company + title + location
job URL
apply URL
ATS job ID
description similarity
17. Next-Level Features

Add these after MVP.

Resume Diff

Show what changed in the tailored resume.

Example:

Added:
- AWS Lambda project
- API performance bullet
- Payment domain keywords

Removed:
- Less relevant frontend details
Skill Gap Dashboard

Show repeated missing skills.

Example:

Kubernetes missing in 12 jobs
Terraform missing in 8 jobs
GraphQL missing in 5 jobs
Follow-Up Reminders

Example:

Applied 7 days ago → remind to follow up
No response after 21 days → mark stale
Interview tomorrow → show prep notes
Interview Prep

For every applied job, generate:

Likely technical questions
Company-specific questions
Behavioral STAR answers
Why this company answer
Project stories to discuss
Browser Extension

Later, build browser extension for:

Save job from LinkedIn
Save job from Indeed
Save job from company career pages
Autofill repeated application fields
Detect submitted applications

This should not be part of the first MVP.

Gmail Integration

Later, Gmail integration can:

Detect recruiter replies
Update application status
Create interview reminders
Summarize recruiter emails
Track rejection emails

This is useful but should come after core app is stable.

18. MVP Scope

First working version:

Paste job link
        ↓
Run Resume Workspace in background
        ↓
Show score/report/PDF
        ↓
Save to tracker
        ↓
Track application status

Do not build everything at once.

Recommended phase order:

Phase 1:
Manual Add Job → Resume Workspace backend run → result + PDF

Phase 2:
Application tracker + documents page

Phase 3:
Job board with latest matching jobs

Phase 4:
Daily job discovery from company/ATS APIs

Phase 5:
Follow-up reminders + interview prep

Phase 6:
Browser extension / autofill
19. Codex Prompt — Phase 1

Use this prompt in Codex:

Build a Next.js web application on top of my existing Resume Workspace setup.

The app should look similar to the provided screenshots:
- Left sidebar navigation
- Add Job page with job link and job description fields
- Job Board page with filters and job cards
- Applied/Application tracker page
- Profile & Resume page
- Settings page

Do not copy any branding from the reference site. Use it only as layout inspiration.

Main goal:
I am an IT employee searching for a new job. I want to paste a job link in the app instead of using CLI/Codex. The backend should run Resume Workspace in the background, generate the job evaluation, tailored resume PDF, report, and save everything in the app.

Tech stack:
- Next.js
- TypeScript
- Tailwind CSS
- shadcn/ui if available
- Prisma
- PostgreSQL
- BullMQ
- Redis
- Node.js worker
- Existing Resume Workspace project as backend engine

Important:
- Resume Workspace is already installed and working locally.
- Do not run Resume Workspace inside the HTTP request.
- Use a background queue.
- Use child_process.spawn, not shell string execution.
- Validate job URLs.
- Block localhost, private IPs, and metadata URLs.
- Add timeout and error handling.
- Save logs for every Resume Workspace run.
- Do not auto-submit applications.
- Human should review and apply manually.

Pages to build:

1. Dashboard
Show:
- New matching jobs today
- Jobs recommended to apply
- Resume generation queue
- Applications in progress
- Follow-ups due

2. Add Job page
Fields:
- Job Link
- Job Description optional
- Checkboxes:
  - Generate tailored resume
  - Generate cover letter
  - Save to tracker after analysis
Button:
- Analyze Job

After submit:
- Create JobRun with status queued
- Add background queue job
- Redirect to run detail page

3. Run Detail page
Show status:
- queued
- running
- fetching_job
- analyzing
- generating_resume
- completed
- failed

When completed show:
- company
- title
- match score
- recommendation
- summary
- missing skills
- risks
- report
- tailored resume PDF link
- apply link
Actions:
- Save to Applications
- Open Apply Link
- Reject Job

4. Job Board page
Similar to the screenshot:
- Search title/company
- Last 24 Hours / Last 3 Days / Last 7 Days / Last 30 Days
- Domain filter
- Work Type filter
- Level filter
- Industry filter
- Certification filter
- Remote/Hybrid/On-site filter
- Salary filter
- Match score filter

Job card should show:
- title
- company
- location
- posted date
- salary
- remote type
- employment type
- experience level
- industry
- skills/tags
- match score
Buttons:
- Analyze
- Save
- Apply

5. Applications page
Build Kanban board with columns:
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

6. Documents page
Show generated:
- resumes
- cover letters
- reports
- interview prep notes

7. Profile & Resume page
Fields:
- upload resume
- current role
- years of experience
- target roles
- target locations
- remote preference
- salary expectation
- visa/work authorization
- preferred tech stack
- avoided roles
- avoided companies
- preferred industries
- proof bank entries

Database models:
- User
- UserProfile
- Resume
- JobPosting
- JobRun
- JobScore
- GeneratedDocument
- Application
- ApplicationEvent
- JobSource
- FollowUp

Resume Workspace adapter:
Create a module called resumeWorkspaceAdapter with:
- runResumeWorkspaceAnalysis(input)
- parseResumeWorkspaceOutput(output)
- findGeneratedArtifacts(input)

The adapter should return:
{
  "status": "completed",
  "company": "...",
  "title": "...",
  "score": 86,
  "recommendation": "Apply",
  "summary": "...",
  "missingSkills": [],
  "risks": [],
  "reportPath": "...",
  "resumePdfPath": "...",
  "applyUrl": "..."
}

If Resume Workspace currently does not return JSON, add a wrapper script around it that creates this JSON by reading the generated report/output files.

Job discovery phase:
Add later, but prepare the database for it.
Sources to support later:
- Resume Workspace scan
- Greenhouse public job boards
- Lever postings
- Ashby postings
- Remotive API
- manual job links

Acceptance criteria:
- I can paste a job URL and click Analyze.
- The page does not hang while Resume Workspace runs.
- I can refresh the run detail page and see the current status.
- When complete, I can see score, recommendation, report, and resume PDF.
- I can save the job to the application tracker.
- I can view all saved/applied jobs in a Kanban board.
- Failed runs show useful logs and error messages.
- Code is clean, typed, and uses reusable components.
20. Codex Prompt — Phase 2 Job Discovery

Use this after Phase 1 works:

Now add automatic job discovery.

Build a job discovery module that finds latest jobs matching my profile.

Requirements:
1. Add user preferences:
   - target roles
   - skills
   - locations
   - remote preference
   - salary preference
   - excluded keywords
   - companies to watch

2. Add job source connectors:
   - Resume Workspace scan
   - Greenhouse job board API
   - Lever postings API
   - Ashby public postings
   - Remotive API

3. Normalize all jobs into one JobPosting model.

4. Deduplicate jobs.

5. Add freshness scoring.

6. Run quick match scoring before expensive Resume Workspace analysis.

7. Only run Resume Workspace on jobs above threshold.

8. Show dashboard section:
   - New today
   - Strong matches
   - Maybe matches
   - Skipped with reason

9. Add scheduled daily discovery job.

10. Add manual “Run discovery now” button.

11. Add logs and retry support.

12. Do not violate job board terms. Prefer public APIs and company career pages.
21. Acceptance Criteria

The app is successful when:

User can paste a job link
Backend runs Resume Workspace in background
Browser does not hang
User can refresh status page
Completed run shows score, report, recommendation, and PDF
User can save job to tracker
User can view applications in Kanban board
User can download generated resume
Failed runs show useful logs
Job board can show discovered jobs
User can filter jobs
User can track application status
User can manage profile/resume


what you thing about this web style?
Build a modern web application using a glassmorphism (frosted glass) UI design.

Requirements:
- Use React (or Next.js) for frontend
- Use Tailwind CSS or CSS modules
- Implement glassmorphism design:
  - Transparent cards with blur (backdrop-filter)
  - Soft borders and shadows
  - Gradient or colorful background
- Create a responsive dashboard with:
  - Navbar (glass style)
  - Sidebar (optional)
  - Cards/widgets with data
  - Buttons with hover effects
- Add dark/light mode toggle
- Ensure mobile responsiveness
- Use clean, modular component structure

Bonus:
- Add animations (hover, fade-in)
- Use reusable components
- Follow modern UI/UX best practices

Output:
- Provide complete code with folder structure
- Explain key parts briefly