# Privacy Guide

EaZy Job Apply is local-first. The public repository should not contain personal resumes, application history, reports, generated documents, or API keys.

## Never Commit

- `Career-Ops/`
- `career-ops-web/.env`
- `career-ops-web/data/`
- `career-ops-web/storage/`
- generated PDFs, DOCX files, HTML resumes, reports, logs, and caches
- real resumes or sample resumes from a person

## Before Publishing

Run:

```powershell
git status --short
git ls-files
git grep -n -E "your-name|your-email|your-phone|your-linkedin|GEMINI_API_KEY"
```

Replace the example terms with your real identifiers before publishing.

## Runtime Safety

- The app binds to localhost by default.
- Job URL validation blocks localhost, private IPs, and metadata addresses.
- The app does not auto-submit applications.
- Users should review generated resumes and cover letters before applying.
