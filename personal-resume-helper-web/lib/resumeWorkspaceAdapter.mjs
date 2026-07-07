import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateJobUrl } from './urlSafety.mjs';

const APP_ROOT = process.cwd();
const ROOT = resolve(process.env.RESUME_WORKSPACE_PATH || process.env.CAREER_OPS_PATH || join(process.cwd(), '..', 'Resume-Workspace'));
const JDS_DIR = join(ROOT, 'jds');
const LEGACY_LOG_DIR = join(ROOT, 'webapp', 'storage', 'logs');
const OUTPUT_DIR = join(ROOT, 'output');
const CACHE_DIR = join(APP_ROOT, 'data', 'cache');
const RUNTIME_DIR = join(APP_ROOT, 'data', 'resume-workspace-runtime');
const FALLBACK_JDS_DIR = join(RUNTIME_DIR, 'jds');
const FALLBACK_REPORTS_DIR = join(RUNTIME_DIR, 'reports');
const FALLBACK_OUTPUT_DIR = join(RUNTIME_DIR, 'output');
const LOG_DIR = join(RUNTIME_DIR, 'logs');
const PDF_TEMP_DIR = join(process.env.TEMP || process.env.TMP || APP_ROOT, 'personal-resume-helper-pdf');
const REPORTLAB_RENDERER = join(APP_ROOT, 'lib', 'reportlab_resume_pdf.py');
const JD_CACHE_DIR = join(CACHE_DIR, 'job-descriptions');
const GEMINI_CACHE_DIR = join(CACHE_DIR, 'gemini-evaluations');
const DEFAULT_TIMEOUT_MS = Number(process.env.RESUME_WORKSPACE_TIMEOUT_MS || 300000);
const JD_CACHE_TTL_MS = Number(process.env.JD_CACHE_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const GEMINI_CACHE_TTL_MS = Number(process.env.GEMINI_CACHE_TTL_MS || 14 * 24 * 60 * 60 * 1000);
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

export async function runResumeWorkspaceAnalysis(input, onStatus = () => {}) {
  ensurePrimaryOrFallbackDir(JDS_DIR, FALLBACK_JDS_DIR);
  safeMkdir(FALLBACK_JDS_DIR);
  safeMkdir(LOG_DIR);
  ensurePrimaryOrFallbackDir(OUTPUT_DIR, FALLBACK_OUTPUT_DIR);

  const urlCheck = validateJobUrl(input.jobUrl);
  if (!urlCheck.ok) throw new Error(urlCheck.error);

  onStatus('fetching_job');
  const jdText = await resolveJobDescription(input.jobDescription, urlCheck.url);
  if (!jdText || jdText.length < 80) {
    if (isBullhornOscpUrl(urlCheck.url)) {
      throw new Error('This Bullhorn job board loads job details inside the browser and did not expose enough public text to fetch automatically. Paste the JD text in Job Description and retry.');
    }
    throw new Error('Could not extract enough job description text. Paste the JD manually and retry.');
  }
  const applyUrl = extractMetadataLine(jdText, 'Apply URL') || input.jobUrl || '';

  const jdPath = writeTextFileWithFallback(
    join(JDS_DIR, `webapp-${input.runId}.txt`),
    join(FALLBACK_JDS_DIR, `webapp-${input.runId}.txt`),
    jdText,
  );

  onStatus('analyzing');
  let evalResult;
  try {
    evalResult = await runGeminiEvaluator(jdPath, input.runId);
  } catch (error) {
    if (!isRecoverableGeminiError(error) && !isRecoverableLocalProcessError(error)) throw error;
    const reason = recoverableGeminiMessage(error);
    const reportPath = createFallbackReport(jdPath, reason, input.jobUrl);
    const logPath = join(LOG_DIR, `${input.runId}.log`);
    const rawError = String(error?.message || error || '');
    writeTextFile(logPath, `${reason}\n\nOriginal Gemini error:\n${rawError}`);
    evalResult = { reportPath, stdout: reason, stderr: rawError, logPath };
  }

  const report = evalResult.reportPath ? parseResumeWorkspaceReport(evalResult.reportPath) : {};
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
    reportPath: evalResult.reportPath ? artifactRelative(evalResult.reportPath) : '',
    resumePdfPath: '',
    resumeMode: input.resumeMode === 'one_page' ? 'one_page' : 'two_page',
    applyUrl,
    rawOutput: evalResult.stdout,
    logPath: artifactRelative(evalResult.logPath),
    resumeProfileId: input.resumeProfileId || '',
    resumeProfileLabel: input.resumeProfileLabel || '',
    resumeProfileSourceDir: input.resumeProfileSourceDir || '',
  };

  if (input.generateResume !== false) {
    onStatus('generating_resume');
    try {
      const resumeResult = await generateResumePdf({ ...result, jdText, runId: input.runId, resumeMode: result.resumeMode, resumeContext: input.resumeContext });
      result.resumePdfPath = resumeResult.resumePdfPath;
      result.resumeHtmlPath = resumeResult.resumeHtmlPath;
      result.resumeDocxPath = resumeResult.resumeDocxPath;
      result.resumeDocxError = resumeResult.resumeDocxError;
      result.resumeDocxErrorLogPath = resumeResult.resumeDocxErrorLogPath;
      result.resumePdfError = resumeResult.resumePdfError;
      result.resumePdfErrorLogPath = resumeResult.resumePdfErrorLogPath;
      result.resumeQa = resumeResult.resumeQa;
      if (resumeResult.resumePdfError) {
        result.risks = mergeShortList(result.risks, ['Resume PDF rendering was blocked locally. Review the saved resume HTML and retry PDF generation after restarting the app.'], 5);
      }
    } catch (error) {
      result.resumePdfError = pdfWorkerErrorMessage(error);
      result.resumePdfErrorLogPath = writeResumeGenerationErrorLog(input.runId, error);
      result.risks = mergeShortList(result.risks, ['Resume generation was blocked locally. The job analysis and report were saved; retry resume generation after restarting the app.'], 5);
    }
  }

  if (input.generateCoverLetter) {
    result.coverLetterPath = generateCoverLetter({ ...result, jdText, runId: input.runId });
  }

  return result;
}

