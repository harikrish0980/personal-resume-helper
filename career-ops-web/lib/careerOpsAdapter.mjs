import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateJobUrl } from './urlSafety.mjs';

const ROOT = resolve(process.env.CAREER_OPS_PATH || join(process.cwd(), '..', 'Career-Ops'));
const JDS_DIR = join(ROOT, 'jds');
const LOG_DIR = join(ROOT, 'webapp', 'storage', 'logs');
const OUTPUT_DIR = join(ROOT, 'output');
const DEFAULT_TIMEOUT_MS = Number(process.env.CAREER_OPS_TIMEOUT_MS || 300000);
const RESUME_QA_STOP_WORDS = new Set([
  'from', 'with', 'that', 'this', 'into', 'used', 'using', 'data', 'work', 'role',
  'support', 'supported', 'business', 'technical', 'project', 'systems', 'source',
  'sources', 'reporting', 'analysis', 'analytics', 'datasets', 'reliable',
]);
const KNOWN_COMPANY_ATS_WRAPPERS = [
  {
    hostnames: ['beyondtrust.com', 'www.beyondtrust.com'],
    pathPattern: /^\/company\/careers\/(\d+)/i,
    ats: 'greenhouse',
    board: 'beyondtrust',
  },
];

export async function runCareerOpsAnalysis(input, onStatus = () => {}) {
  mkdirSync(JDS_DIR, { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const urlCheck = validateJobUrl(input.jobUrl);
  if (!urlCheck.ok) throw new Error(urlCheck.error);

  onStatus('fetching_job');
  const jdText = await resolveJobDescription(input.jobDescription, urlCheck.url);
  if (!jdText || jdText.length < 80) {
    throw new Error('Could not extract enough job description text. Paste the JD manually and retry.');
  }
  const applyUrl = extractMetadataLine(jdText, 'Apply URL') || input.jobUrl || '';

  const jdPath = join(JDS_DIR, `webapp-${input.runId}.txt`);
  writeFileSync(jdPath, jdText, 'utf-8');

  onStatus('analyzing');
  let evalResult;
  try {
    evalResult = await runGeminiEvaluator(jdPath, input.runId);
  } catch (error) {
    if (!isRecoverableGeminiError(error)) throw error;
    const reason = recoverableGeminiMessage(error);
    const reportPath = createFallbackReport(jdPath, reason, input.jobUrl);
    const logPath = join(LOG_DIR, `${input.runId}.log`);
    const rawError = String(error?.message || error || '');
    writeFileSync(logPath, `${reason}\n\nOriginal Gemini error:\n${rawError}`, 'utf-8');
    evalResult = { reportPath, stdout: reason, stderr: rawError, logPath };
  }

  const report = evalResult.reportPath ? parseCareerOpsReport(evalResult.reportPath) : {};
  const fallback = heuristicSummary(jdText, input.jobUrl);
  const company = firstUseful(report.company, evalResult.company, fallback.company);
  const title = firstUseful(report.title, evalResult.title, fallback.title);
  const score = firstUsefulNumber(report.score, evalResult.score, fallback.score);
  const recommendation = firstUseful(report.recommendation, scoreToRecommendation(score));
  const usedFallbackEvaluation = !evalResult.reportPath || /fallback report|fallback analysis|quota|rate limit|api key/i.test(String(evalResult.stdout || ''));
  const matchingSkills = mergeSkills(report.matchingSkills, fallback.matchingSkills);
  const missingSkills = mergeShortList(report.missingSkills, fallback.missingSkills, 5);
  const risks = report.risks?.length
    ? mergeShortList(report.risks, [], 4)
    : (usedFallbackEvaluation ? mergeShortList([], fallback.risks, 4) : []);
  const result = {
    status: 'completed',
    company: cleanDisplayText(company),
    title: cleanDisplayText(title),
    score,
    recommendation,
    summary: englishSummary({
      company,
      title,
      score,
      recommendation,
      fallbackSummary: report.summary || fallback.summary,
    }),
    matchingSkills,
    missingSkills,
    risks,
    reportPath: evalResult.reportPath ? relative(ROOT, evalResult.reportPath) : '',
    resumePdfPath: '',
    resumeMode: input.resumeMode === 'one_page' ? 'one_page' : 'two_page',
    applyUrl,
    rawOutput: evalResult.stdout,
    logPath: relative(ROOT, evalResult.logPath),
  };

  if (input.generateResume !== false) {
    onStatus('generating_resume');
    const resumeResult = await generateResumePdf({ ...result, jdText, runId: input.runId, resumeMode: result.resumeMode });
    result.resumePdfPath = resumeResult.resumePdfPath;
    result.resumeHtmlPath = resumeResult.resumeHtmlPath;
    result.resumePdfError = resumeResult.resumePdfError;
    result.resumePdfErrorLogPath = resumeResult.resumePdfErrorLogPath;
    result.resumeQa = resumeResult.resumeQa;
    if (resumeResult.resumePdfError) {
      result.risks = mergeShortList(result.risks, ['Resume PDF rendering was blocked locally. Review the saved resume HTML and retry PDF generation after restarting the app.'], 5);
    }
  }

  if (input.generateCoverLetter) {
    result.coverLetterPath = generateCoverLetter({ ...result, jdText, runId: input.runId });
  }

  return result;
}

async function resolveJobDescription(jobDescription, jobUrl) {
  if (jobDescription && jobDescription.trim()) return jobDescription.trim();
  if (!jobUrl) return '';

  const atsText = await tryAtsApi(jobUrl).catch(() => '');
  if (atsText) return atsText;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await safeFetch(jobUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(jobPageFetchError(res.status));
    const html = await res.text();
    return htmlToText(html).slice(0, 30000);
  } finally {
    clearTimeout(timer);
  }
}

async function tryAtsApi(jobUrl) {
  const url = new URL(jobUrl);

  const wrappedAtsText = await tryKnownCompanyAts(url, jobUrl);
  if (wrappedAtsText) return wrappedAtsText;

  const greenhouse = ['job-boards.greenhouse.io', 'boards.greenhouse.io'].includes(url.hostname)
    ? url.pathname.match(/^\/([^/]+)\/jobs\/(\d+)/)
    : null;
  if (greenhouse) {
    const [, board, jobId] = greenhouse;
    const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}?questions=true`;
    const json = await fetchJson(apiUrl);
    const text = formatGreenhouseJob(board, json, jobUrl);
    if (text) return text;
  }

  const lever = url.hostname === 'jobs.lever.co'
    ? url.pathname.match(/^\/([^/]+)\/([^/]+)/)
    : null;
  if (lever) {
    const [, company, postingId] = lever;
    const json = await fetchJson(`https://api.lever.co/v0/postings/${company}/${postingId}`);
    if (json?.text || json?.descriptionPlain) {
      return [
        `Company: ${company}`,
        `Title: ${json.text || 'Unknown role'}`,
        json.categories?.location ? `Location: ${json.categories.location}` : '',
        `Apply URL: ${json.hostedUrl || jobUrl}`,
        '',
        json.descriptionPlain || htmlToText(json.description || ''),
        ...(json.lists || []).map((list) => `\n${list.text}\n${(list.content || '').map((item) => `- ${item.text}`).join('\n')}`),
      ].filter(Boolean).join('\n');
    }
  }

  const ashby = url.hostname === 'jobs.ashbyhq.com'
    ? url.pathname.match(/^\/([^/]+)\/([^/]+)/)
    : null;
  if (ashby) {
    const [, board, jobId] = ashby;
    const json = await fetchJson(`https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`);
    const job = (json?.jobs || []).find((item) => item.id === jobId || item.jobUrl === jobUrl);
    if (job) {
      return [
        `Company: ${board}`,
        `Title: ${job.title || 'Unknown role'}`,
        job.location ? `Location: ${job.location}` : '',
        `Apply URL: ${job.jobUrl || jobUrl}`,
        '',
        htmlToText(decodeHtml(job.descriptionHtml || job.description || '')),
      ].filter(Boolean).join('\n');
    }
  }

  const workday = url.hostname.endsWith('.myworkdayjobs.com')
    ? url.pathname.match(/^\/(?:(?:[a-z]{2}-[a-z]{2})\/)?([^/]+)\/job\/(.+)$/i)
    : null;
  if (workday) {
    const tenant = url.hostname.split('.')[0];
    const [, site, jobPath] = workday;
    const apiUrl = `https://${url.hostname}/wday/cxs/${tenant}/${site}/job/${jobPath}${url.search || ''}`;
    const json = await fetchJson(apiUrl);
    const posting = json?.jobPostingInfo;
    if (posting?.title || posting?.jobDescription) {
      const locations = [posting.location, ...(posting.additionalLocations || [])].filter(Boolean);
      return [
        `Company: ${site}`,
        `Title: ${posting.title || 'Unknown role'}`,
        locations.length ? `Location: ${locations.join(', ')}` : '',
        posting.timeType ? `Time type: ${posting.timeType}` : '',
        posting.postedOn || posting.startDate ? `Posted: ${posting.postedOn || posting.startDate}` : '',
        posting.jobReqId ? `Job requisition ID: ${posting.jobReqId}` : '',
        `Apply URL: ${posting.externalUrl || jobUrl}`,
        '',
        htmlToText(decodeHtml(posting.jobDescription || '')),
      ].filter(Boolean).join('\n');
    }
  }

  return '';
}

async function tryKnownCompanyAts(url, jobUrl) {
  const wrapper = KNOWN_COMPANY_ATS_WRAPPERS.find((item) => (
    item.hostnames.includes(url.hostname)
    && item.pathPattern.test(url.pathname)
  ));
  if (!wrapper) return '';

  const match = url.pathname.match(wrapper.pathPattern);
  const jobId = match?.[1];
  if (!jobId || wrapper.ats !== 'greenhouse') return '';

  const direct = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${wrapper.board}/jobs/${jobId}?questions=true`);
  const directText = formatGreenhouseJob(wrapper.board, direct, `https://job-boards.greenhouse.io/${wrapper.board}/jobs/${jobId}`);
  if (directText) return directText;

  const board = await fetchJson(`https://boards-api.greenhouse.io/v1/boards/${wrapper.board}/jobs?content=true`);
  const job = (board?.jobs || []).find((item) => (
    String(item.id) === String(jobId)
    || String(item.absolute_url || '').includes(`/jobs/${jobId}`)
  ));
  return formatGreenhouseJob(wrapper.board, job, jobUrl);
}

function formatGreenhouseJob(board, job, fallbackUrl) {
  if (!job?.title && !job?.content) return '';
  return [
    `Company: ${board}`,
    `Title: ${job.title || 'Unknown role'}`,
    job.location?.name ? `Location: ${job.location.name}` : '',
    `Apply URL: ${job.absolute_url || fallbackUrl}`,
    '',
    htmlToText(decodeHtml(job.content || '')),
  ].filter(Boolean).join('\n');
}

function extractMetadataLine(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(text || '').match(new RegExp(`^${escaped}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() || '';
}

function jobPageFetchError(status) {
  if (Number(status) === 403) {
    return 'This job page blocked automated fetching (HTTP 403). Paste the job description manually, or use the direct ATS apply link if the company provides one.';
  }
  return `Job page returned HTTP ${status}`;
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await safeFetch(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function safeFetch(url, options = {}, redirectCount = 0) {
  const urlCheck = validateJobUrl(url);
  if (!urlCheck.ok) throw new Error(urlCheck.error);
  if (redirectCount > 5) throw new Error('Too many redirects while fetching the job page.');
  const res = await fetch(urlCheck.url, {
    ...options,
    redirect: 'manual',
    headers: {
      'user-agent': 'Career-Ops-WebApp/0.1',
      ...(options.headers || {}),
    },
  });
  if ([301, 302, 303, 307, 308].includes(res.status)) {
    const location = res.headers.get('location');
    if (!location) return res;
    const nextUrl = new URL(location, urlCheck.url).toString();
    const nextCheck = validateJobUrl(nextUrl);
    if (!nextCheck.ok) throw new Error(`Unsafe redirect blocked: ${nextCheck.error}`);
    return safeFetch(nextCheck.url, options, redirectCount + 1);
  }
  return res;
}

async function runGeminiEvaluator(jdPath, runId) {
  const before = Date.now();
  if (!process.env.GEMINI_API_KEY) {
    const message = 'GEMINI_API_KEY is not configured. Created a local fallback report instead.';
    const reportPath = createFallbackReport(jdPath, message);
    const logPath = join(LOG_DIR, `${runId}.log`);
    writeFileSync(logPath, message, 'utf-8');
    return { reportPath, stdout: message, stderr: '', logPath };
  }

  const args = ['gemini-eval.mjs', '--file', jdPath];
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    shell: false,
    env: process.env,
  });

  let stdout = '';
  let stderr = '';
  const timer = setTimeout(() => child.kill('SIGTERM'), DEFAULT_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

  const code = await new Promise((resolve) => child.on('close', resolve));
  clearTimeout(timer);

  const logPath = join(LOG_DIR, `${runId}.log`);
  writeFileSync(logPath, `COMMAND: ${process.execPath} ${args.join(' ')}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`, 'utf-8');

  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `Career-Ops evaluator exited with code ${code}`);
  }

  return {
    ...parseEvaluatorStdout(stdout),
    reportPath: findNewestReport(before),
    stdout,
    stderr,
    logPath,
  };
}

export function parseCareerOpsReport(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return {};
  const text = readFileSync(reportPath, 'utf-8');
  const titleLine = text.match(/^#\s*Evaluation:\s*(.+?)\s*(?:--|—|-)\s*(.+)$/m);
  const summaryBlock = parseEvaluatorStdout(text);
  const score = text.match(/\*\*Score:\*\*\s*([0-9.]+)/i)?.[1] || summaryBlock.score;
  const company = firstUseful(titleLine?.[1], summaryBlock.company);
  const title = firstUseful(titleLine?.[2], summaryBlock.title);
  const reportSummary = extractMarkdownSection(text, 'Summary') || firstParagraphAfterHeading(text, ['Role summary', 'Resumen', 'A)']);
  return {
    company: cleanDisplayText(company),
    title: cleanDisplayText(title),
    score: score ? Number(score) : undefined,
    recommendation: scoreToRecommendation(score),
    summary: englishSummary({ company, title, score, recommendation: scoreToRecommendation(score), fallbackSummary: reportSummary }),
    matchingSkills: pickSkills(text, true),
    missingSkills: pickSkills(text, false),
    risks: pickBulletsNear(text, ['risk', 'gap', 'weakness']).slice(0, 4),
  };
}

function extractMarkdownSection(text, heading) {
  const match = text.match(new RegExp(`^##\\s+${heading}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|(?![\\s\\S]))`, 'im'));
  return match?.[1]?.replace(/[#*_`>-]/g, '').trim();
}

function parseEvaluatorStdout(stdout) {
  const block = stdout.match(/---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/)?.[1] || '';
  const get = (key) => usefulValue(block.match(new RegExp(`${key}:\\s*(.+)`, 'i'))?.[1]?.trim());
  return {
    company: get('COMPANY'),
    title: get('ROLE'),
    score: Number(get('SCORE')) || undefined,
  };
}

function firstUseful(...values) {
  return values.map(usefulValue).find(Boolean) || '';
}

function firstUsefulNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return number;
  }
  return undefined;
}

function mergeSkills(primary = [], fallback = []) {
  const combined = [...(primary || []), ...(fallback || [])]
    .map((skill) => cleanDisplayText(skill))
    .filter(Boolean);
  return [...new Set(combined)].slice(0, 10);
}

function mergeShortList(primary = [], fallback = [], limit = 4) {
  const combined = [...(primary || []), ...(fallback || [])]
    .map((item) => cleanDisplayText(item))
    .filter(Boolean)
    .filter((item) => isMostlyEnglish(item));
  return [...new Set(combined)].slice(0, limit);
}

function usefulValue(value) {
  const text = cleanDisplayText(value || '');
  if (!text || /^(unknown|n\/a|na|null|undefined|\?|\?\/5)$/i.test(text)) return '';
  return text;
}

async function generateResumePdf(result) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(`${result.company}-${result.title}`) || `run-${Date.now()}`;
  const dir = join(OUTPUT_DIR, `webapp-${slug}-${date}-${result.runId || Date.now()}`);
  mkdirSync(dir, { recursive: true });

  const resumeMode = result.resumeMode === 'one_page' ? 'one_page' : 'two_page';
  const suffix = resumeMode === 'one_page' ? '_1_page' : '';
  const htmlPath = join(dir, `Harikrishna_resume${suffix}.html`);
  const pdfPath = join(dir, `Harikrishna_resume${suffix}.pdf`);
  const cv = readOptionalText('cv.md');
  const context = loadResumeContext();
  let html = resumeMode === 'one_page'
    ? renderOnePageResumeHtml(result, cv, context)
    : renderResumeHtml(result, cv, context);
  result.resumeQa = buildResumeTailoringQa(html, result, context);
  writeFileSync(htmlPath, html, 'utf-8');

  const resumeHtmlPath = relative(ROOT, htmlPath);
  try {
    await renderPdfWithPlaywright(htmlPath, pdfPath);
    return {
      resumePdfPath: relative(ROOT, pdfPath),
      resumeHtmlPath,
      resumeQa: result.resumeQa,
    };
  } catch (error) {
    const errorLogPath = join(dir, 'resume-pdf-error.log');
    writeFileSync(errorLogPath, String(error?.stack || error?.message || error), 'utf-8');
    return {
      resumePdfPath: '',
      resumeHtmlPath,
      resumePdfError: pdfWorkerErrorMessage(error),
      resumePdfErrorLogPath: relative(ROOT, errorLogPath),
      resumeQa: result.resumeQa,
    };
  }
}

function loadResumeContext() {
  return {
    articleDigest: readOptionalText('article-digest.md'),
    profileYml: readOptionalText(join('config', 'profile.yml')),
    profileMd: readOptionalText(join('modes', '_profile.md')),
    storyBank: readOptionalText(join('interview-prep', 'story-bank.md')),
  };
}

function readOptionalText(relativePath) {
  const path = join(ROOT, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function generateCoverLetter(result) {
  const date = new Date().toISOString().slice(0, 10);
  const slug = slugify(`${result.company}-${result.title}`) || `run-${Date.now()}`;
  const dir = join(OUTPUT_DIR, `webapp-${slug}-${date}-${result.runId || Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'cover-letter.md');
  const skills = [...new Set(result.matchingSkills || [])].slice(0, 6);
  const gaps = [...new Set(result.missingSkills || [])].slice(0, 3);
  const body = `# Cover Letter - ${result.company || 'Company'} - ${result.title || 'Role'}

Dear Hiring Team,

I am interested in the ${result.title || 'role'} at ${result.company || 'your company'} because it maps closely to my data engineering background building reliable pipelines, reporting datasets, and analytics-ready data products.

My strongest fit areas for this role are ${skills.length ? skills.join(', ') : 'SQL, Python, data pipelines, and cloud data platforms'}. In recent roles, I have built PySpark, Snowflake, Databricks, and Azure data workflows, supported production reliability, and worked with business and technical teams to improve reporting outcomes.

One area I would review carefully for this role is ${gaps.length ? gaps.join(', ') : 'the exact cloud/platform requirements'}. I would address that directly by leaning on adjacent experience and closing any tool-specific gap quickly.

Thank you for your time and consideration.

Sincerely,
HariKrishna Gumma
`;
  writeFileSync(path, body, 'utf-8');
  return relative(ROOT, path);
}

async function renderPdfWithPlaywright(htmlPath, pdfPath) {
  const playwrightPath = join(ROOT, 'node_modules', 'playwright', 'index.mjs');
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  mkdirSync(dirname(pdfPath), { recursive: true });
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
    ],
  });
  try {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' });
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.35in', right: '0.35in', bottom: '0.35in', left: '0.35in' },
    });
  } finally {
    await browser.close();
  }
}

function pdfWorkerErrorMessage(error) {
  const raw = String(error?.message || error || '');
  const lower = raw.toLowerCase();
  if (lower.includes('spawn eperm') || lower.includes('uv_handle_closing') || lower.includes('access is denied')) {
    return 'The PDF/browser worker was blocked by the local environment. The resume HTML and QA were saved; restart the app with start-web.bat, then retry PDF generation.';
  }
  if (lower.includes('executable') || lower.includes('browser') || lower.includes('chromium')) {
    return 'The local PDF browser could not start. The resume HTML and QA were saved; run npm install in Career-Ops if Playwright is missing, then retry.';
  }
  return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw || 'The PDF/browser worker failed, but the resume HTML and QA were saved.';
}

function renderResumeHtml(result, cv, context = {}) {
  const templatePath = join(ROOT, 'templates', 'cv-template.html');
  const template = existsSync(templatePath) ? readFileSync(templatePath, 'utf-8') : '';
  if (!template) return renderPlainResumeHtml(cv);

  const parsed = parseCvMarkdown(cv);
  const matchingSkills = [...new Set(result.matchingSkills || [])];
  const experience = enrichExperience(parsed.experience, result, context);

  const replacements = {
    LANG: 'en',
    PAGE_WIDTH: '8.5in',
    NAME: parsed.name || 'HariKrishna Gumma',
    PHONE: parsed.phone || '',
    EMAIL: parsed.email || '',
    LINKEDIN_URL: parsed.linkedin || '#',
    LINKEDIN_DISPLAY: displayUrl(parsed.linkedin),
    PORTFOLIO_URL: parsed.github || parsed.portfolio || '#',
    PORTFOLIO_DISPLAY: displayUrl(parsed.github || parsed.portfolio),
    LOCATION: parsed.location || 'United States',
    SECTION_SUMMARY: 'Professional Summary',
    SUMMARY_TEXT: buildResumeSummary(parsed.summary, result, context),
    SECTION_COMPETENCIES: '',
    COMPETENCIES: '',
    SECTION_EXPERIENCE: 'Work Experience',
    EXPERIENCE: renderExperience(experience, matchingSkills),
    SECTION_PROJECTS: 'Projects',
    PROJECTS: renderProjects(parsed.projects, result, context),
    SECTION_EDUCATION: 'Education',
    EDUCATION: renderEducation(parsed.education),
    SECTION_CERTIFICATIONS: 'Certifications',
    CERTIFICATIONS: renderCertifications(parsed.certifications),
    SECTION_SKILLS: 'Skills',
    SKILLS: renderSkills(parsed.skills),
  };

  let html = template;
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${key}}}`, value ?? '');
  }

  html = stripCoreCompetenciesSection(html);
  html = injectProjectBulletStyles(html);
  const fontsDir = join(ROOT, 'fonts').replaceAll('\\', '/');
  html = html.replace(/url\(['"]?\.\/fonts\//g, `url('file:///${fontsDir}/`);
  return html;
}

function renderOnePageResumeHtml(result, cv, context = {}) {
  const parsed = parseCvMarkdown(cv);
  const experience = compactOnePageExperience(enrichExperience(parsed.experience, result, context));
  const project = pickOnePageProject(parsed.projects, result, context);
  const contactItems = [
    parsed.phone,
    parsed.email,
    displayUrl(parsed.linkedin),
    displayUrl(parsed.github || parsed.portfolio),
    parsed.location || 'United States',
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(parsed.name || 'HariKrishna Gumma')} - One Page Resume</title>
<style>
  @page { size: Letter; margin: 0.32in; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #ffffff;
    color: #111111;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 9.2pt;
    line-height: 1.18;
  }
  .page { width: 100%; }
  header { text-align: center; margin-bottom: 6px; }
  h1 {
    margin: 0 0 3px;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 20pt;
    line-height: 1;
    font-weight: 700;
  }
  .contact {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0 8px;
    font-size: 8.6pt;
  }
  .contact span:not(:last-child)::after {
    content: "|";
    margin-left: 8px;
  }
  section { margin-top: 7px; }
  h2 {
    margin: 0 0 3px;
    border-bottom: 1px solid #222222;
    font-size: 10.2pt;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: 0;
  }
  p { margin: 0; }
  .skills div { margin-bottom: 1px; }
  .skills strong { font-weight: 700; }
  .job { margin-top: 5px; }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: baseline;
  }
  .company, .school, .project-title { font-weight: 700; }
  .period, .location { white-space: nowrap; }
  .role { font-style: italic; margin-top: 1px; }
  ul {
    margin: 2px 0 0;
    padding-left: 16px;
  }
  li {
    margin: 0 0 1px;
    padding-left: 1px;
  }
  .education-line, .cert-line { margin-top: 2px; }
</style>
</head>
<body>
  <main class="page">
    <header>
      <h1>${escapeHtml(parsed.name || 'HariKrishna Gumma')}</h1>
      <div class="contact">${contactItems.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>
    </header>

    <section>
      <h2>Summary</h2>
      <p>${escapeHtml(buildOnePageSummary(parsed.summary, result))}</p>
    </section>

    <section>
      <h2>Technical Skills</h2>
      <div class="skills">${renderOnePageSkills(parsed.skills)}</div>
    </section>

    <section>
      <h2>Work Experience</h2>
      ${renderOnePageExperience(experience)}
    </section>

    ${project ? `<section>
      <h2>Project</h2>
      ${renderOnePageProject(project)}
    </section>` : ''}

    <section>
      <h2>Education & Certifications</h2>
      ${renderOnePageEducation(parsed.education)}
      ${renderOnePageCertifications(parsed.certifications)}
    </section>
  </main>
</body>
</html>`;
}

function buildOnePageSummary(summary, result) {
  const base = firstSentences(summary, 2)
    || 'Senior Data Engineer with 5+ years of experience building cloud ETL/ELT pipelines, reporting datasets, and production data workflows.';
  const target = `${result.title || ''} ${result.jdText || ''}`.toLowerCase();
  let roleFit = '';
  if (/fraud|risk|fintech|machine learning|\bml\b|ai\b|rag/.test(target)) {
    roleFit = 'Experienced preparing analytics-ready and ML-ready operational datasets for reporting, rules-based workflows, and decision support.';
  } else if (/cybersecurity|identity security|security posture|data lake|datalake|distributed systems|object stores|ml operations|mlops|graph data/.test(target)) {
    roleFit = 'Experienced with cloud data lake and data warehousing work, distributed Spark/Python processing, pipeline monitoring and observability, and analytics-ready datasets for cybersecurity and operational use cases.';
  } else if (/snowflake|warehouse|elt|analytics engineer|dbt|dimensional/.test(target)) {
    roleFit = 'Strengths include Snowflake, dimensional modeling, ELT processing, data quality, and BI-ready reporting layers.';
  } else if (/production|support|sla|control-m|cdc|batch|ssis/.test(target)) {
    roleFit = 'Strengths include production ETL support, batch and CDC processing, reconciliation, and reliable SLA-aligned delivery.';
  } else if (/power bi|tableau|dashboard|reporting|kpi|analytics/.test(target)) {
    roleFit = 'Strengths include BI-ready datasets, KPI reporting layers, and stakeholder-facing analytics outputs.';
  }
  return dedupeSentences([base, roleFit].filter(Boolean).join(' '));
}

function firstSentences(text, limit) {
  return String(text || '')
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, limit)
    .join(' ');
}

function renderOnePageSkills(skills) {
  const preferred = ['Programming', 'Cloud and Platforms', 'Data Engineering', 'Databases', 'BI and Analytics', 'Orchestration and DevOps'];
  const parsed = skills.map((line) => {
    const [category, ...rest] = line.split(':');
    return { category: category.trim(), values: rest.join(':').trim() };
  }).filter((item) => item.category && item.values);
  return preferred
    .map((category) => parsed.find((item) => item.category.toLowerCase() === category.toLowerCase()))
    .filter(Boolean)
    .slice(0, 5)
    .map((item) => `<div><strong>${escapeHtml(item.category)}:</strong> ${escapeHtml(compactList(item.values, 10))}</div>`)
    .join('\n');
}

function compactList(value, limit) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit)
    .join(', ');
}

function compactOnePageExperience(experience) {
  const limits = [4, 3, 2, 1];
  return experience.map((job, index) => ({
    ...job,
    bullets: (job.bullets || []).slice(0, limits[index] || 0).map(compactBullet).filter(Boolean),
  })).filter((job) => job.bullets.length);
}

function compactBullet(value) {
  const text = ensurePeriod(String(value || '').replace(/\s+/g, ' ').trim());
  if (text.length <= 185) return text;
  const shortened = text.slice(0, 182).replace(/\s+\S*$/, '');
  return ensurePeriod(shortened);
}

function renderOnePageExperience(experience) {
  return experience.map((job) => `<div class="job">
  <div class="row"><span class="company">${escapeHtml(job.company)}</span><span class="period">${escapeHtml(job.period)}</span></div>
  <div class="row"><span class="role">${escapeHtml(job.role)}</span><span class="location">${escapeHtml(job.location)}</span></div>
  <ul>${job.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>
</div>`).join('\n');
}

function pickOnePageProject(projects, result, context) {
  const terms = resumeTerms(result, context);
  const target = `${result.title || ''} ${result.jdText || ''}`.toLowerCase();
  const ranked = [...projects].sort((a, b) => scoreProject(b, terms, target) - scoreProject(a, terms, target));
  const project = ranked[0];
  if (!project) return null;
  const bullets = rankBullets(project.bullets || [], terms).slice(0, 1).map(compactBullet);
  return { ...project, bullets };
}

function scoreProject(project, terms, target) {
  const text = `${project.title || ''} ${project.tech || ''} ${(project.bullets || []).join(' ')}`.toLowerCase();
  let score = terms.reduce((value, term) => value + (text.includes(term.toLowerCase()) ? 1 : 0), 0);
  if (/ai|ml|rag|financial|stock|analytics|python|sqlite|pipeline/.test(text)) score += 2;
  if (/ai|ml|rag|fraud|risk|fintech/.test(target) && /ai|ml|rag|financial/.test(text)) score += 3;
  return score;
}

function renderOnePageProject(project) {
  return `<div class="project">
  <div class="project-title">${escapeHtml(project.title)}</div>
  <div>${escapeHtml(project.tech || '')}</div>
  ${project.bullets?.length ? `<ul>${project.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>` : ''}
</div>`;
}

function renderOnePageEducation(education) {
  return education.slice(0, 1).map((line) => `<div class="education-line">${escapeHtml(line)}</div>`).join('');
}

function renderOnePageCertifications(certifications) {
  const certs = certifications.slice(0, 4).join(' | ');
  return certs ? `<div class="cert-line"><strong>Certifications:</strong> ${escapeHtml(certs)}</div>` : '';
}

function stripCoreCompetenciesSection(html) {
  return html.replace(
    /\n\s*<!-- CORE COMPETENCIES -->\s*<div class="section">\s*<div class="section-title"><\/div>\s*<div class="competencies-grid">\s*<\/div>\s*<\/div>\s*/m,
    '\n',
  );
}

function injectProjectBulletStyles(html) {
  if (html.includes('.project-bullets')) return html;
  return html.replace('</style>', `
  .project-bullets {
    padding-left: 18px;
    margin-top: 4px;
  }

  .project-bullets li {
    font-size: 10.5px;
    line-height: 1.55;
    color: #444;
    margin-bottom: 3px;
  }
</style>`);
}

function renderPlainResumeHtml(cv) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{font-family:Arial,sans-serif;padding:.6in;line-height:1.45;color:#111827}h1{font-size:24px}h2{font-size:13px;text-transform:uppercase;color:#0f766e}</style></head><body>${escapeHtml(cv).replace(/^#\s+(.+)$/gm, '<h1>$1</h1>').replace(/^##\s+(.+)$/gm, '<h2>$1</h2>').replace(/^- (.+)$/gm, '<li>$1</li>').replace(/\n{2,}/g, '<br><br>')}</body></html>`;
}

function parseCvMarkdown(cv) {
  const name = cv.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const email = cv.match(/Email:\s*([^\n]+)/i)?.[1]?.trim();
  const phone = cv.match(/Phone:\s*([^\n]+)/i)?.[1]?.trim();
  const linkedin = cv.match(/LinkedIn:\s*(https?:\/\/\S+)/i)?.[1]?.trim();
  const github = cv.match(/GitHub:\s*(https?:\/\/\S+)/i)?.[1]?.trim();
  const summary = section(cv, 'Professional Summary').replace(/\n+/g, ' ').trim();
  const skillsLines = section(cv, 'Technical Skills').split(/\r?\n/).filter((line) => line.trim().startsWith('-'));
  const competencies = skillsLines.flatMap((line) => line.replace(/^-\s*/, '').split(':').slice(1).join(':').split(',')).map((item) => item.trim()).filter(Boolean);
  return {
    name,
    email,
    phone,
    linkedin,
    github,
    portfolio: github,
    location: 'United States',
    summary,
    skills: skillsLines.map((line) => line.replace(/^-\s*/, '').trim()),
    competencies,
    experience: parseExperience(section(cv, 'Professional Experience')),
    projects: parseProjects(section(cv, 'Projects')),
    certifications: section(cv, 'Certifications').split(/\r?\n/).filter((line) => line.trim().startsWith('-')).map((line) => line.replace(/^-\s*/, '').trim()),
    education: section(cv, 'Education').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}

function section(markdown, heading) {
  const match = markdown.match(new RegExp(`^##(?!#)\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=^##(?!#)\\s+|(?![\\s\\S]))`, 'im'));
  return match?.[1]?.trim() || '';
}

function parseExperience(text) {
  return text.split(/^###\s+/m).slice(1).map((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const [companyRole, meta = ''] = lines;
    const [company, role] = companyRole.split(/\s+-\s+/, 2);
    const [location, period] = meta.split('|').map((item) => item?.trim());
    const bullets = lines.filter((line) => line.startsWith('-')).map((line) => line.replace(/^-\s*/, '').trim());
    return { company, role, location, period, bullets };
  });
}

function parseProjects(text) {
  return text.split(/^###\s+/m).slice(1).map((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const title = lines[0] || '';
    const tech = lines.find((line) => line.toLowerCase().startsWith('technologies:'))?.replace(/^Technologies:\s*/i, '') || '';
    const bullets = lines.filter((line) => line.startsWith('-')).map((line) => line.replace(/^-\s*/, '').trim());
    return { title, tech, bullets };
  });
}

function buildResumeSummary(summary, result, context) {
  const base = summary || 'Senior Data Engineer with 5+ years of experience building reliable data pipelines, reporting datasets, and ETL/ELT workflows.';
  const targetText = `${result.title || ''} ${result.jdText || ''}`.toLowerCase();
  const tailoredSentence = inferNaturalSummarySentence(targetText);
  return dedupeSentences([base, tailoredSentence].filter(Boolean).join(' '));
}

function inferNaturalSummarySentence(targetText) {
  if (/cybersecurity|identity security|security posture|data lake|datalake|distributed systems|object stores|ml operations|mlops|graph data/.test(targetText)) {
    return 'Experience aligns with cloud data lake and data warehousing work, distributed Spark/Python processing, pipeline monitoring and observability, and analytics-ready datasets for cybersecurity and operational use cases.';
  }
  if (/fraud|risk|fintech|machine learning|\bml\b|agentic|agents|ai\b/.test(targetText)) {
    return 'Additional experience includes preparing analytics-ready and ML-ready datasets from operational data to support reporting, rules-based workflows, and decision support.';
  }
  if (/snowflake|warehouse|elt|analytics engineer|dbt|dimensional/.test(targetText)) {
    return 'Strong background in warehouse processing, dimensional modeling, reporting datasets, and data quality for business analytics.';
  }
  if (/production|support|sla|control-m|cdc|batch|ssis/.test(targetText)) {
    return 'Strong background in production ETL support, batch and CDC processing, reconciliation, and SLA-aligned delivery.';
  }
  if (/power bi|tableau|dashboard|reporting|kpi|analytics/.test(targetText)) {
    return 'Experienced in building BI-ready datasets, KPI reporting layers, and stakeholder-facing analytics outputs.';
  }
  if (/sql|database|pl\/sql|plsql|oracle|stored procedure/.test(targetText)) {
    return 'Strong background in SQL development, backend data layers, query tuning, stored procedures, and reliable data retrieval.';
  }
  return '';
}

function enrichExperience(experience, result, context) {
  const terms = resumeTerms(result, context);
  return experience.map((job, index) => {
    const sourceBullets = job.bullets || [];
    const digestBullets = digestBulletsForCompany(job.company, context.articleDigest);
    const limit = bulletLimitForJob(job, index);
    const digestLimit = digestBulletLimitForJob(job, index);
    const selectedDigest = rankBullets(digestBullets, terms)
      .filter((bullet) => scoreBullet(bullet, terms.map((term) => term.toLowerCase())) > 0)
      .slice(0, digestLimit);
    const selectedSource = rankBullets(sourceBullets, terms);
    const combined = dedupeBullets([...selectedDigest, ...selectedSource]);
    return {
      ...job,
      bullets: combined.slice(0, limit),
    };
  });
}

function bulletLimitForJob(job, index) {
  const company = String(job.company || '').toLowerCase();
  if (index === 0 || company.includes('charter')) return 6;
  if (company.includes('t-mobile')) return 5;
  if (company.includes('citibank')) return 4;
  return 3;
}

function digestBulletLimitForJob(job, index) {
  const company = String(job.company || '').toLowerCase();
  if (index === 0 || company.includes('charter')) return 3;
  if (company.includes('t-mobile')) return 2;
  if (company.includes('citibank')) return 2;
  return 1;
}

function resumeTerms(result, context) {
  const skills = result.matchingSkills || [];
  const target = `${result.title || ''} ${result.jdText || ''}`;
  const profileTerms = extractKnownSkills(`${context.profileYml || ''}\n${context.profileMd || ''}`);
  const themeTerms = [];
  if (/azure|adf|databricks/i.test(target)) themeTerms.push('Azure Data Factory', 'Azure Databricks', 'PySpark');
  if (/cybersecurity|identity security|security posture|data lake|datalake|distributed|object stores|ml operations|mlops|graph data|observability/i.test(target)) {
    themeTerms.push('data lake', 'distributed processing', 'monitoring', 'observability', 'ML Operations', 'Python', 'Spark');
  }
  if (/snowflake|warehouse|analytics engineer/i.test(target)) themeTerms.push('Snowflake', 'data modeling', 'ELT');
  if (/production|etl|support|sla|control-m|cdc/i.test(target)) themeTerms.push('Control-M', 'CDC', 'production support');
  if (/power bi|tableau|reporting|dashboard/i.test(target)) themeTerms.push('Power BI', 'Tableau', 'KPI reporting');
  return [...new Set([...skills, ...profileTerms, ...themeTerms])];
}

function buildResumeTailoringQa(html, result, context = {}) {
  const resumeText = normalizeForMatch(htmlToText(html));
  const jdText = normalizeForMatch(`${result.title || ''} ${result.jdText || ''}`);
  const requiredTerms = extractResumeQaTerms(jdText, result);
  const matchedTerms = requiredTerms.filter((term) => termMatches(resumeText, term));
  const missingTerms = requiredTerms.filter((term) => !termMatches(resumeText, term)).slice(0, 8);
  const digestBullets = digestBulletsForQa(context.articleDigest);
  const articleDigestCandidateCount = digestBullets.length;
  const usedDigestBullets = findUsedDigestBullets(resumeText, digestBullets).slice(0, 8);
  const articleDigestBulletCount = usedDigestBullets.length;
  const articleDigestUsed = articleDigestBulletCount > 0;
  const coverage = requiredTerms.length ? matchedTerms.length / requiredTerms.length : 1;
  const suspiciousPhrases = findSuspiciousResumePhrases(resumeText);
  const repeatedMetrics = findRepeatedMetrics(resumeText);
  const unsupportedClaims = findUnsupportedClaims(resumeText, `${result.jdText || ''} ${context.articleDigest || ''}`);
  let score = Math.round((coverage * 75) + (articleDigestUsed ? 15 : 0) + (resumeText.includes('professional summary') || resumeText.includes('summary') ? 10 : 0));
  if (missingTerms.length >= 5) score = Math.min(score, 69);
  if (suspiciousPhrases.length || repeatedMetrics.length || unsupportedClaims.length) score = Math.min(score, 74);
  const status = score >= 80 && missingTerms.length <= 3 && !suspiciousPhrases.length && !unsupportedClaims.length
    ? 'strong_match'
    : score >= 65 ? 'review_recommended' : 'needs_review';
  const checks = [
    `JD keyword coverage: ${matchedTerms.length}/${requiredTerms.length || 0}`,
    articleDigestUsed
      ? `article-digest.md contributed ${articleDigestBulletCount} selected resume bullet${articleDigestBulletCount === 1 ? '' : 's'}`
      : `No article-digest.md bullets were selected for this resume (${articleDigestCandidateCount} candidate bullets reviewed)`,
    missingTerms.length
      ? `Review missing JD terms: ${missingTerms.join(', ')}`
      : 'No major JD terms missing from the resume text',
    suspiciousPhrases.length ? `Remove suspicious phrases: ${suspiciousPhrases.join(', ')}` : 'No suspicious AI-sounding phrases found',
    repeatedMetrics.length ? `Review repeated metrics: ${repeatedMetrics.join(', ')}` : 'No repeated high-signal metrics found',
    unsupportedClaims.length ? `Review unsupported claims: ${unsupportedClaims.join(', ')}` : 'No obvious unsupported claim patterns found',
  ];
  return {
    status,
    score: Math.min(100, Math.max(0, score)),
    matchedTerms: matchedTerms.slice(0, 12),
    missingTerms,
    articleDigestUsed,
    articleDigestCandidateCount,
    articleDigestBulletCount,
    usedDigestBullets,
    suspiciousPhrases,
    repeatedMetrics,
    unsupportedClaims,
    summary: resumeQaSummary(status, score, missingTerms, articleDigestUsed),
    checks,
  };
}

function extractResumeQaTerms(jdText, result = {}) {
  const known = [
    'Python', 'SQL', 'Spark', 'Databricks', 'Snowflake', 'Azure', 'Azure Data Factory',
    'data lake', 'data modeling', 'data warehousing', 'distributed processing',
    'object stores', 'real-time processing', 'graph data stores', 'ML Operations',
    'MLOps', 'CI/CD', 'monitoring', 'observability', 'cybersecurity',
    'identity security', 'security posture', 'analytics', 'ETL', 'ELT',
    'pipeline performance', 'data quality',
  ];
  const text = normalizeForMatch(jdText);
  const found = known.filter((term) => termMatches(text, term));
  const matchedSkills = (result.matchingSkills || []).filter((term) => termMatches(text, term));
  return [...new Set([...found, ...matchedSkills])].slice(0, 18);
}

function digestBulletsForQa(articleDigest = '') {
  return String(articleDigest || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('*'))
    .map((line) => line.replace(/^\*\s*/, '').replace(/\*\*/g, '').trim())
    .filter(isResumeQualityBullet);
}

function findUsedDigestBullets(resumeText, digestBullets = []) {
  const normalizedResume = normalizeForMatch(resumeText);
  return digestBullets.filter((bullet) => digestBulletAppearsInResume(normalizedResume, bullet));
}

function digestBulletAppearsInResume(normalizedResume, bullet) {
  const normalizedBullet = normalizeForMatch(bullet);
  if (!normalizedResume || !normalizedBullet) return false;
  if (normalizedResume.includes(normalizedBullet.slice(0, 100))) return true;
  const words = normalizedBullet
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !RESUME_QA_STOP_WORDS.has(word))
    .slice(0, 18);
  if (words.length < 5) return false;
  const hits = words.filter((word) => normalizedResume.includes(word)).length;
  return hits >= Math.min(8, Math.ceil(words.length * 0.6));
}

function findSuspiciousResumePhrases(text) {
  const phrases = [
    'focused fit for this role',
    'relevant strengths include',
    'where data engineering overlaps with ai use cases',
    'as an ai language model',
    'tailored for this role',
  ];
  return phrases.filter((phrase) => text.includes(phrase));
}

function findRepeatedMetrics(text) {
  const metrics = ['0.5-2 tb/day', '50k-300k', '30-40%', '40%', '25%', '30%'];
  return metrics.filter((metric) => {
    const escaped = metric.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const matches = text.match(new RegExp(escaped, 'gi')) || [];
    return matches.length > 1;
  });
}

function findUnsupportedClaims(resumeText, evidenceText) {
  const evidence = normalizeForMatch(evidenceText);
  const claims = [
    ['graph data stores', 'graph data stores'],
    ['identity security', 'identity security'],
    ['cybersecurity', 'cybersecurity'],
    ['mlops', 'mlops'],
    ['real-time processing', 'real-time processing'],
  ];
  return claims
    .filter(([claim, evidenceTerm]) => termMatches(resumeText, claim) && !termMatches(evidence, evidenceTerm))
    .map(([claim]) => claim);
}

function termMatches(text, term) {
  const normalizedText = normalizeForMatch(text);
  const normalizedTerm = normalizeForMatch(term);
  if (!normalizedTerm) return false;
  if (normalizedText.includes(normalizedTerm)) return true;
  const compactTerm = normalizedTerm.replace(/[^a-z0-9]+/g, '');
  const compactText = normalizedText.replace(/[^a-z0-9]+/g, '');
  return compactTerm.length >= 6 && compactText.includes(compactTerm);
}

function normalizeForMatch(value) {
  return cleanDisplayText(String(value || ''))
    .toLowerCase()
    .replace(/\bml operations\b/g, 'mlops')
    .replace(/\bdatalake\b/g, 'data lake')
    .replace(/[^a-z0-9+/#.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function resumeQaSummary(status, score, missingTerms, articleDigestUsed) {
  const statusText = status === 'strong_match'
    ? 'Resume tailoring looks strong for this JD.'
    : status === 'review_recommended'
      ? 'Resume tailoring is usable, but manual review is recommended.'
      : 'Resume tailoring needs manual review before applying.';
  const digestText = articleDigestUsed
    ? 'Extra experience bullets from article-digest.md were used.'
    : 'No extra article-digest.md bullets were selected.';
  const missingText = missingTerms.length ? ` Missing terms: ${missingTerms.join(', ')}.` : '';
  return `${statusText} QA score: ${score}/100. ${digestText}${missingText}`;
}

function digestBulletsForCompany(company, articleDigest) {
  if (!articleDigest) return [];
  const digestSection = companyDigestSection(company, articleDigest);
  if (!digestSection) return [];

  return digestSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('*'))
    .map((line) => line.replace(/^\*\s*/, '').replace(/\*\*/g, '').trim())
    .map(sentenceCase)
    .map(ensurePeriod)
    .filter(isResumeQualityBullet)
    .slice(0, 12);
}

function companyDigestSection(company, articleDigest) {
  const companyText = String(company || '').toLowerCase();
  const sections = [
    { match: 'charter', pattern: /## 1\)[\s\S]*?(?=\n## 2\))/m },
    { match: 't-mobile', pattern: /## 2\)[\s\S]*?(?=\n## 3\))/m },
    { match: 'citibank', pattern: /## 3\)[\s\S]*?(?=\n## 4\))/m },
    { match: 'm.j', pattern: /## 4\)[\s\S]*?(?=\n# Cross-project|\n## Theme|$)/m },
  ];
  const section = sections.find((item) => companyText.includes(item.match));
  return section ? articleDigest.match(section.pattern)?.[0] || '' : '';
}

function isResumeQualityBullet(bullet) {
  if (!bullet || bullet.length < 55 || bullet.length > 210) return false;
  if (/^(azure databricks|pyspark|sql|python|tableau|cdc|etl|elt|uat|indexes|views|triggers|packages)\.?$/i.test(bullet)) return false;
  if (/strongest when positioned|good resume|useful positioning|business problem|project context/i.test(bullet)) return false;
  if (/^Used\b/i.test(bullet) && !/\b(0\.5-2 TB|50K-300K|30-40%|40%|25%|30%|improv|reduc|support|standardiz|orchestrat|process|deliver|reliab|consistency)\b/i.test(bullet)) return false;
  return /^(Analyzed|Automated|Built|Collaborated|Compared|Created|Designed|Developed|Engineered|Extracted|Focused|Handled|Implemented|Improved|Integrated|Investigated|Led|Maintained|Modeled|Monitored|Optimized|Orchestrated|Performed|Prepared|Reduced|Resolved|Supported|Tested|Transformed|Troubleshot|Used|Validated|Wrote)/i.test(bullet)
    || /\b(improved|reduced|built|developed|supported|optimized|prepared|handled|processed|0\.5-2 TB|50K-300K|30-40%|40%)\b/i.test(bullet);
}

function dedupeBullets(bullets) {
  const seen = new Set();
  const picked = [];
  for (const bullet of bullets.map((item) => ensurePeriod(String(item || '').trim())).filter(Boolean)) {
    const key = bullet.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const compact = key.split(' ').slice(0, 10).join(' ');
    if (!compact || seen.has(compact)) continue;
    seen.add(compact);
    picked.push(bullet);
  }
  return picked;
}

function dedupeSentences(text) {
  const seen = new Set();
  return text.split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => {
      const key = sentence.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ');
}

function sentenceCase(value) {
  const text = String(value || '').trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : '';
}

function ensurePeriod(value) {
  const text = String(value || '').trim();
  return text && !/[.!?]$/.test(text) ? `${text}.` : text;
}

function renderExperience(experience, matchingSkills) {
  return experience.map((job) => {
    const bullets = job.bullets?.length ? job.bullets : rankBullets(job.bullets || [], matchingSkills).slice(0, 3);
    return `<div class="job">
  <div class="job-header"><div><span class="job-company">${escapeHtml(job.company)}</span></div><div class="job-period">${escapeHtml(job.period)}</div></div>
  <div class="job-role">${escapeHtml(job.role)} <span class="job-location">| ${escapeHtml(job.location)}</span></div>
  <ul>${bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>
</div>`;
  }).join('\n');
}

function renderProjects(projects, result, context) {
  const terms = resumeTerms(result, context);
  return projects.slice(0, 2).map((project) => {
    const bullets = rankBullets(project.bullets || [], terms).slice(0, 3);
    return `<div class="project">
  <div class="project-title">${escapeHtml(project.title)} <span class="project-badge">Project</span></div>
  <ul class="project-bullets">${bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>
  <div class="project-tech">${escapeHtml(project.tech)}</div>
</div>`;
  }).join('\n');
}

function renderEducation(education) {
  return education.map((line) => {
    const year = line.match(/\b(19|20)\d{2}\b/)?.[0] || '';
    const title = year ? line.replace(new RegExp(`,?\\s*${year}\\s*$`), '') : line;
    return `<div class="edu-item"><div class="edu-header"><div class="edu-title">${escapeHtml(title)}</div><div class="edu-year">${escapeHtml(year)}</div></div></div>`;
  }).join('\n');
}

function renderCertifications(certifications) {
  return `<div class="cert-inline">${certifications.map(escapeHtml).join(' <span class="separator">|</span> ')}</div>`;
}

function renderSkills(skills) {
  return `<div class="skills-grid">${skills.map((line) => {
    const [category, ...rest] = line.split(':');
    return `<div class="skill-item"><span class="skill-category">${escapeHtml(category)}:</span> ${escapeHtml(rest.join(':').trim())}</div>`;
  }).join('\n')}</div>`;
}

function rankBullets(bullets, skills) {
  const terms = (skills || []).map((skill) => skill.toLowerCase());
  return [...bullets].sort((a, b) => scoreBullet(b, terms) - scoreBullet(a, terms));
}

function scoreBullet(bullet, terms) {
  const lower = bullet.toLowerCase();
  let score = terms.reduce((value, term) => value + (lower.includes(term) ? 1 : 0), 0);
  if (/\b(0\.5-2 TB|50K-300K|30-40%|40%|25%|30%)\b/i.test(bullet)) score += 3;
  if (/\b(improved|reduced|optimized|standardized|orchestrated|resolved|implemented|built|developed|prepared|supported)\b/i.test(bullet)) score += 1;
  if (/^Used\b/i.test(bullet)) score -= 2;
  return score;
}

function displayUrl(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createFallbackReport(jdPath, reason, sourceUrl = '') {
  const jdText = readFileSync(jdPath, 'utf-8');
  const summary = heuristicSummary(jdText, sourceUrl);
  const num = nextReportNumber();
  const date = new Date().toISOString().slice(0, 10);
  const filename = `${num}-${slugify(summary.company)}-${date}.md`;
  const reportPath = join(ROOT, 'reports', filename);
  mkdirSync(join(ROOT, 'reports'), { recursive: true });
  writeFileSync(reportPath, `# Evaluation: ${summary.company} - ${summary.title}

**Date:** ${date}
**URL:** ${sourceUrl || 'manual'}
**Archetype:** Local web fallback
**Score:** ${summary.score}/5
**Legitimacy:** Needs Review
**PDF:** pending
**Tool:** Career-Ops Web App fallback

---

${reason}

## Summary
${summary.summary}

## Matching Skills
${summary.matchingSkills.map((skill) => `- ${skill}`).join('\n')}

## Missing Skills / Review Areas
${summary.missingSkills.map((skill) => `- ${skill}`).join('\n')}

## Risks
${summary.risks.map((risk) => `- ${risk}`).join('\n')}
`, 'utf-8');
  return reportPath;
}

function heuristicSummary(jdText, url = '') {
  const title = extractField(jdText, 'title') || extractField(jdText, 'role')
    || jdText.match(/\b(Senior|Staff|Lead|Principal)?\s*(Data|Software|Backend|Frontend|Full Stack|Cloud|DevOps|AI|ML)\s+Engineer\b/i)?.[0]
    || 'Job opportunity';
  const company = extractField(jdText, 'company')
    || (url ? new URL(url).hostname.replace(/^www\./, '').split('.')[0] : 'Unknown company');
  const skills = extractKnownSkills(jdText);
  return {
    company,
    title,
    score: skills.length >= 8 ? 4.1 : skills.length >= 5 ? 3.7 : 3.2,
    summary: `Initial local analysis found ${skills.length} recognizable technical keywords. Add GEMINI_API_KEY for the full Career-Ops A-G evaluation.`,
    matchingSkills: skills.slice(0, 8),
    missingSkills: ['Review job-specific requirements manually', 'Confirm sponsorship/location constraints'],
    risks: ['This is a fallback analysis, not the full AI evaluation.', 'URL-only pages may require pasted job description text.'],
  };
}

function extractField(text, field) {
  return text.match(new RegExp(`${field}\\s*[:\\-]\\s*([^.;\\n]+)`, 'i'))?.[1]?.trim();
}

function extractKnownSkills(text) {
  const known = ['Java', 'Python', 'SQL', 'AWS', 'Azure', 'GCP', 'Spring Boot', 'React', 'Node.js', 'TypeScript', 'Kubernetes', 'Docker', 'Terraform', 'Databricks', 'Snowflake', 'Spark', 'Kafka', 'PostgreSQL', 'MongoDB', 'Airflow', 'dbt', 'ETL', 'CI/CD', 'Microservices'];
  const lower = text.toLowerCase();
  return known.filter((skill) => lower.includes(skill.toLowerCase()));
}

function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, '&');
}

function isRecoverableGeminiError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('429')
    || message.includes('quota')
    || message.includes('rate limit')
    || message.includes('too many requests')
    || message.includes('api_key')
    || message.includes('api key');
}

function recoverableGeminiMessage(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('429') || message.includes('quota') || message.includes('rate limit') || message.includes('too many requests')) {
    return 'Gemini free-tier quota or rate limit was reached. Created a local fallback report so the run can still complete. Wait a minute, or retry later for the full AI evaluation.';
  }
  if (message.includes('api_key') || message.includes('api key')) {
    return 'Gemini API key is missing or invalid. Created a local fallback report so the run can still complete.';
  }
  return 'Gemini evaluator was unavailable. Created a local fallback report so the run can still complete.';
}

function englishSummary({ company, title, score, recommendation, fallbackSummary }) {
  const cleanCompany = cleanDisplayText(company || 'the company');
  const cleanTitle = cleanDisplayText(title || 'this role');
  const cleanRecommendation = cleanDisplayText(recommendation || scoreToRecommendation(score));
  if (!looksLikeReportTable(fallbackSummary)) {
    const cleanFallback = cleanDisplayText(fallbackSummary || '');
    if (cleanFallback && isMostlyEnglish(cleanFallback) && !looksLikeGenericRunSummary(cleanFallback)) return cleanFallback;
  }
  const scoreText = Number.isFinite(Number(score)) ? ` with a score of ${Number(score)}/5` : '';
  return `Career-Ops completed an English-ready evaluation for ${cleanTitle} at ${cleanCompany}${scoreText}. Recommendation: ${cleanRecommendation}. Review the run detail for matching skills, gaps, risks, report, resume PDF, and apply link.`;
}

function looksLikeGenericRunSummary(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('this role at the company')
    || text.includes('for this role at the company')
    || text.includes('review the run detail for matching skills')
    || text.includes('add geminiapikey')
    || text.includes('careerops ag evaluation')
    || text.includes('archetype detected')
    || text.includes('team size:')
    || text.includes('tl;dr:')
    || text.includes('domain:')
    || text.includes('function:');
}

function looksLikeReportTable(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('| dimension')
    || text.includes('| dimensi')
    || text.includes('| detalle')
    || text.includes('arquetipo')
    || text.includes('dominio')
    || text.includes('funci')
    || text.includes('descripcion')
    || text.includes('construir')
    || text.includes('operar');
}

function isMostlyEnglish(value) {
  const text = String(value || '').toLowerCase();
  return !/( arquetipo | dominio | función | funcion | remoto | híbrido | hibrido | tamaño | descripcion | descripción | construir | operar | no especificado )/.test(` ${text} `);
}

function cleanDisplayText(value) {
  return String(value || '')
    .replace(/â€™|â€˜|Ã¢â‚¬â„¢/g, "'")
    .replace(/â€œ|â€|Ã¢â‚¬Å“|Ã¢â‚¬Â/g, '"')
    .replace(/â€“|â€”|Ã¢â‚¬â€œ|Ã¢â‚¬â€/g, '-')
    .replace(/â€¢/g, '-')
    .replace(/Â/g, '')
    .replace(/Ã©/g, 'e')
    .replace(/Ã³/g, 'o')
    .replace(/Ã¡/g, 'a')
    .replace(/Ã­/g, 'i')
    .replace(/Ãº/g, 'u')
    .replace(/Ã±/g, 'n')
    .replace(/Ã¼/g, 'u')
    .replace(/\u00c3\u00a2\u00e2\u201a\u00ac\u00e2\u20ac[\u009c\u009d]/g, '-')
    .replace(/\u00c3\u00a9/g, 'e')
    .replace(/\u00c3\u00b3/g, 'o')
    .replace(/\u00c3\u00a1/g, 'a')
    .replace(/\u00c3\u00ad/g, 'i')
    .replace(/\u00c3\u00ba/g, 'u')
    .replace(/\u00c3\u00b1/g, 'n')
    .replace(/\u00c3\u00bc/g, 'u')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function findNewestReport(afterMs) {
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) return '';
  const candidates = readdirSync(reportsDir)
    .filter((file) => file.endsWith('.md') && /^\d{3}-/.test(file))
    .map((file) => join(reportsDir, file))
    .filter((file) => statSync(file).mtimeMs >= afterMs - 2000)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates[0] || '';
}

function nextReportNumber() {
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) return '001';
  const nums = readdirSync(reportsDir).map((file) => Number(file.slice(0, 3))).filter(Number.isFinite);
  return String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0');
}

function firstParagraphAfterHeading(text, labels) {
  for (const label of labels) {
    const idx = text.toLowerCase().indexOf(label.toLowerCase());
    if (idx >= 0) {
      return text.slice(idx).split(/\n{2,}/).find((p) => p.trim().length > 40)?.replace(/[#*_`>-]/g, '').trim();
    }
  }
  return text.split(/\n{2,}/).find((p) => p.trim().length > 80)?.replace(/[#*_`>-]/g, '').trim() || '';
}

function pickSkills(text, positive) {
  const sectionWords = positive ? ['match', 'strength', 'skill'] : ['missing', 'gap', 'risk'];
  return pickBulletsNear(text, sectionWords).flatMap((line) => extractKnownSkills(line)).slice(0, 8);
}

function pickBulletsNear(text, words) {
  const lines = text.split(/\r?\n/);
  const picked = [];
  let active = false;
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/^#{1,4}\s/.test(line)) active = words.some((word) => lower.includes(word));
    if (active && /^\s*[-*]\s+/.test(line)) picked.push(line.replace(/^\s*[-*]\s+/, '').trim());
    if (picked.length >= 8) break;
  }
  return picked;
}

function scoreToRecommendation(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'Review';
  if (value >= 4.2) return 'Apply';
  if (value >= 3.5) return 'Maybe';
  return 'Skip';
}

function slugify(value) {
  return String(value || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}