async function resolveJobDescription(jobDescription, jobUrl) {
  const manualDescription = normalizeManualJobDescription(jobDescription);
  if (manualDescription) return manualDescription;
  if (!jobUrl) return '';

  const cacheKey = cacheKeyFor('jd', jobUrl);
  const cached = readCacheRecord(JD_CACHE_DIR, cacheKey, JD_CACHE_TTL_MS);
  if (cached?.text && String(cached.text).length >= 80) return cached.text;

  const atsText = await tryAtsApi(jobUrl).catch(() => '');
  if (atsText) {
    writeCacheRecord(JD_CACHE_DIR, cacheKey, {
      source: 'ats',
      jobUrl,
      text: atsText,
    });
    return atsText;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await safeFetch(jobUrl, { signal: controller.signal });
    if (!res.ok) throw new Error(jobPageFetchError(res.status));
    const html = await res.text();
    const text = htmlToText(html).slice(0, 30000);
    if (text.length >= 80) {
      writeCacheRecord(JD_CACHE_DIR, cacheKey, {
        source: 'page',
        jobUrl,
        text,
      });
    }
    return text;
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

  const bullhornJobId = bullhornJobIdFromUrl(url);
  if (bullhornJobId) {
    const text = await tryBullhornOscpJob(url, bullhornJobId, jobUrl);
    if (text) return text;
  }

  return '';
}

function bullhornJobIdFromUrl(url) {
  const hashMatch = String(url.hash || '').match(/\/jobs\/(\d+)/i);
  if (hashMatch) return hashMatch[1];
  const pathMatch = String(url.pathname || '').match(/\/jobs\/(\d+)/i);
  return pathMatch?.[1] || '';
}

function isBullhornOscpUrl(jobUrl = '') {
  try {
    const url = new URL(jobUrl);
    return /bullhorn-oscp/i.test(`${url.pathname} ${url.hash}`);
  } catch {
    return false;
  }
}

async function tryBullhornOscpJob(url, jobId, jobUrl) {
  const origin = `${url.protocol}//${url.host}`;
  const candidates = [
    `${origin}/wp-json/bullhorn-oscp/v1/jobs/${jobId}`,
    `${origin}/wp-json/bullhorn-oscp/v1/job/${jobId}`,
    `${origin}/wp-json/bhoscp/v1/jobs/${jobId}`,
    `${origin}/wp-json/bhoscp/v1/job/${jobId}`,
    `${origin}/wp-json/wp/v2/bullhorn_job/${jobId}`,
  ];
  for (const apiUrl of candidates) {
    const json = await fetchJson(apiUrl).catch(() => null);
    const text = formatBullhornJob(json, jobUrl);
    if (text) return text;
  }
  return '';
}

function formatBullhornJob(json, fallbackUrl) {
  const job = Array.isArray(json) ? json[0] : (json?.job || json?.data || json);
  if (!job || typeof job !== 'object') return '';
  const title = firstUseful(job.title?.rendered, job.title, job.name, job.jobTitle, job.publicTitle, job.position);
  const company = firstUseful(job.companyName, job.clientCorporation?.name, job.company, job.client, 'Client Resources Inc');
  const location = firstUseful(
    job.location,
    job.address?.city && job.address?.state ? `${job.address.city}, ${job.address.state}` : '',
    job.city && job.state ? `${job.city}, ${job.state}` : '',
  );
  const description = firstUseful(
    job.content?.rendered,
    job.description,
    job.publicDescription,
    job.externalDescription,
    job.jobDescription,
    job.text,
  );
  const cleanDescription = htmlToText(decodeHtml(description || ''));
  if (!title && cleanDescription.length < 80) return '';
  return [
    `Company: ${company || 'Client Resources Inc'}`,
    `Title: ${title || 'Unknown role'}`,
    location ? `Location: ${location}` : '',
    `Apply URL: ${job.applyUrl || job.url || fallbackUrl}`,
    '',
    cleanDescription,
  ].filter(Boolean).join('\n');
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
      'user-agent': 'Resume Workspace-WebApp/0.1',
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
  const jdText = existsSync(jdPath) ? readFileSync(jdPath, 'utf-8') : '';
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
  const cacheKey = cacheKeyFor('gemini-eval', `${model}\n${jdText}`);
  const cached = readGeminiEvalCache(cacheKey);
  if (cached) {
    const logPath = join(LOG_DIR, `${runId}.log`);
    writeTextFile(logPath, `CACHE HIT: reused Gemini evaluation ${cacheKey}\nREPORT: ${cached.reportPath}\n`);
    return {
      ...cached.summary,
      reportPath: cached.reportPath,
      stdout: `Reused cached Gemini evaluation for this exact job description. Cache key: ${cacheKey}`,
      stderr: '',
      logPath,
      cacheHit: true,
    };
  }

  if (!hasUsableGeminiApiKey(process.env.GEMINI_API_KEY)) {
    const message = 'GEMINI_API_KEY is not configured. Created a local fallback report instead.';
    const reportPath = createFallbackReport(jdPath, message);
    const logPath = join(LOG_DIR, `${runId}.log`);
    writeTextFile(logPath, message);
    return { reportPath, stdout: message, stderr: '', logPath };
  }

  if (!existsSync(join(ROOT, 'gemini-eval.mjs'))) {
    const message = 'Resume Workspace Gemini evaluator is not installed in the local Resume Workspace folder. Created a local fallback report instead.';
    const reportPath = createFallbackReport(jdPath, message);
    const logPath = join(LOG_DIR, `${runId}.log`);
    writeTextFile(logPath, message);
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
  writeTextFile(logPath, `COMMAND: ${process.execPath} ${args.join(' ')}\n\nSTDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`);

  if (code !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `Resume Workspace evaluator exited with code ${code}`);
  }

  const reportPath = findNewestReport(before);
  if (reportPath) {
    writeGeminiEvalCache(cacheKey, {
      reportPath,
      summary: parseEvaluatorStdout(stdout),
      model,
    });
  }

  return {
    ...parseEvaluatorStdout(stdout),
    reportPath,
    stdout,
    stderr,
    logPath,
  };
}

function hasUsableGeminiApiKey(value = '') {
  const key = String(value || '').trim();
  if (!key) return false;
  return !/^(your_|replace_|changeme|example_|test_|dummy_|placeholder)/i.test(key);
}

export function parseResumeWorkspaceReport(reportPath) {
  if (!reportPath || !existsSync(reportPath)) return {};
  const text = readFileSync(reportPath, 'utf-8');
  const titleLine = text.match(/^#\s*Evaluation:\s*(.+?)\s*(?:--|Ã¢â‚¬â€|-)\s*(.+)$/m);
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

function cacheKeyFor(prefix, value) {
  return `${prefix}-${createHash('sha256').update(String(value || '')).digest('hex').slice(0, 24)}`;
}

function readCacheRecord(dir, key, ttlMs = 0) {
  const path = join(dir, `${key}.json`);
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (ttlMs > 0 && Date.now() - stat.mtimeMs > ttlMs) return null;
    const record = JSON.parse(readFileSync(path, 'utf-8'));
    if (!record || typeof record !== 'object') return null;
    return record;
  } catch {
    return null;
  }
}

function writeCacheRecord(dir, key, record) {
  try {
    safeMkdir(dir);
    writeTextFile(join(dir, `${key}.json`), `${JSON.stringify({
      ...record,
      cacheKey: key,
      cachedAt: new Date().toISOString(),
    }, null, 2)}\n`);
  } catch {
    // Cache writes should never block the job workflow.
  }
}

function readGeminiEvalCache(key) {
  const record = readCacheRecord(GEMINI_CACHE_DIR, key, GEMINI_CACHE_TTL_MS);
  if (!record?.reportRelPath) return null;
  const reportPath = resolve(ROOT, record.reportRelPath);
  if (!reportPath.startsWith(ROOT) || !existsSync(reportPath)) return null;
  return {
    reportPath,
    summary: record.summary || {},
  };
}

function writeGeminiEvalCache(key, { reportPath, summary, model }) {
  if (!reportPath || !existsSync(reportPath)) return;
  let reportRelPath = relative(ROOT, reportPath);
  const sourcePath = resolve(reportPath);
  if (!sourcePath.startsWith(ROOT)) return;

  try {
    const cachedReportName = `webapp-cache-${key}.md`;
    const cachedReportPath = join(LOG_DIR, 'cache-reports', cachedReportName);
    safeMkdir(dirname(cachedReportPath));
    retryFs(() => copyFileSync(sourcePath, cachedReportPath));
    reportRelPath = relative(ROOT, cachedReportPath);
  } catch {
    // If the report copy fails, keep the original report path while it exists.
  }

  writeCacheRecord(GEMINI_CACHE_DIR, key, {
    type: 'gemini-evaluation',
    model,
    reportRelPath,
    summary,
  });
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
  const dir = makeOutputDir(outputFolderName(result, date));

  const resumeMode = result.resumeMode === 'one_page' ? 'one_page' : 'two_page';
  const fileStem = resumeFileStem(result);
  const htmlPath = join(dir, `${fileStem}.html`);
  const pdfPath = join(dir, `${fileStem}.pdf`);
  const docxPath = join(dir, `${fileStem}.docx`);
  const context = loadResumeContext(result.resumeContext);
  const cv = String(result.resumeContext?.cv || '').trim() || readOptionalText('cv.md');
  const parsedForQa = parseCvMarkdown(cv);
  context.resumeSourceHasExperience = Boolean(parsedForQa.experience?.length);
  context.resumeTrace = {
    digestCandidatesReviewed: 0,
    selectedDigestBullets: [],
    selectedCvBullets: [],
    finalBullets: [],
  };
  let html = resumeMode === 'one_page'
    ? renderOnePageResumeHtml(result, cv, context)
    : renderResumeHtml(result, cv, context);
  result.resumeQa = buildResumeTailoringQa(html, result, context);
  writeTextFile(htmlPath, html);

  const resumeHtmlPath = artifactRelative(htmlPath);
  let resumeDocxPath = '';
  let resumeDocxError = '';
  let resumeDocxErrorLogPath = '';
  try {
    renderDocxWithNativeJs(result, cv, context, resumeMode, docxPath);
    resumeDocxPath = artifactRelative(docxPath);
  } catch (error) {
    resumeDocxError = `Word resume generation failed: ${String(error?.message || error).slice(0, 300)}`;
    const errorLogPath = join(dir, 'resume-docx-error.log');
    writeTextFile(errorLogPath, String(error?.stack || error?.message || error));
    resumeDocxErrorLogPath = artifactRelative(errorLogPath);
  }
  try {
    const directPdfErrors = [];
    try {
      renderPdfWithNativeJs(result, cv, context, resumeMode, pdfPath);
    } catch (error) {
      directPdfErrors.push(error);
      try {
        renderPdfWithReportlab(result, cv, context, resumeMode, pdfPath);
      } catch (reportlabError) {
        directPdfErrors.push(reportlabError);
        try {
          await renderPdfWithPlaywright(htmlPath, pdfPath);
        } catch (browserError) {
          const details = [
            ...directPdfErrors.map((item, index) => `Direct PDF renderer ${index + 1} failed:\n${item?.stack || item?.message || item}`),
            `Browser PDF fallback failed:\n${browserError?.stack || browserError?.message || browserError}`,
          ].join('\n\n');
          throw new Error(details);
        }
      }
    }
    return {
      resumePdfPath: artifactRelative(pdfPath),
      resumeHtmlPath,
      resumeDocxPath,
      resumeDocxError,
      resumeDocxErrorLogPath,
      resumeQa: result.resumeQa,
    };
  } catch (error) {
    const errorLogPath = join(dir, 'resume-pdf-error.log');
    writeTextFile(errorLogPath, String(error?.stack || error?.message || error));
    return {
      resumePdfPath: '',
      resumeHtmlPath,
      resumeDocxPath,
      resumeDocxError,
      resumeDocxErrorLogPath,
      resumePdfError: pdfWorkerErrorMessage(error),
      resumePdfErrorLogPath: artifactRelative(errorLogPath),
      resumeQa: result.resumeQa,
    };
  }
}

function loadResumeContext(resumeContext = {}) {
  return {
    articleDigest: String(resumeContext.articleDigest || '').trim() || readOptionalText('article-digest.md'),
    profileYml: String(resumeContext.profileYml || '').trim() || readOptionalText(join('config', 'profile.yml')),
    profileMd: String(resumeContext.profileMd || '').trim() || readOptionalText(join('modes', '_profile.md')),
    storyBank: String(resumeContext.storyBank || '').trim() || readOptionalText(join('interview-prep', 'story-bank.md')),
    resumeProfileId: resumeContext.resumeProfileId || '',
    resumeProfileLabel: resumeContext.resumeProfileLabel || '',
  };
}

function readOptionalText(relativePath) {
  const path = join(ROOT, relativePath);
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

function artifactRelative(absolutePath) {
  const resolved = resolve(absolutePath);
  const rootRelative = relative(ROOT, resolved);
  if (!rootRelative.startsWith('..') && !/^[A-Za-z]:/.test(rootRelative)) {
    return normalizeArtifactPath(rootRelative);
  }
  const appRelative = relative(APP_ROOT, resolved);
  if (!appRelative.startsWith('..') && !/^[A-Za-z]:/.test(appRelative)) {
    return normalizeArtifactPath(join('app-data', appRelative));
  }
  return normalizeArtifactPath(rootRelative);
}

function normalizeArtifactPath(filePath) {
  return String(filePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function safeMkdir(dir) {
  retryFs(() => mkdirSync(dir, { recursive: true }));
}

function ensurePrimaryOrFallbackDir(primaryDir, fallbackDir) {
  try {
    safeMkdir(primaryDir);
  } catch (error) {
    if (!isTransientWindowsFsError(error)) throw error;
    safeMkdir(fallbackDir);
  }
}

function normalizeManualJobDescription(jobDescription) {
  const text = String(jobDescription || '')
    .replace(/\u0000/g, ' ')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (!text) return '';
  if (/<[a-z][\s\S]*>/i.test(text)) return htmlToText(text).slice(0, 60000);
  return text.slice(0, 60000);
}

function renderPdfWithNativeJs(result, cv, context, resumeMode, pdfPath) {
  const model = buildResumePdfModel(result, cv, context, resumeMode);
  const pages = model.mode === 'one_page'
    ? buildNativePdfPagesOnePage(model)
    : buildNativePdfPagesDetailed(model);
  if (!pages.length) throw new Error('Native PDF renderer produced no pages.');
  safeMkdir(dirname(pdfPath));
  retryFs(() => writeFileSync(pdfPath, buildPdfDocument(pages)));
}

function buildNativePdfPagesDetailed(model) {
  const attempts = [
    { scale: 1.06, tight: true },
    { scale: 1.04, tight: true },
    { scale: 1.02, tight: true },
    { scale: 1.00, tight: true },
    { scale: 0.98, tight: true },
    { scale: 0.96, tight: true },
  ];
  let fallback = null;
  for (const attempt of attempts) {
    const pages = buildNativePdfPages(model, { scale: attempt.scale, onePage: false, tight: attempt.tight });
    if (!fallback) fallback = pages;
    if (pages.length === 1 && !pages.overflowed) return pages;
  }
  return fallback || buildNativePdfPages(model, { scale: 0.98, onePage: false, tight: true });
}

function buildNativePdfPagesOnePage(model) {
  const attempts = [
    { scale: 1.08, limits: [8, 5, 4, 3], projectBullets: 3, skillLimit: 6, tight: false },
    { scale: 1.05, limits: [8, 5, 4, 3], projectBullets: 3, skillLimit: 6, tight: false },
    { scale: 1.02, limits: [7, 5, 4, 2], projectBullets: 3, skillLimit: 6, tight: false },
    { scale: 0.96, limits: [7, 4, 3, 2], projectBullets: 2, skillLimit: 6, tight: false },
    { scale: 0.91, limits: [6, 4, 3, 1], projectBullets: 2, skillLimit: 5, tight: true },
    { scale: 0.87, limits: [5, 3, 2, 1], projectBullets: 1, skillLimit: 4, tight: true },
    { scale: 0.84, limits: [5, 2, 2, 1], projectBullets: 1, skillLimit: 4, tight: true },
    { scale: 0.80, limits: [4, 2, 1, 1], projectBullets: 1, skillLimit: 3, tight: true },
    { scale: 0.76, limits: [4, 2, 1, 1], projectBullets: 1, skillLimit: 3, tight: true },
  ];
  for (const attempt of attempts) {
    const compact = compactPdfModel(model, attempt.limits, attempt.projectBullets, attempt.skillLimit);
    const pages = buildNativePdfPages(compact, { scale: attempt.scale, onePage: true, tight: attempt.tight });
    if (pages.length === 1 && !pages.overflowed) return pages;
  }
  const minimal = compactPdfModel(model, [3, 2, 1, 1], 1, 3);
  return buildNativePdfPages(minimal, { scale: 0.74, onePage: true, tight: true }).slice(0, 1);
}

function compactPdfModel(model, experienceLimits, projectBulletLimit, skillLimit = 6) {
  const copy = JSON.parse(JSON.stringify(model));
  copy.experience = (copy.experience || []).map((job, index) => ({
    ...job,
    bullets: (job.bullets || []).slice(0, experienceLimits[index] || 1),
  }));
  copy.skills = (copy.skills || []).slice(0, skillLimit);
  copy.projects = (copy.projects || []).slice(0, 1).map((project) => ({
    ...project,
    bullets: (project.bullets || []).slice(0, projectBulletLimit),
  }));
  return copy;
}

function buildNativePdfPages(model, options = {}) {
  const scale = options.scale || 1;
  const onePage = Boolean(options.onePage);
  const tight = Boolean(options.tight);
  const marginX = onePage ? 26 : 36;
  const marginTop = onePage ? (tight ? 44 : 52) : 54;
  const marginBottom = onePage ? (tight ? 18 : 20) : 36;
  const pageWidth = 612;
  const pageHeight = 792;
  const contentWidth = pageWidth - (marginX * 2);
  const pages = [[]];
  let y = pageHeight - marginTop;
  let overflowed = false;
  const current = () => pages[pages.length - 1];
  const size = (value) => Number((value * scale).toFixed(2));
  const line = (value) => Number((value * scale).toFixed(2));
  const canFit = (height) => y - height >= marginBottom;
  const newPage = () => {
    if (onePage) return false;
    pages.push([]);
    y = pageHeight - marginTop;
    return true;
  };
  const ensure = (height) => {
    if (canFit(height)) return true;
    if (newPage()) return true;
    overflowed = true;
    return false;
  };
  const text = (value, x, font = 'regular', fontSize = 8, opts = {}) => {
    const cleanValue = pdfCleanText(value);
    if (!cleanValue) return;
    const item = { type: 'text', text: cleanValue, x, y, font, size: size(fontSize), align: opts.align || 'left', maxX: opts.maxX || pageWidth - marginX };
    current().push(item);
  };
  const richText = (segments, x, fontSize = 8, opts = {}) => {
    const cleanSegments = segments
      .map((segment) => ({ text: pdfCleanInlineText(segment.text), font: segment.bold ? 'bold' : (segment.font || 'regular') }))
      .filter((segment) => segment.text);
    if (!cleanSegments.length) return;
    const width = cleanSegments.reduce((sum, segment) => sum + estimatePdfInlineTextWidth(segment.text, size(fontSize), segment.font), 0);
    let drawX = x;
    if (opts.align === 'center') drawX -= width / 2;
    if (opts.align === 'right') drawX -= width;
    current().push({ type: 'segments', segments: cleanSegments, x: drawX, y, size: size(fontSize) });
  };
  const rule = () => current().push({ type: 'line', x1: marginX, y1: y, x2: pageWidth - marginX, y2: y });
  const dot = (x, baselineY, fontSize = 8) => {
    current().push({
      type: 'dot',
      x,
      y: baselineY + size(fontSize) * 0.36,
      r: Math.max(1.05, size(fontSize) * 0.13),
    });
  };
  const paragraph = (value, fontSize = 8, leading = 9, indent = 0, bullet = false) => {
    const maxWidth = contentWidth - indent - (bullet ? 12 : 0);
    const lines = wrapPdfRichText(value, size(fontSize), maxWidth, model.highlightTerms || []);
    if (!ensure(lines.length * line(leading))) return;
    lines.forEach((wrapped, index) => {
      if (!ensure(line(leading))) return;
      if (bullet && index === 0) dot(marginX + indent + 3.5, y, fontSize);
      richText(wrapped, marginX + indent + (bullet ? 12 : 0), fontSize);
      y -= line(leading);
    });
  };
  const section = (title) => {
    const sectionHeight = onePage ? line(tight ? 18 : 22) : line(tight ? 23 : 25);
    if (!ensure(sectionHeight)) return;
    y -= line(onePage ? (tight ? 4 : 6) : (tight ? 5 : 6));
    text(String(title || '').toUpperCase(), marginX, 'bold', onePage ? 9.5 : 10.0);
    y -= line(onePage ? (tight ? 4 : 5) : (tight ? 7 : 8));
    rule();
    y -= line(onePage ? (tight ? 6 : 8) : (tight ? 10 : 11));
  };
  const keyValue = (lineText, fontSize = 7.5, leading = 8.4) => {
    const [category, ...rest] = String(lineText || '').split(':');
    const values = rest.join(':').trim();
    if (!category || !values) return paragraph(lineText, fontSize, leading);
    const label = `${category.trim()}:`;
    const labelWidth = estimatePdfTextWidth(label, size(fontSize), 'bold') + 8;
    const lines = wrapPdfRichText(values, size(fontSize), contentWidth - labelWidth, []);
    if (!ensure(lines.length * line(leading))) return;
    text(label, marginX, 'bold', fontSize);
    richText(lines[0] || [], marginX + labelWidth, fontSize);
    y -= line(leading);
    lines.slice(1).forEach((wrapped) => {
      richText(wrapped, marginX + labelWidth, fontSize);
      y -= line(leading);
    });
  };

  text(model.name || 'Candidate Name', pageWidth / 2, 'timesBold', onePage ? 20.5 : 22, { align: 'center' });
  if (!onePage) current()[current().length - 1].size = size(16);
  y -= line(onePage ? 13 : 12);
  const contact = (model.contact || []).filter(Boolean).join('  |  ');
  if (contact) {
    text(contact, pageWidth / 2, 'regular', onePage ? 7.35 : 8.2, { align: 'center' });
    y -= line(onePage ? 11 : 12);
  }

  section('Summary');
  paragraph(model.summary || '', onePage ? 7.95 : 8.6, onePage ? 9.1 : 10.0);

  if (model.skills?.length) {
    section(onePage ? 'Technical Skills' : 'Skills');
    model.skills.slice(0, onePage ? 6 : model.skills.length).forEach((item) => keyValue(item, onePage ? 7.55 : 8.2, onePage ? 8.5 : 9.5));
  }

  if (model.experience?.length) {
    section('Work Experience');
    model.experience.forEach((job) => {
      if (!ensure(line(24))) return;
      const roleLine = [job.role, job.location].filter(Boolean).join(' | ');
      if (onePage) {
        text(job.company || '', marginX, 'bold', 8.3);
        if (job.period) text(job.period, pageWidth - marginX, 'regular', 7.75, { align: 'right' });
        y -= line(9.5);
        if (roleLine) {
          text(roleLine, marginX, 'italic', 7.75);
          y -= line(8.9);
        }
      } else {
        const left = [job.company, roleLine].filter(Boolean).join(' | ');
        text(left || job.company || '', marginX, 'bold', 8.6);
        if (job.period) text(job.period, pageWidth - marginX, 'regular', 8.2, { align: 'right' });
        y -= line(10.0);
      }
      (job.bullets || []).forEach((bullet) => paragraph(bullet, onePage ? 7.45 : 8.1, onePage ? 8.25 : 9.4, 0, true));
      y -= line(2.2);
    });
  }

  if (model.projects?.length) {
    section(model.projects.length === 1 ? 'Project' : 'Projects');
    model.projects.forEach((project) => {
      const github = project.github && !String(project.title || '').includes(project.github) ? ` (${project.github})` : '';
      text(`${project.title || ''}${github}`, marginX, 'bold', onePage ? 8.05 : 8.8);
      y -= line(onePage ? 9.0 : 9.8);
      if (project.tech) paragraph(project.tech, onePage ? 7.2 : 7.9, onePage ? 8.0 : 9.0);
      (project.bullets || []).forEach((bullet) => paragraph(bullet, onePage ? 7.45 : 8.1, onePage ? 8.25 : 9.4, 0, true));
    });
  }

  if (model.education?.length || model.certifications?.length) {
    section(onePage ? 'Education & Certifications' : 'Education');
    (model.education || []).slice(0, onePage ? 1 : model.education.length).forEach((item) => paragraph(item, onePage ? 7.55 : 8.2, onePage ? 8.5 : 9.5));
    if (!onePage && model.certifications?.length) section('Certifications');
    if (model.certifications?.length) paragraph(`Certifications: ${(model.certifications || []).slice(0, onePage ? 5 : model.certifications.length).join(' | ')}`, onePage ? 7.4 : 8.0, onePage ? 8.3 : 9.3);
  }

  const visiblePages = pages.filter((page) => page.length);
  visiblePages.overflowed = overflowed;
  return visiblePages;
}

function buildPdfDocument(pages) {
  const objects = [];
  const addObject = (body) => {
    objects.push(body);
    return objects.length;
  };
  const catalogId = addObject('<< /Type /Catalog /Pages 2 0 R >>');
  const pagesId = addObject('');
  const fontRegularId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const fontBoldId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>');
  const fontItalicId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>');
  const fontTimesBoldId = addObject('<< /Type /Font /Subtype /Type1 /BaseFont /Times-Bold >>');
  const pageIds = [];
  pages.forEach((page) => {
    const stream = renderPdfPageStream(page);
    const contentId = addObject(`<< /Length ${Buffer.byteLength(stream, 'binary')} >>\nstream\n${stream}\nendstream`);
    const pageId = addObject(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontRegularId} 0 R /F2 ${fontBoldId} 0 R /F3 ${fontItalicId} 0 R /F4 ${fontTimesBoldId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  });
  objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

function buildDocxDocument(model) {
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    'word/_rels/document.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`,
    'word/styles.xml': renderDocxStylesXml(),
    'word/numbering.xml': renderDocxNumberingXml(),
    'word/document.xml': renderDocxDocumentXml(model),
  };
  return createZipArchive(files);
}

function renderDocxDocumentXml(model) {
  const body = [];
  const isOnePage = model.mode === 'one_page';
  const pageMargin = isOnePage
    ? { top: 504, right: 547, bottom: 504, left: 547, tab: 11160 }
    : { top: 720, right: 720, bottom: 720, left: 720, tab: 10800 };
  const bodySize = isOnePage ? 16 : 20;
  const nameSize = isOnePage ? 40 : 32;
  const paragraph = (runs, opts = {}) => body.push(docxParagraph(runs, opts));
  const section = (title) => paragraph([{ text: String(title || '').toUpperCase(), bold: true }], {
    before: isOnePage ? 120 : 90,
    after: isOnePage ? 30 : 20,
    border: true,
    size: 20,
  });
  paragraph([{ text: model.name || 'Candidate Name', bold: true, font: 'Times New Roman' }], { align: 'center', size: nameSize, after: isOnePage ? 20 : 0 });
  const contact = (model.contact || []).filter(Boolean).join(' | ');
  if (contact) paragraph([{ text: contact }], { align: 'center', size: isOnePage ? 16 : 20, after: isOnePage ? 100 : 80, line: isOnePage ? 240 : 360 });

  section('Summary');
  paragraph([{ text: model.summary || '' }], { size: isOnePage ? 17 : 20, after: isOnePage ? 60 : 70 });

  if (model.skills?.length) {
    section(model.mode === 'one_page' ? 'Technical Skills' : 'Skills');
    model.skills.forEach((lineText) => {
      const [category, ...rest] = String(lineText || '').split(':');
      if (category && rest.length) {
        paragraph([
          { text: `${category.trim()}: `, bold: true },
          { text: rest.join(':').trim() },
        ], { size: bodySize, after: isOnePage ? 5 : 0 });
      } else {
        paragraph([{ text: lineText }], { size: bodySize, after: isOnePage ? 5 : 0 });
      }
    });
  }

  if (model.experience?.length) {
    section('Work Experience');
    model.experience.forEach((job) => {
      const roleLine = [job.role, job.location].filter(Boolean).join(' | ');
      if (isOnePage) {
        paragraph([
          { text: job.company || '', bold: true },
          { tab: true },
          { text: job.period || '' },
        ], { size: 17, after: 0, rightTab: true, rightTabPos: pageMargin.tab });
        if (roleLine) paragraph([{ text: roleLine, italic: true }], { size: 16, after: 10 });
      } else {
        paragraph([
          { text: [job.company, roleLine].filter(Boolean).join(' | '), bold: true },
          { tab: true },
          { text: job.period || '' },
        ], { size: bodySize, after: 0, rightTab: true, rightTabPos: pageMargin.tab });
      }
      (job.bullets || []).forEach((bullet) => {
        if (isOnePage) {
          paragraph([{ text: bullet }], { bullet: true, size: bodySize, after: 0 });
        } else {
          paragraph([{ text: '•' }, { tab: true }, { text: bullet }], { manualBullet: true, size: bodySize, after: 35 });
        }
      });
    });
  }

  if (model.projects?.length) {
    section(model.projects.length === 1 ? 'Project' : 'Projects');
    model.projects.forEach((project) => {
      const github = project.github && !String(project.title || '').includes(project.github) ? ` (${project.github})` : '';
      paragraph([{ text: `${project.title || ''}${github}`, bold: true }], { size: isOnePage ? 17 : 20, after: 0 });
      if (project.tech) paragraph([{ text: project.tech }], { size: isOnePage ? 15 : 20, after: 0 });
      (project.bullets || []).forEach((bullet) => {
        if (isOnePage) {
          paragraph([{ text: bullet }], { bullet: true, size: bodySize, after: 0 });
        } else {
          paragraph([{ text: '•' }, { tab: true }, { text: bullet }], { manualBullet: true, size: bodySize, after: 20 });
        }
      });
    });
  }

  const education = (model.education || []).filter(Boolean);
  const certifications = (model.certifications || []).filter(Boolean);
  if (education.length || certifications.length) {
    section(model.mode === 'one_page' ? 'Education & Certifications' : 'Education');
    education.forEach((item) => paragraph([{ text: item }], { size: bodySize, after: 0 }));
    if (model.mode !== 'one_page' && certifications.length) section('Certifications');
    if (certifications.length) paragraph([{ text: `Certifications: ${certifications.join(' | ')}` }], { size: bodySize, after: 0 });
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${body.join('\n')}
    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="${pageMargin.top}" w:right="${pageMargin.right}" w:bottom="${pageMargin.bottom}" w:left="${pageMargin.left}" w:header="360" w:footer="360" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
}

function docxParagraph(runs = [], opts = {}) {
  const pPr = [
    opts.align ? `<w:jc w:val="${xmlEscape(opts.align)}"/>` : '',
    opts.rightTab ? `<w:tabs><w:tab w:val="right" w:pos="${Number(opts.rightTabPos || 11160)}"/></w:tabs>` : '',
    opts.bullet ? '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:ind w:left="360" w:hanging="180"/>' : '',
    opts.manualBullet ? '<w:tabs><w:tab w:val="left" w:pos="360"/></w:tabs><w:ind w:left="360" w:hanging="180"/>' : '',
    `<w:spacing w:before="${Number(opts.before || 0)}" w:after="${Number(opts.after ?? 20)}" w:line="${Number(opts.line || 240)}" w:lineRule="auto"/>`,
    opts.border ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="111111"/></w:pBdr>' : '',
  ].filter(Boolean).join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs.map((run) => docxRun(run, opts.size || 18)).join('')}</w:p>`;
}

function docxRun(run = {}, defaultSize = 18) {
  if (run.tab) return '<w:r><w:tab/></w:r>';
  const props = [
    run.bold ? '<w:b/>' : '',
    run.italic ? '<w:i/>' : '',
    `<w:rFonts w:ascii="${xmlEscape(run.font || 'Arial')}" w:hAnsi="${xmlEscape(run.font || 'Arial')}"/>`,
    `<w:sz w:val="${Number(run.size || defaultSize)}"/>`,
  ].filter(Boolean).join('');
  return `<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${xmlEscape(run.text || '')}</w:t></w:r>`;
}

function renderDocxStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="18"/></w:rPr>
  </w:style>
</w:styles>`;
}

function renderDocxNumberingXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0">
      <w:start w:val="1"/>
      <w:numFmt w:val="bullet"/>
      <w:lvlText w:val="-"/>
      <w:lvlJc w:val="left"/>
      <w:pPr><w:ind w:left="360" w:hanging="180"/></w:pPr>
    </w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;
}

function createZipArchive(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  Object.entries(files).forEach(([name, value]) => {
    const nameBuffer = Buffer.from(name, 'utf8');
    const data = Buffer.from(String(value), 'utf8');
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
  });
  const centralDir = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDir, end]);
}

const CRC32_TABLE = Array.from({ length: 256 }, (_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  return c >>> 0;
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[<>&"']/g, (char) => ({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    "'": '&apos;',
  }[char]));
}

function renderPdfPageStream(items) {
  return items.map((item) => {
    if (item.type === 'line') return `${item.x1.toFixed(2)} ${item.y1.toFixed(2)} m ${item.x2.toFixed(2)} ${item.y2.toFixed(2)} l S`;
    if (item.type === 'dot') return renderPdfCircle(item.x, item.y, item.r);
    if (item.type === 'segments') {
      const commands = [`BT ${item.x.toFixed(2)} ${item.y.toFixed(2)} Td`];
      let currentFont = '';
      item.segments.forEach((segment) => {
        const font = segment.font === 'bold' ? 'F2' : segment.font === 'italic' ? 'F3' : segment.font === 'timesBold' ? 'F4' : 'F1';
        if (font !== currentFont) {
          commands.push(`/${font} ${item.size.toFixed(2)} Tf`);
          currentFont = font;
        }
        commands.push(`(${escapePdfInlineString(segment.text)}) Tj`);
      });
      commands.push('ET');
      return commands.join('\n');
    }
    const font = item.font === 'bold' ? 'F2' : item.font === 'italic' ? 'F3' : item.font === 'timesBold' ? 'F4' : 'F1';
    let x = item.x;
    if (item.align === 'center') x -= estimatePdfTextWidth(item.text, item.size, item.font) / 2;
    if (item.align === 'right') x -= estimatePdfTextWidth(item.text, item.size, item.font);
    return `BT /${font} ${item.size.toFixed(2)} Tf ${x.toFixed(2)} ${item.y.toFixed(2)} Td (${escapePdfString(item.text)}) Tj ET`;
  }).join('\n');
}

function renderPdfCircle(x, y, r) {
  const c = 0.5522847498 * r;
  return [
    `${(x + r).toFixed(2)} ${y.toFixed(2)} m`,
    `${(x + r).toFixed(2)} ${(y + c).toFixed(2)} ${(x + c).toFixed(2)} ${(y + r).toFixed(2)} ${x.toFixed(2)} ${(y + r).toFixed(2)} c`,
    `${(x - c).toFixed(2)} ${(y + r).toFixed(2)} ${(x - r).toFixed(2)} ${(y + c).toFixed(2)} ${(x - r).toFixed(2)} ${y.toFixed(2)} c`,
    `${(x - r).toFixed(2)} ${(y - c).toFixed(2)} ${(x - c).toFixed(2)} ${(y - r).toFixed(2)} ${x.toFixed(2)} ${(y - r).toFixed(2)} c`,
    `${(x + c).toFixed(2)} ${(y - r).toFixed(2)} ${(x + r).toFixed(2)} ${(y - c).toFixed(2)} ${(x + r).toFixed(2)} ${y.toFixed(2)} c`,
    'f',
  ].join('\n');
}

function wrapPdfText(value, fontSize, maxWidth) {
  const words = pdfCleanText(value).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = words[0];
  for (const word of words.slice(1)) {
    const candidate = `${current} ${word}`;
    if (estimatePdfTextWidth(candidate, fontSize) <= maxWidth) current = candidate;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}

function wrapPdfRichText(value, fontSize, maxWidth, highlightTerms = []) {
  const words = pdfCleanText(value).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let current = [];
  let currentText = '';
  for (const word of words) {
    const candidateText = currentText ? `${currentText} ${word}` : word;
    if (!current.length || estimatePdfRichWidth(tokenizeHighlightText(candidateText, highlightTerms), fontSize) <= maxWidth) {
      currentText = candidateText;
      current = tokenizeHighlightText(currentText, highlightTerms);
    } else {
      lines.push(current);
      currentText = word;
      current = tokenizeHighlightText(word, highlightTerms);
    }
  }
  if (current.length) lines.push(current);
  return lines;
}

function tokenizeHighlightText(value, highlightTerms = []) {
  const text = pdfCleanText(value);
  if (!text || !highlightTerms.length) return [{ text, bold: false }];
  const terms = highlightTerms
    .map(pdfCleanText)
    .filter((term) => term.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, 40);
  const matches = [];
  for (const term of terms) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9+/#.-])(${escapeRegExp(term)})(?=$|[^A-Za-z0-9+/#.-])`, 'gi');
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const start = match.index + match[1].length;
      const end = start + match[2].length;
      if (!matches.some((item) => start < item.end && end > item.start)) matches.push({ start, end });
      if (matches.length >= 8) break;
    }
    if (matches.length >= 8) break;
  }
  if (!matches.length) return [{ text, bold: false }];
  matches.sort((a, b) => a.start - b.start);
  const segments = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) segments.push({ text: text.slice(cursor, match.start), bold: false });
    segments.push({ text: text.slice(match.start, match.end), bold: true });
    cursor = match.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), bold: false });
  return segments.filter((segment) => segment.text);
}

function estimatePdfRichWidth(segments, fontSize) {
  return segments.reduce((sum, segment) => sum + estimatePdfInlineTextWidth(segment.text, fontSize, segment.bold ? 'bold' : 'regular'), 0);
}

function estimatePdfTextWidth(value, fontSize, font = 'regular') {
  return estimateHelveticaWidth(pdfCleanText(value), fontSize, font);
}

function estimatePdfInlineTextWidth(value, fontSize, font = 'regular') {
  return estimateHelveticaWidth(pdfCleanInlineText(value), fontSize, font);
}

function estimateHelveticaWidth(value, fontSize, font = 'regular') {
  const boldMultiplier = font === 'bold' || font === 'timesBold' ? 1.035 : 1;
  let units = 0;
  for (const char of String(value || '')) {
    units += HELVETICA_WIDTHS[char] || (/^[A-Z]$/.test(char) ? 667 : /^[a-z0-9]$/.test(char) ? 556 : 500);
  }
  return units * fontSize * boldMultiplier / 1000;
}

const HELVETICA_WIDTHS = Object.freeze({
  ' ': 278, '!': 278, '"': 355, '#': 556, '$': 556, '%': 889, '&': 667, "'": 222,
  '(': 333, ')': 333, '*': 389, '+': 584, ',': 278, '-': 333, '.': 278, '/': 278,
  '0': 556, '1': 556, '2': 556, '3': 556, '4': 556, '5': 556, '6': 556, '7': 556, '8': 556, '9': 556,
  ':': 278, ';': 278, '<': 584, '=': 584, '>': 584, '?': 556, '@': 1015,
  A: 667, B: 667, C: 722, D: 722, E: 667, F: 611, G: 778, H: 722, I: 278, J: 500,
  K: 667, L: 556, M: 833, N: 722, O: 778, P: 667, Q: 778, R: 722, S: 667, T: 611,
  U: 722, V: 667, W: 944, X: 667, Y: 667, Z: 611,
  '[': 278, '\\': 278, ']': 278, '^': 469, '_': 556, '`': 222,
  a: 556, b: 556, c: 500, d: 556, e: 556, f: 278, g: 556, h: 556, i: 222, j: 222,
  k: 500, l: 222, m: 833, n: 556, o: 556, p: 556, q: 556, r: 333, s: 500, t: 278,
  u: 556, v: 500, w: 722, x: 500, y: 500, z: 500,
  '{': 334, '|': 260, '}': 334, '~': 584,
});

function pdfCleanText(value) {
  return stripMarkdownEmphasis(String(value || ''))
    .replace(/[â€œâ€]/g, '"')
    .replace(/[â€˜â€™]/g, "'")
    .replace(/[â€“â€”]/g, '-')
    .replace(/â€¢/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pdfCleanInlineText(value) {
  return stripMarkdownEmphasis(String(value || ''))
    .replace(/[Ã¢â‚¬Å“Ã¢â‚¬Â]/g, '"')
    .replace(/[Ã¢â‚¬ËœÃ¢â‚¬â„¢]/g, "'")
    .replace(/[Ã¢â‚¬â€œÃ¢â‚¬â€]/g, '-')
    .replace(/Ã¢â‚¬Â¢/g, '-')
    .replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ');
}

function stripMarkdownEmphasis(value) {
  return String(value || '').replace(/\*\*/g, '');
}

function escapePdfString(value) {
  return pdfCleanText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function escapePdfInlineString(value) {
  return pdfCleanInlineText(value).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function writeTextFile(path, text) {
  retryFs(() => writeFileSync(path, text, 'utf-8'));
  return path;
}

function writeTextFileWithFallback(primaryPath, fallbackPath, text) {
  try {
    safeMkdir(dirname(primaryPath));
    return writeTextFile(primaryPath, text);
  } catch (error) {
    if (!isTransientWindowsFsError(error)) throw error;
    safeMkdir(dirname(fallbackPath));
    return writeTextFile(fallbackPath, text);
  }
}

function renderDocxWithNativeJs(result, cv, context, resumeMode, docxPath) {
  const model = buildResumePdfModel(result, cv, context, resumeMode);
  safeMkdir(dirname(docxPath));
  retryFs(() => writeFileSync(docxPath, buildDocxDocument(model)));
  if (!existsSync(docxPath)) throw new Error('Word resume renderer finished without creating a DOCX.');
}

function renderPdfWithReportlab(result, cv, context, resumeMode, pdfPath) {
  const python = findPythonExecutable();
  if (!python) throw new Error('Python was not found for direct resume PDF generation.');
  if (!existsSync(REPORTLAB_RENDERER)) throw new Error('Direct resume PDF renderer is missing.');
  safeMkdir(dirname(pdfPath));
  safeMkdir(PDF_TEMP_DIR);
  const payloadPath = join(PDF_TEMP_DIR, `resume-model-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const payload = buildResumePdfModel(result, cv, context, resumeMode);
  try {
    writeTextFile(payloadPath, JSON.stringify(payload, null, 2));
    spawnAndWaitSync(python, [REPORTLAB_RENDERER, payloadPath, pdfPath], 60000);
    if (!existsSync(pdfPath)) throw new Error('Direct resume PDF renderer finished without creating a PDF.');
  } finally {
    try {
      if (existsSync(payloadPath)) unlinkSync(payloadPath);
    } catch {
      // Temp cleanup should not fail an otherwise good PDF.
    }
  }
}

function buildResumePdfModel(result, cv, context = {}, resumeMode = 'two_page') {
  const parsed = applyProfileRoleDefaults(parseCvMarkdown(cv), context);
  const isOnePage = resumeMode === 'one_page';
  const enrichedExperience = enrichExperience(parsed.experience, result, context);
  const experience = isOnePage
    ? compactOnePageExperience(enrichedExperience)
    : enrichedExperience.map((job, index) => ({
      ...job,
      bullets: (job.bullets || []).slice(0, [7, 6, 5, 4][index] || 3).map(ensurePeriod),
    }));
  const availableProjects = [...(parsed.projects || []), ...digestProjectsForTarget(context.articleDigest, result, context)];
  const pickedProject = pickOnePageProject(availableProjects, result, context);
  const projects = isOnePage
    ? (pickedProject ? [{ ...pickedProject, github: pickedProject.github || parsed.github || '' }] : [])
    : [...availableProjects]
      .sort((a, b) => scoreProject(b, resumeTerms(result, context), `${result.title || ''} ${result.jdText || ''}`.toLowerCase()) - scoreProject(a, resumeTerms(result, context), `${result.title || ''} ${result.jdText || ''}`.toLowerCase()))
      .slice(0, 2)
      .map((project) => ({
      ...project,
      github: project.github || parsed.github || '',
      bullets: rankBullets(project.bullets || [], resumeTerms(result, context))
        .filter((bullet) => !isWeakDetailedProjectBullet(bullet))
        .slice(0, 2)
        .map(ensurePeriod),
    }));
  return {
    mode: isOnePage ? 'one_page' : 'two_page',
    name: parsed.name || 'Candidate Name',
    contact: [
      parsed.email,
      parsed.phone,
      parsed.linkedin,
      parsed.location || 'United States',
    ].filter(Boolean),
    summary: isOnePage ? buildOnePageSummary(parsed.summary, result) : buildResumeSummary(parsed.summary, result, context),
    skills: isOnePage ? onePageSkillLines(parsed.skills) : parsed.skills,
    experience,
    projects,
    education: parsed.education || [],
    certifications: parsed.certifications || [],
    // Keep body text visually clean. JD keyword bolding caused spacing issues
    // in generated PDFs, so only structural labels remain bold.
    highlightTerms: [],
  };
}

function isWeakDetailedProjectBullet(value) {
  return /deployed the application on streamlit cloud using infrastructure tools/i.test(String(value || ''));
}

function resumeHighlightTerms(result, context = {}, parsed = {}) {
  const generic = new Set([
    'data',
    'reporting',
    'support',
    'business',
    'experience',
    'workflows',
    'workflow',
    'team',
    'teams',
    'role',
    'senior',
    'engineer',
    'engineering',
  ]);
  const sourceText = [
    result.title,
    result.company,
    result.jdText,
    parsed.skills?.join('\n'),
    context.profileYml,
    context.profileMd,
  ].filter(Boolean).join('\n');
  const knownTerms = [
    'Azure Data Factory',
    'Azure Databricks',
    'Databricks',
    'PySpark',
    'Spark',
    'Snowflake',
    'AWS Glue',
    'Amazon EMR',
    'Amazon Redshift',
    'Amazon S3',
    'AWS Lambda',
    'AWS Lake Formation',
    'AWS Step Functions',
    'AWS Glue Data Catalog',
    'Azure DevOps',
    'Power BI',
    'Tableau',
    'SQL',
    'PL/SQL',
    'Python',
    'ETL',
    'ELT',
    'CDC',
    'Control-M',
    'Airflow',
    'dbt',
    'Kafka',
    'CI/CD',
    'Git',
    'GitHub',
    'Jenkins',
    'Terraform',
    'data quality',
    'data modeling',
    'dimensional modeling',
    'production support',
    'performance tuning',
    'reconciliation',
  ];
  const candidateTerms = [
    ...(result.matchingSkills || []),
    ...knownTerms.filter((term) => termMatches(sourceText, term)),
  ];
  return [...new Set(candidateTerms
    .map((term) => pdfCleanText(term).trim())
    .filter((term) => term.length >= 2)
    .filter((term) => !generic.has(term.toLowerCase())))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 36);
}

function onePageSkillLines(skills) {
  const preferred = [
    'Programming',
    'Languages',
    'AWS Core Services',
    'Cloud & Platforms',
    'Cloud & Data Tools',
    'Cloud and Platforms',
    'Cloud Platforms',
    'Data Engineering',
    'Databases & Warehouses',
    'Databases',
    'Data Platforms',
    'Analytics & BI',
    'BI & Analytics',
    'BI and Analytics',
    'Visualization & Reporting',
    'DevOps & Monitoring',
    'Tools & Methods',
    'Orchestration & DevOps',
    'Orchestration and DevOps',
    'Orchestration',
  ];
  const parsed = skills.map((line) => {
    const [category, ...rest] = line.split(':');
    return { category: category.trim(), values: rest.join(':').trim() };
  }).filter((item) => item.category && item.values);
  const selected = preferred
    .map((category) => parsed.find((item) => item.category.toLowerCase() === category.toLowerCase()))
    .filter(Boolean)
    .slice(0, 6);
  return (selected.length ? selected : parsed.slice(0, 6))
    .map((item) => `${item.category}: ${compactList(item.values, 12)}`);
}

function retryFs(operation, attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsFsError(error) || attempt === attempts - 1) break;
      sleepSync(50 * (attempt + 1));
    }
  }
  throw lastError;
}

function isTransientWindowsFsError(error) {
  return ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function generateCoverLetter(result = {}) {
  const date = new Date().toISOString().slice(0, 10);
  const dir = makeOutputDir(outputFolderName(result, date));
  const path = join(dir, 'cover-letter.md');
  const company = cleanCoverLetterValue(result.company, 'your team');
  const title = cleanCoverLetterValue(result.title, 'the role');
  const skills = [...new Set(result.matchingSkills || [])]
    .map((skill) => cleanCoverLetterValue(skill, ''))
    .filter(Boolean)
    .slice(0, 6);
  const jdText = `${result.title || ''} ${result.summary || ''} ${result.jdText || ''}`;
  const theme = inferCoverLetterTheme(jdText);
  const skillPhrase = skills.length
    ? skills.join(', ')
    : theme.defaultSkills;
  const body = `# Cover Letter - ${company} - ${title}

Dear Hiring Team,

I am excited to apply for the ${title} position at ${company}. My background is centered on building reliable data pipelines, analytics-ready datasets, and reporting layers across telecom, banking, and retail environments, with hands-on work in ${skillPhrase}.

In recent roles, I have worked end to end across ingestion, transformation, validation, production support, and stakeholder-facing reporting. I have built and maintained PySpark, SQL, Snowflake, Databricks, and cloud data workflows, improved data quality checks, supported production issues, and translated operational data into clear reporting and analytics outcomes.

${theme.paragraph}

I would welcome the opportunity to discuss how my data engineering and analytics experience can support ${company}'s goals for this role. Thank you for your time and consideration.

Sincerely,
Candidate Name
`;
  writeTextFile(path, body);
  return artifactRelative(path);
}

function inferCoverLetterTheme(text = '') {
  const target = String(text || '').toLowerCase();
  if (/dashboard|power bi|tableau|kpi|business intelligence|bi developer|analytics/.test(target)) {
    return {
      defaultSkills: 'SQL, Tableau, Power BI, data quality, KPI reporting, and analytics datasets',
      paragraph: 'What I would bring to this role is a practical mix of technical execution and business-facing analysis: building trusted datasets, validating metrics, and communicating insights clearly so teams can make better decisions.'
    };
  }
  if (/oracle|pl\/sql|plsql|stored procedure|database developer|sql server|ssis|dba|production support/.test(target)) {
    return {
      defaultSkills: 'SQL, PL/SQL, stored procedures, SSIS, production support, and performance tuning',
      paragraph: 'I also bring strong database and production-support discipline, including troubleshooting failed loads, improving stored procedure performance, validating source-to-target data, and supporting reliable reporting and application data layers.'
    };
  }
  if (/aws|glue|redshift|s3|emr|lambda/.test(target)) {
    return {
      defaultSkills: 'Python, SQL, PySpark, Snowflake, AWS data services, and ETL/ELT pipelines',
      paragraph: 'I am comfortable working across cloud data workflows and adjacent platform services, and I approach new tool-specific requirements by grounding the work in strong pipeline design, validation, monitoring, and production reliability practices.'
    };
  }
  if (/ai|machine learning|ml|llm|agentic|forecast|classification|prediction|observability|telemetry/.test(target)) {
    return {
      defaultSkills: 'Python, SQL, Spark, feature engineering, operational analytics, and ML-ready datasets',
      paragraph: 'I have also prepared analytics-ready and ML-ready datasets from operational data, analyzed incident and signal patterns, and built practical AI-assisted workflows with a human-in-the-loop approach to keep outputs reliable and reviewable.'
    };
  }
  return {
    defaultSkills: 'Python, SQL, PySpark, Databricks, Snowflake, Azure Data Factory, and ETL/ELT workflows',
    paragraph: 'I care about building data systems that are useful beyond the initial delivery: clean transformations, clear ownership, strong validation, and reporting outputs that technical and business users can trust.'
  };
}

function cleanCoverLetterValue(value, fallback) {
  const cleaned = cleanDisplayText(String(value || '').replace(/[#*_`<>]/g, '').trim());
  return cleaned || fallback;
}
function outputFolderName(result, date = new Date().toISOString().slice(0, 10)) {
  const slug = slugify(`${result?.company || 'unknown-company'}-${result?.title || 'job-opportunity'}`) || 'unknown-company-job-opportunity';
  const profile = resumeProfileFolderSuffix(result);
  return `webapp-${slug}-${date}${profile ? `-${profile}` : ''}`;
}

function resumeProfileFolderSuffix(result = {}) {
  const text = `${result.resumeProfileLabel || ''} ${result.resumeProfileId || ''}`.toLowerCase();
  if (/\baws\b/.test(text)) return 'AWS';
  if (/\bazure\b/.test(text)) return 'Azure';
  if (/data-analyst|data analyst/.test(text)) return 'Data-Analyst';
  if (/bi-developer|bi developer/.test(text)) return 'BI-Developer';
  if (/db-developer|db developer/.test(text)) return 'DB-Developer';
  if (/dba|production-support|production support/.test(text)) return 'DBA';
  if (/data-engineer|data engineer/.test(text)) return 'Data-Engineer';
  const profileSlug = slugify(result.resumeProfileLabel || result.resumeProfileId || '');
  return profileSlug ? profileSlug.split('-').slice(-3).join('-') : '';
}

function resumeFileStem(result = {}) {
  const label = String(result.resumeProfileLabel || '').trim();
  const owner = label.includes(' - ') ? label.split(' - ')[0].trim() : 'Candidate';
  const cleanOwner = slugify(owner).replace(/-/g, '');
  if (/^resume\s*\d+$/i.test(label)) return `candidate_${slugify(label).replace(/-/g, '_')}_resume`;
  return `${cleanOwner || 'candidate'}_resume`;
}

function makeOutputDir(folderName) {
  const primary = join(OUTPUT_DIR, folderName);
  try {
    safeMkdir(primary);
    return primary;
  } catch (error) {
    if (!isTransientWindowsFsError(error)) throw error;
    const fallback = join(FALLBACK_OUTPUT_DIR, folderName);
    safeMkdir(fallback);
    return fallback;
  }
}

async function renderPdfWithPlaywright(htmlPath, pdfPath) {
  try {
    await renderPdfWithSystemBrowser(htmlPath, pdfPath);
    return;
  } catch (systemBrowserError) {
    try {
      await renderPdfWithBundledPlaywright(htmlPath, pdfPath);
      return;
    } catch (playwrightError) {
      const combined = new Error(`${playwrightError.message}\n\nSystem browser PDF fallback also failed:\n${systemBrowserError.message}`);
      combined.stack = `${playwrightError.stack || playwrightError.message}\n\nSystem browser PDF fallback also failed:\n${systemBrowserError.stack || systemBrowserError.message}`;
      throw combined;
    }
  }
}

async function renderPdfWithSystemBrowser(htmlPath, pdfPath) {
  const browserPath = findSystemBrowserExecutable();
  if (!browserPath) throw new Error('No installed Chrome or Edge executable was found for PDF generation.');
  safeMkdir(dirname(pdfPath));
  safeMkdir(PDF_TEMP_DIR);
  const tempPdfPath = join(PDF_TEMP_DIR, `resume-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const userDataDir = join(PDF_TEMP_DIR, `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-extensions',
    '--no-first-run',
    `--user-data-dir=${userDataDir}`,
    `--print-to-pdf=${tempPdfPath}`,
    pathToFileURL(htmlPath).href,
  ];
  await spawnAndWait(browserPath, args, 45000);
  if (!existsSync(tempPdfPath)) throw new Error('System browser finished without creating a PDF.');
  retryFs(() => copyFileSync(tempPdfPath, pdfPath));
  sanitizeBrowserPdfHeaderFooter(pdfPath);
  try {
    unlinkSync(tempPdfPath);
  } catch {
    // Leaving a temp PDF behind is harmless; failing the run would be worse.
  }
}

function findSystemBrowserExecutable() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
  const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || '';
}

function sanitizeBrowserPdfHeaderFooter(pdfPath) {
  const python = findPythonExecutable();
  if (!python) return;
  const tempCleanPath = join(PDF_TEMP_DIR, `clean-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
  const script = [
    'import sys, io',
    'from pypdf import PdfReader, PdfWriter',
    'from reportlab.pdfgen import canvas',
    'from reportlab.lib.colors import white',
    'src, dst = sys.argv[1], sys.argv[2]',
    'reader = PdfReader(src)',
    'writer = PdfWriter()',
    'for page in reader.pages:',
    '    w, h = float(page.mediabox.width), float(page.mediabox.height)',
    '    packet = io.BytesIO()',
    '    c = canvas.Canvas(packet, pagesize=(w, h))',
    '    c.setFillColor(white)',
    '    c.setStrokeColor(white)',
    '    c.rect(0, h - 30, w, 30, fill=1, stroke=0)',
    '    c.rect(0, 0, w, 30, fill=1, stroke=0)',
    '    c.save()',
    '    packet.seek(0)',
    '    overlay = PdfReader(packet).pages[0]',
    '    page.merge_page(overlay)',
    '    writer.add_page(page)',
    'with open(dst, "wb") as f: writer.write(f)',
  ].join('\n');
  try {
    spawnAndWaitSync(python, ['-c', script, pdfPath, tempCleanPath], 30000);
    if (existsSync(tempCleanPath)) retryFs(() => copyFileSync(tempCleanPath, pdfPath));
  } catch {
    // If PDF cleanup is unavailable, keep the generated PDF rather than failing the run.
  } finally {
    try {
      if (existsSync(tempCleanPath)) unlinkSync(tempCleanPath);
    } catch {
      // harmless temp cleanup miss
    }
  }
}

function findPythonExecutable() {
  const candidates = [
    process.env.PYTHON_PATH,
    process.env.PYTHON,
    'python',
    join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe'),
    'py',
  ].filter(Boolean);
  return candidates.find((candidate) => pythonCandidateWorks(candidate)) || '';
}

function pythonCandidateWorks(candidate) {
  if (!['python', 'py'].includes(candidate) && !existsSync(candidate)) return false;
  const result = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[0])'], {
    encoding: 'utf-8',
    timeout: 5000,
    windowsHide: true,
  });
  return !result.error && result.status === 0 && String(result.stdout || '').trim().startsWith('3');
}

function spawnAndWaitSync(command, args = [], timeoutMs = 30000) {
  const result = spawnSync(command, args, { encoding: 'utf-8', timeout: timeoutMs, windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Command exited with code ${result.status}. ${result.stderr || result.stdout}`.trim());
}

function spawnAndWait(command, args = [], timeoutMs = 30000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // Process already closed.
      }
      rejectPromise(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`Command exited with code ${code}. ${stderr || stdout}`.trim()));
    });
  });
}

async function renderPdfWithBundledPlaywright(htmlPath, pdfPath) {
  const playwrightPath = join(ROOT, 'node_modules', 'playwright', 'index.mjs');
  const { chromium } = await import(pathToFileURL(playwrightPath).href);
  safeMkdir(dirname(pdfPath));
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
      displayHeaderFooter: false,
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
    return 'Resume PDF generation was blocked by Windows for external renderers. The app saved the analysis and resume HTML; the native PDF renderer should be used on the next run.';
  }
  if (lower.includes('executable') || lower.includes('browser') || lower.includes('chromium')) {
    return 'The browser PDF fallback could not start. The app saved the analysis and resume HTML.';
  }
  return raw.length > 500 ? `${raw.slice(0, 500)}...` : raw || 'Resume PDF generation failed, but the resume HTML and QA were saved.';
}

function writeResumeGenerationErrorLog(runId, error) {
  const logPath = join(LOG_DIR, `${runId || Date.now()}-resume-generation-error.log`);
  try {
    writeTextFile(logPath, String(error?.stack || error?.message || error || 'Resume generation failed.'));
    return artifactRelative(logPath);
  } catch {
    return '';
  }
}

function renderResumeHtml(result, cv, context = {}) {
  const parsed = parseCvMarkdown(cv);
  const matchingSkills = [...new Set(result.matchingSkills || [])];
  const experience = enrichExperience(parsed.experience, result, context);
  return renderDetailedAtsResumeHtml(parsed, experience, result, context, matchingSkills);
}

function renderDetailedAtsResumeHtml(parsed, experience, result, context = {}, matchingSkills = []) {
  const contactItems = [
    parsed.email ? { label: parsed.email, href: `mailto:${parsed.email}` } : null,
    parsed.phone ? { label: parsed.phone } : null,
    parsed.linkedin ? { label: parsed.linkedin, href: parsed.linkedin } : null,
    { label: parsed.location || 'United States' },
  ].filter(Boolean);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(parsed.name || 'Candidate Name')} - Resume</title>
<style>
  @page { size: Letter; margin: 0.38in; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #ffffff;
    color: #111111;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 9.4pt;
    line-height: 1.32;
  }
  header { text-align: center; margin-bottom: 8px; }
  h1 {
    margin: 0 0 3px;
    font-family: Georgia, "Times New Roman", serif;
    font-size: 22pt;
    line-height: 1;
    font-weight: 700;
  }
  .contact {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 0 8px;
    font-size: 8.8pt;
  }
  .contact span:not(:last-child)::after {
    content: "|";
    margin-left: 8px;
  }
  a { color: #111111; text-decoration: none; }
  section { margin-top: 8px; }
  h2 {
    margin: 0 0 4px;
    border-bottom: 1px solid #222222;
    font-size: 10.4pt;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: 0;
  }
  p { margin: 0; }
  .job, .project { margin-top: 6px; break-inside: avoid; page-break-inside: avoid; }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: baseline;
  }
  .company, .project-title { font-weight: 700; }
  .period { white-space: nowrap; }
  .role-line { font-style: italic; margin-top: 1px; }
  ul { margin: 3px 0 0; padding-left: 16px; }
  li { margin: 0 0 2px; padding-left: 1px; }
  .skills div { margin-bottom: 2px; }
  .skills strong { font-weight: 700; }
  .education-line, .cert-line { margin-top: 3px; }
</style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(parsed.name || 'Candidate Name')}</h1>
      <div class="contact">${contactItems.map((item) => `<span>${item.href ? `<a href="${escapeAttribute(item.href)}">${escapeHtml(item.label)}</a>` : escapeHtml(item.label)}</span>`).join('')}</div>
    </header>
    <section>
      <h2>Summary</h2>
      <p>${escapeHtml(buildResumeSummary(parsed.summary, result, context))}</p>
    </section>
    <section>
      <h2>Work Experience</h2>
      ${renderExperience(experience, matchingSkills)}
    </section>
    ${parsed.projects?.length ? `<section>
      <h2>Project</h2>
      ${renderProjects(parsed.projects, result, context)}
    </section>` : ''}
    <section>
      <h2>Education</h2>
      ${renderEducation(parsed.education)}
    </section>
    <section>
      <h2>Certifications</h2>
      ${renderCertifications(parsed.certifications)}
    </section>
    <section>
      <h2>Skills</h2>
      <div class="skills">${renderSkills(parsed.skills)}</div>
    </section>
  </main>
</body>
</html>`;
}

function renderOnePageResumeHtml(result, cv, context = {}) {
  const parsed = parseCvMarkdown(cv);
  const experience = compactOnePageExperience(enrichExperience(parsed.experience, result, context));
  const project = pickOnePageProject(parsed.projects, result, context);
  if (project && parsed.github) project.github = parsed.github;
  const contactItems = [
    parsed.email ? { label: parsed.email, href: `mailto:${parsed.email}` } : null,
    parsed.phone ? { label: parsed.phone } : null,
    parsed.linkedin ? { label: parsed.linkedin, href: parsed.linkedin } : null,
    { label: parsed.location || 'United States' },
  ].filter(Boolean);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(parsed.name || 'Candidate Name')} - One Page Resume</title>
<style>
  @page { size: Letter; margin: 0.32in; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #ffffff;
    color: #111111;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 8.85pt;
    line-height: 1.14;
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
  .contact a { color: #111111; text-decoration: none; }
  section { margin-top: 5px; }
  h2 {
    margin: 0 0 3px;
    border-bottom: 1px solid #222222;
    font-size: 10.1pt;
    line-height: 1.1;
    text-transform: uppercase;
    letter-spacing: 0;
  }
  p { margin: 0; }
  .skills div { margin-bottom: 1px; }
  .skills strong { font-weight: 700; }
  .job { margin-top: 4px; }
  .row {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    align-items: baseline;
  }
  .company, .school, .project-title { font-weight: 700; }
  .period, .location { white-space: nowrap; }
  .role-line { font-style: italic; margin-top: 1px; }
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
      <h1>${escapeHtml(parsed.name || 'Candidate Name')}</h1>
      <div class="contact">${contactItems.map((item) => `<span>${item.href ? `<a href="${escapeAttribute(item.href)}">${escapeHtml(item.label)}</a>` : escapeHtml(item.label)}</span>`).join('')}</div>
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
    || 'Job seeker with hands-on experience building reliable workflows, reporting datasets, and production-ready solutions.';
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
  const preferred = [
    'Programming',
    'AWS Core Services',
    'Cloud & Platforms',
    'Cloud and Platforms',
    'Cloud Platforms',
    'Data Engineering',
    'Databases & Warehouses',
    'Databases',
    'BI & Analytics',
    'BI and Analytics',
    'DevOps & Monitoring',
    'Orchestration & DevOps',
    'Orchestration and DevOps',
    'Orchestration',
  ];
  const parsed = skills.map((line) => {
    const [category, ...rest] = line.split(':');
    return { category: category.trim(), values: rest.join(':').trim() };
  }).filter((item) => item.category && item.values);
  return preferred
    .map((category) => parsed.find((item) => item.category.toLowerCase() === category.toLowerCase()))
    .filter(Boolean)
    .slice(0, 6)
    .map((item) => `<div><strong>${escapeHtml(item.category)}:</strong> ${escapeHtml(compactList(item.values, 12))}</div>`)
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
  const limits = [8, 5, 4, 3];
  return experience.map((job, index) => ({
    ...job,
    bullets: (job.bullets || []).slice(0, limits[index] || 0).map(compactBullet).filter(Boolean),
  })).filter((job) => job.bullets.length);
}

function compactBullet(value) {
  const text = ensurePeriod(String(value || '').replace(/\s+/g, ' ').trim());
  if (text.length <= 190) return text;
  const shortened = text.slice(0, 187).replace(/\s+\S*$/, '');
  return ensurePeriod(shortened);
}

function renderOnePageExperience(experience) {
  return experience.map((job) => `<div class="job">
  <div class="row"><span class="company">${escapeHtml(job.company)}</span><span class="period">${escapeHtml(job.period)}</span></div>
  <div class="role-line">${escapeHtml([job.role, job.location].filter(Boolean).join(' | '))}</div>
  <ul>${job.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>
</div>`).join('\n');
}

function pickOnePageProject(projects, result, context) {
  const terms = resumeTerms(result, context);
  const target = `${result.title || ''} ${result.jdText || ''}`.toLowerCase();
  const ranked = [...projects].sort((a, b) => scoreProject(b, terms, target) - scoreProject(a, terms, target));
  const project = ranked[0];
  if (!project) return null;
  const bullets = rankBullets(project.bullets || [], terms).slice(0, 3).map(compactBullet);
  return { ...project, bullets };
}

function scoreProject(project, terms, target) {
  const text = `${project.title || ''} ${project.tech || ''} ${(project.bullets || []).join(' ')}`.toLowerCase();
  let score = terms.reduce((value, term) => value + (text.includes(term.toLowerCase()) ? 1 : 0), 0);
  if (/ai|ml|rag|financial|stock|analytics|python|sqlite|pipeline/.test(text)) score += 2;
  if (/ai|ml|rag|fraud|risk|fintech/.test(target) && /ai|ml|rag|financial/.test(text)) score += 3;
  if (/llm|agent|automation|prompt|developer productivity|copilot|cursor/.test(target) && /llm|agent|automation|prompt|copilot|cursor|gemini/.test(text)) score += 4;
  if (/classification|forecast|anomaly|feature engineering|random forest|lstm/.test(target) && /classification|forecast|anomaly|feature engineering|random forest|lstm/.test(text)) score += 4;
  return score;
}

function renderOnePageProject(project) {
  const github = project.github || '';
  const title = github ? `${project.title} (${github})` : project.title;
  return `<div class="project">
  <div class="project-title">${escapeHtml(title)}</div>
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
  const email = cv.match(/Email:\s*([^\n]+)/i)?.[1]?.trim() || cv.match(/([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/i)?.[1]?.trim();
  const phone = cv.match(/Phone:\s*([^\n]+)/i)?.[1]?.trim() || cv.match(/(\+?1?\s*\(?\d{3}\)?[-.\s]*\d{3}[-.\s]*\d{4})/)?.[1]?.trim();
  const linkedin = cv.match(/LinkedIn:\s*(https?:\/\/\S+)/i)?.[1]?.trim() || cv.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/\S+/i)?.[0]?.trim();
  const github = cv.match(/GitHub:\s*(https?:\/\/\S+)/i)?.[1]?.trim() || cv.match(/https?:\/\/(?:www\.)?github\.com\/\S+/i)?.[0]?.trim();
  const summary = firstSection(cv, ['Professional Summary', 'Summary']).replace(/\n+/g, ' ').trim();
  const skillsLines = firstSection(cv, ['Technical Skills', 'Skills', 'Skills & Interests'])
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s*/, ''))
    .filter((line) => line && !/^##/.test(line));
  const competencies = skillsLines.flatMap((line) => line.replace(/^-\s*/, '').split(':').slice(1).join(':').split(',')).map((item) => item.trim()).filter(Boolean);
  return {
    name,
    email,
    phone,
    linkedin: normalizeLinkedin(linkedin, email, name),
    github,
    portfolio: github,
    location: 'United States',
    summary,
    skills: skillsLines,
    competencies,
    experience: parseExperience(firstSection(cv, ['Professional Experience', 'Work Experience', 'Experience'])),
    projects: parseProjects(firstSection(cv, ['Projects', 'Project'])),
    certifications: parseCertifications(section(cv, 'Certifications')),
    education: section(cv, 'Education').split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
  };
}

function normalizeLinkedin(linkedin = '', email = '', name = '') {
  const value = String(linkedin || '').trim();
  if (/^https?:\/\/(?:www\.)?linkedin\.com\/in\//i.test(value)) return value.replace(/[).,]+$/, '');
  return '';
}

function applyProfileRoleDefaults(parsed, context = {}) {
  const targetRole = String(context.profileYml || '').match(/target_role:\s*([^\n]+)/i)?.[1]?.replace(/['"]/g, '').trim() || '';
  if (!targetRole || !Array.isArray(parsed.experience)) return parsed;
  if (!/bi developer|data analyst/i.test(targetRole)) return parsed;
  return {
    ...parsed,
    experience: parsed.experience.map((job) => ({
      ...job,
      role: /bi developer/i.test(targetRole) ? 'BI Developer' : (job.role || 'Data Analyst'),
    })),
  };
}

function firstSection(markdown, headings = []) {
  for (const heading of headings) {
    const text = section(markdown, heading);
    if (text) return text;
  }
  return '';
}

function section(markdown, heading) {
  const match = markdown.match(new RegExp(`^##(?!#)\\s+${escapeRegExp(heading)}\\s*\\n([\\s\\S]*?)(?=^##(?!#)\\s+|(?![\\s\\S]))`, 'im'));
  return match?.[1]?.trim() || '';
}

function parseExperience(text) {
  const structured = text.split(/^###\s+/m).slice(1).map((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const [companyRole, meta = ''] = lines;
    const [company, role] = companyRole.split(/\s+-\s+/, 2);
    const [location, period] = meta.split('|').map((item) => item?.trim());
    const bullets = lines.filter((line) => line.startsWith('-')).map((line) => line.replace(/^-\s*/, '').trim());
    return { company, role, location, period, bullets };
  });
  if (structured.length) return structured;
  const loose = parseLooseExperience(text);
  if (loose.length) return loose;
  return parseFlatExperienceByCompany(text);
}

function parseLooseExperience(text = '') {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const jobs = [];
  let current = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].replace(/[Ã¢â‚¬â€œÃ¢â‚¬â€]/g, '-');
    const next = lines[index + 1] || '';
    const match = looseExperienceHeader(line, next);
    if (match) {
      if (current) jobs.push(current);
      current = {
        company: match.company,
        role: match.role,
        location: match.location,
        period: match.period,
        bullets: [],
      };
      if (match.consumeNext) index += 1;
      continue;
    }
    if (!current) continue;
    const bullet = line.replace(/^-\s*/, '').trim();
    if (bullet.length > 45 && !/^\w+:\s*$/.test(bullet)) current.bullets.push(bullet);
  }
  if (current) jobs.push(current);
  return jobs;
}

function parseFlatExperienceByCompany(text = '') {
  const bullets = text
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^-\s*/, ''))
    .filter((line) => line.length > 45);
  if (bullets.length < 4) return [];
  const profiles = [
    {
      company: 'Charter Communications',
      role: 'Data Analyst',
      location: 'Denver, CO',
      period: 'May 2025 - Present',
      terms: ['incident', 'alert', 'correlation', 'cancellation', 'suppression', 'remedy', 'elasticsearch', 'kibana', 'druid', 'ml-ready', 'root-cause', 'operational'],
    },
    {
      company: 'T-Mobile',
      role: 'Data Analyst',
      location: 'Dallas, TX',
      period: 'Jan 2023 - Apr 2025',
      terms: ['azure data factory', 'adls', 'databricks', 'snowflake', 'sales', 'inventory', 'supply-chain', 'pipeline', 'schema validation', 'spark sql', 'pyspark', 'kpi-ready'],
    },
    {
      company: 'Citibank',
      role: 'Data Analyst',
      location: 'Irving, TX',
      period: 'Jun 2022 - Nov 2022',
      terms: ['ssurm', 'safety compass', 'pl/sql', 'stored procedure', 'procedure', 'packages', 'triggers', 'views', 'indexes', 'ssis', 'database', 'query performance'],
    },
    {
      company: 'M.J Distributions',
      role: 'Data Analyst',
      location: 'India',
      period: 'Jun 2019 - Dec 2020',
      terms: ['tableau', 'dashboard', 'eda', 'retail', 'billing', 'logistics', 'excel', 'customer', 'inventory', 'reporting efficiency', 'manual reporting'],
    },
  ];
  const grouped = new Map(profiles.map((profile) => [profile.company, []]));
  for (const bullet of bullets) {
    const lower = bullet.toLowerCase();
    const scored = profiles
      .map((profile) => ({
        profile,
        score: profile.terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0),
      }))
      .sort((a, b) => b.score - a.score);
    const target = scored[0]?.score > 0 ? scored[0].profile.company : profiles[Math.min(grouped.size - 1, profiles.length - 1)].company;
    grouped.get(target)?.push(bullet);
  }
  return profiles
    .map((profile) => ({
      company: profile.company,
      role: profile.role,
      location: profile.location,
      period: profile.period,
      bullets: (grouped.get(profile.company) || []).slice(0, profile.company === 'Charter Communications' ? 8 : 6),
    }))
    .filter((job) => job.bullets.length);
}

function looseExperienceHeader(line = '', next = '') {
  const companies = ['Charter Communications', 'T-Mobile', 'Citibank', 'M.J Distributions', 'M.J. Distributions'];
  const roleCompany = line.match(/^(.+?)\s+\|\s+(Charter Communications|T-Mobile(?: \(Metro by T-Mobile\))?|Citibank|M\.J\.? Distributions)$/i);
  if (roleCompany) {
    return {
      company: roleCompany[2],
      role: roleCompany[1],
      location: next.includes('|') ? next.split('|')[0].trim() : '',
      period: next.includes('|') ? next.split('|').slice(1).join('|').trim() : '',
      consumeNext: next.includes('|'),
    };
  }
  for (const company of companies) {
    if (!line.toLowerCase().includes(company.toLowerCase())) continue;
    const [left, periodPart = ''] = line.split(/\s+\|\s+/, 2);
    const roleMatch = splitCompanyRoleLocation(left, company);
    if (roleMatch) {
      return {
        company,
        role: roleMatch.role,
        location: roleMatch.location,
        period: periodPart.trim(),
      };
    }
    const role = next && !next.includes('|') && next.length < 90 ? next : '';
    const period = line.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\s*-\s*(?:Present|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}))/i)?.[1] || '';
    return {
      company,
      role,
      location: line.replace(company, '').replace(period, '').replace(/[,|-]/g, ' ').trim(),
      period,
      consumeNext: Boolean(role),
    };
  }
  return null;
}

function splitCompanyRoleLocation(left = '', company = '') {
  const remainder = left
    .replace(new RegExp(`^${escapeRegExp(company)}\\s*[-\\u2013\\u2014]?\\s*`, 'i'), '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!remainder) return null;

  const knownRoleMatch = remainder.match(/^(Senior Data Engineer|Data Engineer|Data Analyst|Database Developer|DB Developer|BI Developer|DBA Admin|Production Support(?: Engineer| Analyst)?|Database Administrator)\b\s*(.*)$/i);
  if (knownRoleMatch) {
    return {
      role: normalizeRoleTitle(knownRoleMatch[1]),
      location: cleanLocationText(knownRoleMatch[2]),
    };
  }

  const locationPattern = /\s+((?:[A-Za-z .]+,\s*[A-Z]{2})|India|USA|United States|Texas,\s*USA)$/i;
  const locationMatch = remainder.match(locationPattern);
  const location = locationMatch?.[1]?.trim() || '';
  const role = (location ? remainder.slice(0, locationMatch.index).trim() : remainder)
    .replace(/\s*[-\u2013\u2014]\s*$/, '')
    .trim();
  if (!role) return null;
  return { role: normalizeRoleTitle(role), location };
}
function normalizeRoleTitle(role = '') {
  return String(role || '')
    .replace(/\bData\s+Engineer\b/i, 'Data Engineer')
    .replace(/\bSenior\s+Data\s+Engineer\b/i, 'Senior Data Engineer')
    .replace(/\bData\s+Analyst\b/i, 'Data Analyst')
    .replace(/\bDatabase\s+Developer\b/i, 'Database Developer')
    .replace(/\bDBA\s+Admin\b/i, 'DBA Admin')
    .trim();
}

function cleanLocationText(location = '') {
  return String(location || '')
    .replace(/^[-|,\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function parseProjects(text) {
  const structured = text.split(/^###\s+/m).slice(1).map((block) => {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const titleUrl = extractFirstUrl(lines[0] || '');
    const title = cleanProjectTitle(lines[0] || '');
    const tech = lines.find((line) => line.toLowerCase().startsWith('technologies:'))?.replace(/^Technologies:\s*/i, '') || '';
    const bullets = lines.filter((line) => line.startsWith('-')).map((line) => line.replace(/^-\s*/, '').trim());
    return { title, tech, bullets, github: titleUrl };
  });
  if (structured.length) return structured;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const titleUrl = extractFirstUrl(lines[0] || '');
  const title = cleanProjectTitle(lines[0] || '');
  const tech = lines[1] && !looksLikeSentence(lines[1]) ? lines[1] : '';
  const bulletStart = tech ? 2 : 1;
  const bullets = lines.slice(bulletStart).filter((line) => line.length > 35).map((line) => line.replace(/^-\s*/, '').trim());
  return [{ title, tech, bullets, github: titleUrl }];
}

function extractFirstUrl(text = '') {
  return String(text || '').match(/https?:\/\/\S+/i)?.[0]?.replace(/[).,]+$/, '') || '';
}

function cleanProjectTitle(title = '') {
  return String(title || '')
    .replace(/\s*\(https?:\/\/[^)]+\)\s*/i, '')
    .replace(/\s+https?:\/\/\S+/i, '')
    .trim();
}
function parseCertifications(text = '') {
  return text
    .split(/\r?\n|\|/)
    .map((line) => line.replace(/^-\s*/, '').trim())
    .filter(Boolean)
    .filter((line) => !/^##/.test(line));
}

function looksLikeSentence(line = '') {
  return /[.!?]$/.test(line.trim()) || line.split(/\s+/).length > 12;
}

function buildResumeSummary(summary, result, context) {
  const base = summary || 'Job seeker with hands-on experience building reliable workflows, reporting datasets, and production-ready solutions.';
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
    const digestBullets = shouldUseDigestForJob(job.company, result)
      ? digestBulletsForCompany(job.company, context.articleDigest, terms, result, context)
      : [];
    if (context.resumeTrace) context.resumeTrace.digestCandidatesReviewed += digestBullets.length;
    const limit = bulletLimitForJob(job, index);
    const digestLimit = digestBulletLimitForJob(job, index);
    const selectedDigest = rankBullets(digestBullets, terms)
      .filter((bullet) => scoreBullet(bullet, terms.map((term) => term.toLowerCase())) >= 3)
      .slice(0, digestLimit);
    const selectedSource = rankBullets(sourceBullets, terms);
    const combined = dedupeBullets([...selectedDigest, ...selectedSource]);
    if (context.resumeTrace) {
      selectedDigest.forEach((bullet) => context.resumeTrace.selectedDigestBullets.push({ company: job.company, bullet }));
      selectedSource.slice(0, Math.max(limit, 1)).forEach((bullet) => context.resumeTrace.selectedCvBullets.push({ company: job.company, bullet }));
      combined.slice(0, limit).forEach((bullet) => {
        const source = selectedDigest.some((digestBullet) => normalizeForMatch(digestBullet) === normalizeForMatch(bullet))
          ? 'article-digest.md'
          : 'cv.md';
        context.resumeTrace.finalBullets.push({ company: job.company, source, bullet });
      });
    }
    return {
      ...job,
      bullets: combined.slice(0, limit),
    };
  });
}

function shouldUseDigestForJob(company, result = {}) {
  const companyText = String(company || '').toLowerCase();
  const target = `${result.title || ''} ${result.jdText || ''}`.toLowerCase();
  if (companyText.includes('charter')) {
    return /\b(ai|ml|machine learning|feature engineering|incident|network|alert|suppression|correlation|operations|operational analytics|python|kibana|elasticsearch)\b/.test(target);
  }
  if (companyText.includes('t-mobile')) {
    return /\b(data engineer|databricks|snowflake|spark|pyspark|azure data factory|adf|aws glue|redshift|s3|control-m|cdc|orchestration|production support)\b/.test(target);
  }
  if (companyText.includes('citibank')) {
    return /\b(database|db developer|oracle|pl\/sql|plsql|stored procedure|procedures|packages|functions|triggers|views|ssis|sql server|backend data)\b/.test(target);
  }
  if (companyText.includes('m.j')) {
    return /\b(data analyst|bi developer|business intelligence|tableau|power bi|dashboard|dashboards|kpi|excel|retail|billing|inventory analytics|reporting|eda)\b/.test(target);
  }
  return false;
}

function isAiMlTargetText(value = '') {
  return /\b(ai|ml|machine learning|classification|forecast|forecasting|prediction|predictive|anomaly|feature engineering|random forest|gradient boosting|lstm|shap|arima|model explainability|time-series|time series|supervised model|duplicate-ticket|duplicate ticket)\b/i.test(String(value || ''));
}

function isAiToolsTargetText(value = '') {
  return /\b(github copilot|copilot|cursor|llm assistant|llm assistants|ai-assisted|ai assisted|prompt engineering|developer productivity|code generation|ai coding|coding assistant|debugging with ai|responsible ai|llm workflow|llm workflows)\b/i.test(String(value || ''));
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
  const jdTerms = extractKnownSkills(target);
  const profileTerms = extractKnownSkills(`${context.profileYml || ''}\n${context.profileMd || ''}`);
  const themeTerms = [];
  if (/azure|adf/i.test(target)) themeTerms.push('Azure Data Factory', 'Azure Databricks', 'PySpark');
  if (/databricks|spark|pyspark/i.test(target)) themeTerms.push('Databricks', 'PySpark');
  if (/\baws\b|amazon|glue|redshift|s3|emr|athena|step functions/i.test(target)) themeTerms.push('AWS Glue', 'Amazon Redshift', 'Amazon S3', 'Amazon EMR');
  if (/cybersecurity|identity security|security posture|data lake|datalake|distributed|object stores|ml operations|mlops|graph data|observability/i.test(target)) {
    themeTerms.push('data lake', 'distributed processing', 'monitoring', 'observability', 'ML Operations', 'Python', 'Spark');
  }
  if (/snowflake|warehouse|analytics engineer/i.test(target)) themeTerms.push('Snowflake', 'data modeling', 'ELT');
  if (/production|etl|support|sla|control-m|cdc/i.test(target)) themeTerms.push('Control-M', 'CDC', 'production support');
  if (/power bi|tableau|reporting|dashboard/i.test(target)) themeTerms.push('Power BI', 'Tableau', 'KPI reporting');
  return [...new Set([...skills, ...jdTerms, ...profileTerms, ...themeTerms])];
}

function buildResumeTailoringQa(html, result, context = {}) {
  const resumeText = normalizeForMatch(htmlToText(html));
  const jdText = normalizeForMatch(`${result.title || ''} ${result.jdText || ''}`);
  const requiredTerms = extractResumeQaTerms(jdText, result);
  const matchedTerms = requiredTerms.filter((term) => termMatches(resumeText, term));
  const missingTerms = requiredTerms.filter((term) => !termMatches(resumeText, term)).slice(0, 8);
  const digestBullets = digestBulletsForQa(context.articleDigest);
  const trace = context.resumeTrace || {};
  const selectedDigestBullets = (trace.selectedDigestBullets || []).map((item) => item.bullet || item).filter(Boolean);
  const articleDigestCandidateCount = Number(trace.digestCandidatesReviewed || digestBullets.length || 0);
  const usedDigestBullets = selectedDigestBullets.slice(0, 8);
  const articleDigestBulletCount = usedDigestBullets.length;
  const articleDigestUsed = articleDigestBulletCount > 0;
  const coverage = requiredTerms.length ? matchedTerms.length / requiredTerms.length : 1;
  const suspiciousPhrases = findSuspiciousResumePhrases(resumeText);
  const repeatedMetrics = findRepeatedMetrics(resumeText);
  const unsupportedClaims = findUnsupportedClaims(resumeText, `${result.jdText || ''} ${context.articleDigest || ''}`);
  const cloudContaminationWarnings = findCloudProfileContamination(trace.finalBullets || [], context);
  const missingExperience = context.resumeSourceHasExperience === false;
  let score = Math.round((coverage * 75) + (articleDigestUsed ? 15 : 0) + (resumeText.includes('professional summary') || resumeText.includes('summary') ? 10 : 0));
  if (missingTerms.length >= 5) score = Math.min(score, 69);
  if (suspiciousPhrases.length || repeatedMetrics.length || unsupportedClaims.length) score = Math.min(score, 74);
  if (cloudContaminationWarnings.length) score = Math.min(score, 59);
  if (missingExperience) score = Math.min(score, 49);
  const status = !missingExperience && !cloudContaminationWarnings.length && score >= 80 && missingTerms.length <= 3 && !suspiciousPhrases.length && !unsupportedClaims.length
    ? 'strong_match'
    : score >= 65 ? 'review_recommended' : 'needs_review';
  const checks = [
    `Resume profile used: ${context.resumeProfileLabel || context.resumeProfileId || 'Resume Workspace cv.md'}`,
    `JD keyword coverage: ${matchedTerms.length}/${requiredTerms.length || 0}`,
    missingExperience
      ? 'Resume profile parsing warning: no client work experience was parsed from cv.md'
      : 'Resume profile includes parsed client work experience',
    articleDigestUsed
      ? `article-digest.md contributed ${articleDigestBulletCount} selected resume bullet${articleDigestBulletCount === 1 ? '' : 's'}`
      : `No article-digest.md bullets were selected for this resume (${articleDigestCandidateCount} candidate bullets reviewed)`,
    missingTerms.length
      ? `Review missing JD terms: ${missingTerms.join(', ')}`
      : 'No major JD terms missing from the resume text',
    suspiciousPhrases.length ? `Remove suspicious phrases: ${suspiciousPhrases.join(', ')}` : 'No suspicious AI-sounding phrases found',
    repeatedMetrics.length ? `Review repeated metrics: ${repeatedMetrics.join(', ')}` : 'No repeated high-signal metrics found',
    unsupportedClaims.length ? `Review unsupported claims: ${unsupportedClaims.join(', ')}` : 'No obvious unsupported claim patterns found',
    cloudContaminationWarnings.length ? `Review profile/tool mismatch: ${cloudContaminationWarnings.join('; ')}` : 'No AWS/Azure profile contamination found',
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
    selectedDigestBullets: usedDigestBullets,
    selectedCvBullets: (trace.selectedCvBullets || []).slice(0, 12),
    finalBullets: (trace.finalBullets || []).slice(0, 20),
    suspiciousPhrases,
    repeatedMetrics,
    unsupportedClaims,
    cloudContaminationWarnings,
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

function findCloudProfileContamination(finalBullets = [], context = {}) {
  const profile = `${context.resumeProfileId || ''} ${context.resumeProfileLabel || ''}`.toLowerCase();
  const bulletText = (finalBullets || []).map((item) => item.bullet || item).join('\n');
  const warnings = [];
  if (profile.includes('aws') && hasAzureOnlyTerms(bulletText)) warnings.push('AWS profile includes Azure-only experience bullet');
  if (profile.includes('azure') && hasAwsOnlyTerms(bulletText)) warnings.push('Azure profile includes AWS-only experience bullet');
  return warnings;
}

function digestBulletAllowedForProfile(bullet = '', context = {}) {
  const profile = `${context.resumeProfileId || ''} ${context.resumeProfileLabel || ''}`.toLowerCase();
  if (profile.includes('aws') && hasAzureOnlyTerms(bullet)) return false;
  if (profile.includes('azure') && hasAwsOnlyTerms(bullet)) return false;
  if (profile.includes('data-engineer') || profile.includes('data engineer')) return !hasMixedCloudTerms(bullet);
  return true;
}

function hasAzureOnlyTerms(value = '') {
  return /\b(azure data factory|azure databricks|adf pipelines?|adls|azure data lake|azure devops)\b/i.test(String(value || ''));
}

function hasAwsOnlyTerms(value = '') {
  return /\b(aws glue|amazon emr|amazon redshift|amazon s3|aws lambda|amazon kinesis|aws lake formation|amazon athena|aws dms|aws step functions|aws glue data catalog)\b/i.test(String(value || ''));
}

function hasMixedCloudTerms(value = '') {
  return hasAzureOnlyTerms(value) && hasAwsOnlyTerms(value);
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

function digestBulletsForCompany(company, articleDigest, terms = [], result = {}, context = {}) {
  if (!articleDigest) return [];
  const digestSection = companyDigestSection(company, articleDigest, terms, result);
  if (!digestSection) return [];

  return digestSection
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('*'))
    .map((line) => line.replace(/^\*\s*/, '').replace(/\*\*/g, '').trim())
    .map(sentenceCase)
    .map(ensurePeriod)
    .filter(isResumeQualityBullet)
    .filter((bullet) => digestBulletAllowedForProfile(bullet, context))
    .slice(0, 12);
}

function companyDigestSection(company, articleDigest, terms = [], result = {}) {
  const companyText = String(company || '').toLowerCase();
  const targetText = `${result.title || ''} ${result.jdText || ''} ${(result.matchingSkills || []).join(' ')}`.toLowerCase();
  const sections = [
    { match: 'charter', pattern: /## 1\)[\s\S]*?(?=\n## 2\))/m },
    { match: 't-mobile', pattern: /## 2\)[\s\S]*?(?=\n## 3\))/m },
    { match: 'citibank', pattern: /## 3\)[\s\S]*?(?=\n## 4\))/m },
    { match: 'm.j', pattern: /## 4\)[\s\S]*?(?=\n## 5\)|$)/m },
  ];
  const section = sections.find((item) => companyText.includes(item.match));
  let selectedText = section ? (articleDigest.match(section.pattern)?.[0] || '') : '';
  if (companyText.includes('charter') && selectedText && !isAiMlTargetText(targetText)) {
    selectedText = selectedText.replace(/\n### AI \/ ML Extension - Incident Noise Reduction & Prediction[\s\S]*?(?=\n---\s*$|\n---\s*\n## 2\)|\n## 2\)|$)/, '');
  }
  return selectedText;
}

function digestProjectsForTarget(articleDigest = '', result = {}, context = {}) {
  const target = `${result.title || ''} ${result.jdText || ''} ${(result.matchingSkills || []).join(' ')}`.toLowerCase();
  const useEazyProject = /\b(ai|llm|agent|automation|prompt|gemini|resume qa|resume tailoring|human-in-the-loop|human in the loop|career operations)\b/.test(target);
  const useAiToolsProject = isAiToolsTargetText(target);
  if (!useEazyProject && !useAiToolsProject) {
    return [];
  }
  const candidates = [
    {
      pattern: /## 5\)[\s\S]*?(?=\n## 6\)|$)/m,
      title: 'Personal Resume Helper - AI Career Operations Assistant',
      tech: 'Node.js, JavaScript, Google Gemini API, LLM workflows, resume QA, native PDF generation',
      github: 'https://github.com/harikrish0980/Eazy-Job-Apply',
      shouldUse: useEazyProject,
    },
    {
      pattern: /## 6\)[\s\S]*?(?=\n---\n\n# Tailoring Guidance|$)/m,
      title: 'Cross-Project AI Tools / Developer Productivity',
      tech: 'GitHub Copilot, Cursor, LLM assistants, prompt engineering, SQL/Python/JavaScript debugging',
      github: '',
      shouldUse: useAiToolsProject,
    },
  ];
  const terms = resumeTerms(result, context);
  return candidates
    .filter((candidate) => candidate.shouldUse)
    .map((candidate) => {
      const section = articleDigest.match(candidate.pattern)?.[0] || '';
      const bullets = digestBulletsFromSection(section);
      return {
        title: candidate.title,
        tech: candidate.tech,
        github: candidate.github,
        bullets: rankBullets(bullets, terms).slice(0, 3),
      };
    })
    .filter((project) => project.bullets.some((bullet) => scoreBullet(bullet, terms.map((term) => term.toLowerCase())) > 0))
    .slice(0, 2);
}

function digestBulletsFromSection(section = '') {
  return String(section || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('*'))
    .map((line) => line.replace(/^\*\s*/, '').replace(/\*\*/g, '').trim())
    .map(sentenceCase)
    .map(ensurePeriod)
    .filter(isResumeQualityBullet);
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
  <div class="row"><span class="company">${escapeHtml(job.company)}</span><span class="period">${escapeHtml(job.period)}</span></div>
  <div class="role-line">${escapeHtml([job.role, job.location].filter(Boolean).join(' | '))}</div>
  <ul>${bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>
</div>`;
  }).join('\n');
}

function renderProjects(projects, result, context) {
  const terms = resumeTerms(result, context);
  return projects.slice(0, 2).map((project) => {
    const bullets = rankBullets(project.bullets || [], terms).slice(0, 3);
    const github = project.github || '';
    const title = github ? `${project.title} (${github})` : project.title;
    return `<div class="project">
  <div class="project-title">${escapeHtml(title)}</div>
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
  return skills.map((line) => {
    const [category, ...rest] = line.split(':');
    return `<div><strong>${escapeHtml(category)}:</strong> ${escapeHtml(rest.join(':').trim())}</div>`;
  }).join('\n');
}

function rankBullets(bullets, skills) {
  const terms = normalizeBulletScoreTerms(skills || []);
  return [...bullets].sort((a, b) => scoreBullet(b, terms) - scoreBullet(a, terms));
}

function normalizeBulletScoreTerms(skills = []) {
  const generic = new Set(['data', 'analytics', 'reporting', 'support', 'business', 'experience', 'team', 'systems']);
  return [...new Set((skills || [])
    .map((skill) => String(skill || '').trim())
    .filter((skill) => skill && skill.length >= 2)
    .filter((skill) => !generic.has(skill.toLowerCase()))
    .map((skill) => skill.toLowerCase()))];
}

function scoreBullet(bullet, terms) {
  const lower = String(bullet || '').toLowerCase();
  const normalized = normalizeForMatch(lower);
  let score = 0;
  for (const term of terms || []) {
    const normalizedTerm = normalizeForMatch(term);
    if (!normalizedTerm) continue;
    if (normalized.includes(normalizedTerm)) {
      score += normalizedTerm.includes(' ') || normalizedTerm.includes('/') ? 3 : 1;
      continue;
    }
    const termWords = normalizedTerm.split(' ').filter((word) => word.length >= 3);
    if (termWords.length >= 2 && termWords.every((word) => normalized.includes(word))) score += 2;
  }
  if (/\b(0\.5-2 TB|50K-300K|30-40%|40%|25%|30%)\b/i.test(bullet)) score += 3;
  if (/\b(improved|reduced|optimized|standardized|orchestrated|resolved|implemented|built|developed|prepared|supported|validated|automated|engineered)\b/i.test(bullet)) score += 1;
  if (/\b(production|sla|data quality|monitoring|observability|pipeline|etl|elt|dashboard|kpi|stored procedure|performance tuning)\b/i.test(bullet)) score += 1;
  if (/^Used\b/i.test(bullet)) score -= 2;
  if (String(bullet || '').length > 190) score -= 1;
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
  const body = `# Evaluation: ${summary.company} - ${summary.title}

**Date:** ${date}
**URL:** ${sourceUrl || 'manual'}
**Archetype:** Local web fallback
**Score:** ${summary.score}/5
**Legitimacy:** Needs Review
**PDF:** pending
**Tool:** Personal Resume Helper Web App fallback

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
`;
  const reportPath = writeTextFileWithFallback(
    join(ROOT, 'reports', filename),
    join(FALLBACK_REPORTS_DIR, filename),
    body,
  );
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
    summary: `Initial local analysis found ${skills.length} recognizable technical keywords. Add GEMINI_API_KEY for the full Resume Workspace A-G evaluation.`,
    matchingSkills: skills.slice(0, 8),
    missingSkills: ['Review job-specific requirements manually', 'Confirm sponsorship/location constraints'],
    risks: ['This is a fallback analysis, not the full AI evaluation.', 'URL-only pages may require pasted job description text.'],
  };
}

function extractField(text, field) {
  return text.match(new RegExp(`${field}\\s*[:\\-]\\s*([^.;\\n]+)`, 'i'))?.[1]?.trim();
}

function extractKnownSkills(text) {
  const known = [
    'Java', 'Python', 'SQL', 'PL/SQL', 'Oracle', 'SQL Server', 'SSIS', 'Stored Procedures',
    'AWS', 'AWS Glue', 'AWS Lambda', 'Amazon S3', 'S3', 'Redshift', 'EMR', 'Athena',
    'Azure', 'Azure Data Factory', 'ADF', 'Azure Databricks', 'Azure Data Lake', 'Azure DevOps',
    'GCP', 'Spring Boot', 'React', 'Node.js', 'JavaScript', 'TypeScript', 'Kubernetes', 'Docker', 'Terraform',
    'Databricks', 'Snowflake', 'Spark', 'PySpark', 'Spark SQL', 'Kafka', 'PostgreSQL', 'MongoDB',
    'Airflow', 'Control-M', 'dbt', 'ETL', 'ELT', 'CDC', 'CI/CD', 'Microservices',
    'Power BI', 'Tableau', 'DAX', 'Excel', 'KPI', 'Dashboard', 'Reporting',
    'Kibana', 'Elasticsearch', 'Grafana', 'Splunk', 'Apache Druid', 'NiFi',
    'Machine Learning', 'ML', 'AI', 'Feature Engineering', 'Classification', 'Forecasting',
    'Random Forest', 'Gradient Boosting', 'LSTM', 'SHAP', 'ARIMA', 'LLM', 'Prompt Engineering',
    'Data Quality', 'Data Modeling', 'Dimensional Modeling', 'Data Warehouse', 'Data Lake',
    'Production Support', 'Performance Tuning', 'Monitoring', 'Observability'
  ];
  const lower = String(text || '').toLowerCase();
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

function isRecoverableLocalProcessError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('spawn eperm')
    || message.includes('access is denied')
    || message.includes('operation not permitted')
    || message.includes('uv_handle_closing');
}

function recoverableGeminiMessage(error) {
  const message = String(error?.message || error || '').toLowerCase();
  if (message.includes('429') || message.includes('quota') || message.includes('rate limit') || message.includes('too many requests')) {
    return 'Gemini free-tier quota or rate limit was reached. Created a local fallback report so the run can still complete. Wait a minute, or retry later for the full AI evaluation.';
  }
  if (message.includes('api_key') || message.includes('api key')) {
    return 'Gemini API key is missing or invalid. Created a local fallback report so the run can still complete.';
  }
  if (isRecoverableLocalProcessError(error)) {
    return 'The local Gemini evaluator process was blocked by Windows. Created a local fallback report so the run can still complete.';
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
  return `Resume Workspace completed an English-ready evaluation for ${cleanTitle} at ${cleanCompany}${scoreText}. Recommendation: ${cleanRecommendation}. Review the run detail for matching skills, gaps, risks, report, resume PDF, and apply link.`;
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
  return !/( arquetipo | dominio | funciÃƒÂ³n | funcion | remoto | hÃƒÂ­brido | hibrido | tamaÃƒÂ±o | descripcion | descripciÃƒÂ³n | construir | operar | no especificado )/.test(` ${text} `);
}

function cleanDisplayText(value) {
  return String(value || '')
    .replace(/ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢|ÃƒÂ¢Ã¢â€šÂ¬Ã‹Å“|ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢/g, "'")
    .replace(/ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ|ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â|ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã¢â‚¬Å“|ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â/g, '"')
    .replace(/ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“|ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â|ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ|ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â/g, '-')
    .replace(/ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¢/g, '-')
    .replace(/Ãƒâ€š/g, '')
    .replace(/ÃƒÆ’Ã‚Â©/g, 'e')
    .replace(/ÃƒÆ’Ã‚Â³/g, 'o')
    .replace(/ÃƒÆ’Ã‚Â¡/g, 'a')
    .replace(/ÃƒÆ’Ã‚Â­/g, 'i')
    .replace(/ÃƒÆ’Ã‚Âº/g, 'u')
    .replace(/ÃƒÆ’Ã‚Â±/g, 'n')
    .replace(/ÃƒÆ’Ã‚Â¼/g, 'u')
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

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}






