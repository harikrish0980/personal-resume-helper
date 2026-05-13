#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { appendTrackerEntry, parseApplicationsTracker } from './lib/tracker.mjs';
import { makeId, readState, updateState, writeState } from './lib/store.mjs';
import { runCareerOpsAnalysis } from './lib/careerOpsAdapter.mjs';
import { validateJobUrl } from './lib/urlSafety.mjs';
import { defaultJobSources, guidedSearchSources, mergeDiscoveredJobs, runDiscovery } from './lib/discovery.mjs';

const APP_ROOT = process.cwd();
loadEnvFile(join(APP_ROOT, '.env'));
const CAREER_OPS_ROOT = resolve(process.env.CAREER_OPS_PATH || join(APP_ROOT, '..', 'Career-Ops'));
const PUBLIC_DIR = join(APP_ROOT, 'public');
const PORT = Number(process.env.PORT || 3013);
const HOST = process.env.HOST || '127.0.0.1';
const DEBUG_LOCAL_PATHS = process.env.DEBUG_LOCAL_PATHS === '1';
const queue = [];
let activeRunId = null;
const discoveryQueue = [];
let activeDiscoveryRunId = null;
let dailyDiscoveryRunning = false;

loadEnvFile(join(CAREER_OPS_ROOT, '.env'));
process.env.GEMINI_MODEL ||= 'gemini-2.5-flash-lite';

const server = http.createServer(async (req, res) => {
  try {
    if (!isAllowedHost(req.headers.host)) {
      sendJson(res, 403, { error: 'Blocked non-local Host header.' });
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
    if (url.pathname.startsWith('/api/') && isMutatingMethod(req.method) && !isAllowedOrigin(req.headers.origin)) {
      sendJson(res, 403, { error: 'Blocked non-local Origin header.' });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    if (url.pathname.startsWith('/files/')) {
      serveFile(res, decodeURIComponent(url.pathname.replace('/files/', '')));
      return;
    }
    serveStatic(res, url.pathname);
  } catch (error) {
    const statusCode = Number(error.statusCode || error.status || 500);
    sendJson(res, statusCode, { error: publicErrorMessage(error) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Career-Ops Web App running at http://${HOST}:${PORT}`);
});

scrubStoredPrivateDiscoveryCriteria();
startDailyDiscoveryScheduler();

function isAllowedHost(hostHeader = '') {
  const host = String(hostHeader || '').trim();
  if (!host) return true;
  let hostname = '';
  try {
    hostname = new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  return hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '::1';
}

function isAllowedOrigin(origin = '') {
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
      && (!parsed.port || parsed.port === String(PORT));
  } catch {
    return false;
  }
}

function isMutatingMethod(method = '') {
  return ['POST', 'PATCH', 'PUT', 'DELETE'].includes(String(method || '').toUpperCase());
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    sendJson(res, 200, await getHealth());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/profile') {
    sendJson(res, 200, getProfile());
    return;
  }

  if (req.method === 'PATCH' && url.pathname === '/api/profile') {
    const body = await readJson(req);
    const profile = updateProfilePreferences(body);
    sendJson(res, 200, { profilePreferences: profile });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    const state = readState();
    sendJson(res, 200, visibleJobsPayload(state));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/job-sources') {
    const state = readState();
    sendJson(res, 200, { jobSources: defaultJobSources(state.jobSources) });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/source-library') {
    sendJson(res, 200, { guidedSearches: guidedSearchSources(CAREER_OPS_ROOT) });
    return;
  }

  const sourceMatch = url.pathname.match(/^\/api\/job-sources\/([^/]+)$/);
  if (sourceMatch && req.method === 'PATCH') {
    const body = await readJson(req);
    const source = updateJobSource(sourceMatch[1], body);
    sendJson(res, 200, { source });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/discovery/runs') {
    const state = readState();
    sendJson(res, 200, { discoveryRuns: (state.discoveryRuns || []).map(sanitizeDiscoveryRunForClient) });
    return;
  }

  const discoveryRunMatch = url.pathname.match(/^\/api\/discovery\/runs\/([^/]+)$/);
  if (req.method === 'GET' && discoveryRunMatch) {
    const state = readState();
    const discoveryRun = (state.discoveryRuns || []).find((run) => run.id === discoveryRunMatch[1]);
    if (!discoveryRun) sendJson(res, 404, { error: 'Discovery run not found.' });
    else sendJson(res, 200, { discoveryRun: sanitizeDiscoveryRunForClient(discoveryRun) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/discovery/run-now') {
    const body = await readJson(req);
    const discoveryRun = createDiscoveryRun(body);
    sendJson(res, 202, { discoveryRun });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/resume/parse') {
    const body = await readJson(req, 12 * 1024 * 1024);
    const parsed = await parseResumeUpload(body);
    sendJson(res, 200, parsed);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/resume/snapshot') {
    const body = await readJson(req, 12 * 1024 * 1024);
    const snapshot = saveResumeSnapshot(body);
    sendJson(res, 201, { snapshot: publicResumeSnapshot(snapshot) });
    return;
  }

  const resumeSnapshotMatch = url.pathname.match(/^\/api\/resume\/snapshots\/([^/]+)$/);
  if (req.method === 'DELETE' && resumeSnapshotMatch) {
    const result = deleteResumeSnapshot(resumeSnapshotMatch[1]);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/documents') {
    const state = readState();
    sendJson(res, 200, { documents: visibleDocuments(state) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/maintenance/clean-state') {
    const result = cleanStateData();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state/export') {
    const state = readState();
    const redacted = url.searchParams.get('redacted') !== 'false';
    sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      app: 'EaZy Job Apply',
      schemaVersion: state.schemaVersion || 2,
      redacted,
      state: redacted ? redactStateForExport(state) : state,
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/state/import') {
    const body = await readJson(req, 20 * 1024 * 1024);
    const imported = importStateBackup(body);
    sendJson(res, 200, imported);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/applications') {
    const state = readState();
    const applications = visibleApplications(state);
    const activeTrackerNumbers = new Set(applications.map((app) => String(app.trackerNumber || '')).filter(Boolean));
    sendJson(res, 200, {
      applications,
      tracker: parseApplicationsTracker()
        .filter((row) => !activeTrackerNumbers.has(String(row.number || '')))
        .map((row) => sanitizeTrackerRow(row, state)),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/jobs/analyze') {
    const body = await readJson(req);
    const response = createAnalysisRun(body);
    sendJson(res, 202, response);
    return;
  }

  const analyzeExistingMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/analyze$/);
  if (analyzeExistingMatch && req.method === 'POST') {
    const body = await readJson(req);
    const response = createExistingJobAnalysisRun(analyzeExistingMatch[1], body);
    sendJson(res, 202, response);
    return;
  }

  const jobFeedbackMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/feedback$/);
  if (jobFeedbackMatch && req.method === 'POST') {
    const body = await readJson(req);
    const job = updateJobFeedback(jobFeedbackMatch[1], body);
    sendJson(res, 200, { job });
    return;
  }

  const jobMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === 'PATCH') {
    const body = await readJson(req);
    const job = updateJob(jobMatch[1], body);
    sendJson(res, 200, { job });
    return;
  }

  if (jobMatch && req.method === 'DELETE') {
    deleteJob(jobMatch[1]);
    sendJson(res, 200, { ok: true });
    return;
  }

  const runMatch = url.pathname.match(/^\/api\/jobs\/runs\/([^/]+)$/);
  if (req.method === 'GET' && runMatch) {
    const state = readState();
    const run = state.runs.find((item) => item.id === runMatch[1]);
    if (!run) sendJson(res, 404, { error: 'Run not found' });
    else sendJson(res, 200, { run: sanitizeRunForClient(run, state) });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/applications') {
    const body = await readJson(req);
    const application = saveApplication(body.runId);
    sendJson(res, 201, { application });
    return;
  }

  const appMatch = url.pathname.match(/^\/api\/applications\/([^/]+)$/);
  if (req.method === 'PATCH' && appMatch) {
    const body = await readJson(req);
    const application = updateApplication(appMatch[1], body);
    sendJson(res, 200, { application });
    return;
  }

  const docMatch = url.pathname.match(/^\/api\/documents\/(.+)$/);
  if (req.method === 'DELETE' && docMatch) {
    const decoded = decodeURIComponent(docMatch[1]);
    hideDocument(decoded);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function createAnalysisRun(input) {
  const jobUrl = String(input.jobUrl || '').trim();
  const jobDescription = String(input.jobDescription || '').trim();
  if (!jobUrl && !jobDescription) throw new ApiError(400, 'Provide a job URL or paste a job description.');

  const urlCheck = validateJobUrl(jobUrl);
  if (!urlCheck.ok) throw new ApiError(400, urlCheck.error);

  const now = new Date().toISOString();
  const jobId = makeId('job');
  const runId = makeId('run');
  const run = {
    id: runId,
    jobId,
    jobUrl: urlCheck.url,
    jobDescription,
    notes: String(input.notes || ''),
    status: 'queued',
    generateResume: input.generateResume !== false,
    resumeMode: normalizeResumeMode(input.resumeMode),
    generateCoverLetter: Boolean(input.generateCoverLetter),
    saveToTracker: Boolean(input.saveToTracker),
    createdAt: now,
    updatedAt: now,
    result: null,
    errorMessage: '',
    logs: [],
  };

  const job = {
    id: jobId,
    title: 'Pending analysis',
    company: 'Unknown company',
    location: '',
    jobUrl: urlCheck.url,
    applyUrl: urlCheck.url,
    source: urlCheck.url ? new URL(urlCheck.url).hostname : 'manual',
    description: jobDescription,
    discoveredAt: now,
    status: 'analyzing',
    latestRunId: runId,
  };

  updateState((state) => {
    state.jobs.unshift(job);
    state.runs.unshift(run);
  });

  queue.push(runId);
  processQueue();
  return { runId, status: 'queued' };
}

function createExistingJobAnalysisRun(jobId, input = {}) {
  const now = new Date().toISOString();
  let response;
  updateState((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) throw new ApiError(404, 'Job not found.');
    const jobUrl = String(job.jobUrl || job.applyUrl || '').trim();
    const jobDescription = String(input.jobDescription ?? job.description ?? '').trim();
    if (!jobUrl && !jobDescription) throw new ApiError(400, 'This job needs a URL or job description before analysis.');
    const urlCheck = validateJobUrl(jobUrl);
    if (!urlCheck.ok) throw new ApiError(400, urlCheck.error);

    const runId = makeId('run');
    const run = {
      id: runId,
      jobId: job.id,
      jobUrl: urlCheck.url,
      jobDescription,
      notes: String(input.notes ?? job.notes ?? ''),
      status: 'queued',
      generateResume: input.generateResume !== false,
      resumeMode: normalizeResumeMode(input.resumeMode),
      generateCoverLetter: Boolean(input.generateCoverLetter),
      saveToTracker: Boolean(input.saveToTracker),
      createdAt: now,
      updatedAt: now,
      result: null,
      errorMessage: '',
      logs: [],
    };

    job.status = 'analyzing';
    job.latestRunId = runId;
    job.updatedAt = now;
    state.runs.unshift(run);
    response = { runId, status: 'queued' };
  });

  queue.push(response.runId);
  processQueue();
  return response;
}

function createDiscoveryRun(options = {}) {
  const now = new Date().toISOString();
  const discoveryRunId = makeId('disc');
  const snapshot = readState();
  const sources = defaultJobSources(snapshot.jobSources);
  const normalizedOptions = prepareDiscoveryOptions(options, snapshot);
  let createdRun;
  updateState((state) => {
    state.jobSources = defaultJobSources(state.jobSources);
    if (normalizedOptions.persistResumeSnapshot !== false && normalizedOptions.resumeText?.trim()) {
      upsertResumeSnapshot(state, {
        id: normalizedOptions.resumeSnapshotId,
        source: normalizedOptions.resumeSource,
        fileName: normalizedOptions.resumeFileName,
        text: normalizedOptions.resumeText,
        inferredRole: normalizedOptions.inferredRole,
        createdAt: now,
        updatedAt: now,
      });
    }
    state.discoveryRuns ||= [];
    createdRun = {
      id: discoveryRunId,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      completedAt: '',
      criteria: {
        query: String(normalizedOptions.query || normalizedOptions.searchQuery || '').trim(),
        location: String(normalizedOptions.location || normalizedOptions.locationQuery || '').trim(),
        minScore: Number.isFinite(Number(normalizedOptions.minScore)) ? Number(normalizedOptions.minScore) : 80,
        sourceScope: String(normalizedOptions.sourceScope || 'balanced').trim(),
        scheduled: Boolean(normalizedOptions.scheduled),
        workMode: String(normalizedOptions.workMode || '').trim(),
        employmentType: String(normalizedOptions.employmentType || '').trim(),
        sponsorship: String(normalizedOptions.sponsorship || '').trim(),
        resumeSource: normalizedOptions.resumeSource,
        resumeSnapshotId: normalizedOptions.providedResumeText && normalizedOptions.persistResumeSnapshot === false ? '' : normalizedOptions.resumeSnapshotId,
        inferredRole: normalizedOptions.inferredRole,
        persistResumeSnapshot: normalizedOptions.persistResumeSnapshot !== false,
      },
      sourceResults: [],
      stats: {},
      importedJobIds: [],
      updatedJobIds: [],
      duplicateCount: 0,
      errorMessage: '',
    };
    state.discoveryRuns.unshift(createdRun);
  });

  discoveryQueue.push({
    discoveryRunId,
    sources,
    profilePreferences: defaultProfilePreferences(snapshot.profilePreferences),
    existingJobs: snapshot.jobs,
    normalizedOptions,
  });
  processDiscoveryQueue();
  return createdRun;
}

function processDiscoveryQueue() {
  if (activeDiscoveryRunId || !discoveryQueue.length) return;
  const next = discoveryQueue.shift();
  activeDiscoveryRunId = next.discoveryRunId;
  void runDiscoveryJob(next).finally(() => {
    activeDiscoveryRunId = null;
    processDiscoveryQueue();
  });
}

async function runDiscoveryJob({ discoveryRunId, sources, profilePreferences, existingJobs, normalizedOptions }) {
  try {
    const result = await runDiscovery({
      sources,
      profilePreferences,
      existingJobs,
      careerOpsRoot: CAREER_OPS_ROOT,
      options: normalizedOptions,
    });
    updateState((state) => {
      const merge = mergeDiscoveredJobs(state, result.discoveredJobs, discoveryRunId, makeId);
      const discoveryRun = state.discoveryRuns.find((item) => item.id === discoveryRunId);
      if (!discoveryRun) return;
      discoveryRun.status = 'completed';
      discoveryRun.updatedAt = new Date().toISOString();
      discoveryRun.completedAt = discoveryRun.updatedAt;
      discoveryRun.sourceResults = result.sourceResults;
      discoveryRun.stats = {
        ...result.stats,
        imported: merge.imported.length,
        refreshed: merge.updated.length,
        duplicates: merge.duplicates.length,
      };
      discoveryRun.criteria = sanitizeDiscoveryCriteria(result.criteria || discoveryRun.criteria);
      discoveryRun.importedJobIds = merge.imported;
      discoveryRun.updatedJobIds = merge.updated;
      discoveryRun.duplicateCount = merge.duplicates.length;
    });
  } catch (error) {
    updateState((state) => {
      const discoveryRun = state.discoveryRuns.find((item) => item.id === discoveryRunId);
      if (!discoveryRun) return;
      discoveryRun.status = 'failed';
      discoveryRun.updatedAt = new Date().toISOString();
      discoveryRun.completedAt = discoveryRun.updatedAt;
      discoveryRun.errorMessage = publicErrorMessage(error);
    });
  }
}

function startDailyDiscoveryScheduler() {
  const intervalMs = 30 * 60 * 1000;
  setTimeout(runDailyDiscoveryIfDue, 15000);
  setInterval(runDailyDiscoveryIfDue, intervalMs);
}

async function runDailyDiscoveryIfDue() {
  if (dailyDiscoveryRunning) return;
  const snapshot = readState();
  const preferences = defaultProfilePreferences(snapshot.profilePreferences);
  if (preferences.dailyDiscoveryEnabled !== 'true') return;
  const today = new Date().toISOString().slice(0, 10);
  const alreadyRanToday = (snapshot.discoveryRuns || []).some((run) => (
    run.criteria?.scheduled === true
    && String(run.createdAt || '').slice(0, 10) === today
  ));
  if (alreadyRanToday) return;
  dailyDiscoveryRunning = true;
  try {
    await createDiscoveryRun({
      query: preferences.defaultDiscoveryQuery,
      location: preferences.defaultDiscoveryLocation,
      minScore: preferences.defaultDiscoveryMinScore,
      sourceScope: preferences.defaultDiscoverySourceScope || 'balanced',
      scheduled: true,
    });
  } catch {
    // Discovery run creation already records source/run errors when possible.
  } finally {
    dailyDiscoveryRunning = false;
  }
}

async function parseResumeUpload(input = {}) {
  const fileName = String(input.fileName || input.name || '').trim();
  const mimeType = String(input.mimeType || input.type || '').trim();
  const data = String(input.data || '').trim();
  if (!fileName || !data) throw new ApiError(400, 'Choose a resume file to parse.');
  const base64 = data.includes(',') ? data.split(',').pop() : data;
  if (Buffer.byteLength(base64, 'base64') > 8 * 1024 * 1024) throw new ApiError(400, 'Resume file is too large. Use a file under 8 MB.');

  const script = `
import base64, io, json, sys

payload = json.load(sys.stdin)
name = (payload.get("fileName") or "").lower()
raw = base64.b64decode(payload.get("data") or "")
text = ""

try:
    if name.endswith((".txt", ".md")):
        text = raw.decode("utf-8", errors="ignore")
    elif name.endswith(".pdf"):
        from pypdf import PdfReader
        reader = PdfReader(io.BytesIO(raw))
        text = "\\n".join((page.extract_text() or "") for page in reader.pages)
    elif name.endswith(".docx"):
        import docx
        document = docx.Document(io.BytesIO(raw))
        text = "\\n".join(paragraph.text for paragraph in document.paragraphs)
    else:
        raise ValueError("Only PDF, DOCX, TXT, and MD resume files are supported right now.")
    print(json.dumps({"ok": True, "text": text[:120000]}))
except Exception as exc:
    print(json.dumps({"ok": False, "error": str(exc)}))
`;

  const result = await runPythonJson(script, { fileName, mimeType, data: base64 });
  if (!result.ok || !String(result.text || '').trim()) {
    throw new ApiError(400, result.error || 'Could not extract text from this resume. Paste the resume text instead.');
  }
  return { text: String(result.text || ''), fileName };
}

function saveResumeSnapshot(input = {}) {
  const text = String(input.text || '').trim();
  if (!text) throw new ApiError(400, 'Paste or upload resume text before saving it for discovery.');
  const now = new Date().toISOString();
  return updateState((state) => upsertResumeSnapshot(state, {
    id: input.id || makeId('resume'),
    source: input.source || (input.fileName ? 'uploaded' : 'pasted'),
    fileName: String(input.fileName || ''),
    text,
    inferredRole: inferTargetRoleFromText(text),
    createdAt: now,
    updatedAt: now,
  }));
}

function deleteResumeSnapshot(snapshotId) {
  const id = String(snapshotId || '').trim();
  if (!id) throw new ApiError(400, 'Resume snapshot id is required.');
  return updateState((state) => {
    const before = (state.resumeSnapshots || []).length;
    state.resumeSnapshots = (state.resumeSnapshots || []).filter((snapshot) => snapshot.id !== id);
    return { ok: true, deleted: before - state.resumeSnapshots.length };
  });
}

function prepareDiscoveryOptions(options = {}, state = readState()) {
  const providedText = String(options.resumeText || '').trim();
  const latestSnapshot = latestResumeSnapshot(state);
  const cvText = readCareerOpsText('cv.md');
  const resumeText = providedText || latestSnapshot?.text || cvText;
  const persistResumeSnapshot = options.persistResumeSnapshot !== false && options.persistResumeSnapshot !== 'false';
  const resumeSource = providedText
    ? String(options.resumeSource || (options.resumeFileName ? 'uploaded' : 'pasted'))
    : latestSnapshot?.source || (cvText ? 'cv_md' : '');
  const resumeFileName = String(options.resumeFileName || latestSnapshot?.fileName || '');
  const resumeSnapshotId = providedText ? makeId('resume') : latestSnapshot?.id || (resumeText ? 'cv_md_current' : '');
  const inferredRole = inferTargetRoleFromText(resumeText);
  return {
    ...options,
    resumeText,
    resumeSource,
    resumeFileName,
    resumeSnapshotId,
    providedResumeText: Boolean(providedText),
    persistResumeSnapshot,
    inferredRole,
    query: String(options.query || options.searchQuery || inferredRole || '').trim(),
  };
}

function upsertResumeSnapshot(state, snapshot) {
  state.resumeSnapshots ||= [];
  const now = new Date().toISOString();
  const item = {
    id: snapshot.id || makeId('resume'),
    source: snapshot.source || 'pasted',
    fileName: snapshot.fileName || '',
    label: snapshot.fileName || (snapshot.source === 'cv_md' ? 'Career-Ops cv.md' : 'Discovery resume text'),
    text: String(snapshot.text || '').slice(0, 120000),
    textLength: String(snapshot.text || '').length,
    inferredRole: snapshot.inferredRole || inferTargetRoleFromText(snapshot.text),
    createdAt: snapshot.createdAt || now,
    updatedAt: snapshot.updatedAt || now,
  };
  const index = state.resumeSnapshots.findIndex((existing) => existing.id === item.id);
  if (index >= 0) state.resumeSnapshots[index] = { ...state.resumeSnapshots[index], ...item };
  else state.resumeSnapshots.unshift(item);
  state.resumeSnapshots = state.resumeSnapshots.slice(0, 5);
  return item;
}

function latestResumeSnapshot(state = {}) {
  return [...(state.resumeSnapshots || [])]
    .filter((snapshot) => String(snapshot.text || '').trim())
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''))[0];
}

function publicResumeSnapshot(snapshot = {}) {
  return {
    id: snapshot.id || '',
    source: snapshot.source || '',
    fileName: snapshot.fileName || '',
    label: snapshot.label || snapshot.fileName || 'Discovery resume text',
    textLength: Number(snapshot.textLength || String(snapshot.text || '').length || 0),
    inferredRole: snapshot.inferredRole || '',
    createdAt: snapshot.createdAt || '',
    updatedAt: snapshot.updatedAt || '',
  };
}

function sanitizeDiscoveryRunForClient(run = {}) {
  return {
    ...run,
    criteria: sanitizeDiscoveryCriteria(run.criteria || {}),
  };
}

function sanitizeDiscoveryCriteria(criteria = {}) {
  const { resumeText, ...rest } = criteria || {};
  return {
    ...rest,
    resumeTextLength: resumeText ? String(resumeText).length : criteria.resumeTextLength || 0,
  };
}

function scrubStoredPrivateDiscoveryCriteria() {
  try {
    let changed = false;
    updateState((state) => {
      for (const run of state.discoveryRuns || []) {
        if (run.criteria?.resumeText) {
          run.criteria = sanitizeDiscoveryCriteria(run.criteria);
          changed = true;
        }
      }
      if (changed) {
        state.privacyCleanedAt = new Date().toISOString();
      }
      return changed;
    });
  } catch (error) {
    console.warn(`State privacy scrub skipped: ${error.message}`);
  }
}

function redactStateForExport(state = {}) {
  const clone = JSON.parse(JSON.stringify(state || {}));
  clone.resumeSnapshots = (clone.resumeSnapshots || []).map((snapshot) => ({
    ...publicResumeSnapshot(snapshot),
    redacted: true,
  }));
  clone.discoveryRuns = (clone.discoveryRuns || []).map(sanitizeDiscoveryRunForClient);
  clone.profilePreferences = clone.profilePreferences ? {
    ...clone.profilePreferences,
    proofBank: redactLongPrivateText(clone.profilePreferences.proofBank),
    workAuthorization: redactLongPrivateText(clone.profilePreferences.workAuthorization),
  } : clone.profilePreferences;
  for (const job of clone.jobs || []) {
    if (job.description && String(job.description).length > 1200) {
      job.description = `${String(job.description).slice(0, 1200)}... [redacted for export]`;
    }
    if (job.notes && String(job.notes).length > 500) {
      job.notes = `${String(job.notes).slice(0, 500)}... [redacted for export]`;
    }
  }
  for (const run of clone.runs || []) {
    if (run.jobDescription && String(run.jobDescription).length > 1200) {
      run.jobDescription = `${String(run.jobDescription).slice(0, 1200)}... [redacted for export]`;
    }
  }
  return clone;
}

function redactLongPrivateText(value) {
  const text = String(value || '');
  if (!text) return text;
  return text.length > 200 ? `${text.slice(0, 200)}... [redacted for export]` : text;
}

function readCareerOpsText(relativePath) {
  const target = join(CAREER_OPS_ROOT, relativePath);
  return existsSync(target) ? readFileSync(target, 'utf-8') : '';
}

function inferTargetRoleFromText(text = '') {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return '';
  const roles = [
    ['Senior Data Engineer', ['senior data engineer', 'databricks', 'pyspark', 'snowflake', 'azure data factory', 'data pipeline']],
    ['Data Engineer', ['data engineer', 'etl', 'elt', 'spark', 'sql', 'python']],
    ['Analytics Engineer', ['analytics engineer', 'dbt', 'semantic layer', 'warehouse']],
    ['Business Intelligence Engineer', ['business intelligence', 'power bi', 'tableau', 'dashboard']],
    ['Data Analyst', ['data analyst', 'reporting analyst', 'analysis']],
  ];
  const ranked = roles
    .map(([role, signals]) => ({ role, score: signals.reduce((sum, signal) => sum + (lower.includes(signal) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score ? ranked[0].role : '';
}

function runPythonJson(script, payload) {
  return new Promise((resolvePromise, rejectPromise) => {
    const python = resolvePythonExecutable();
    const child = spawn(python, ['-c', script], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => rejectPromise(new ApiError(500, `Python parser failed to start: ${error.message}`)));
    child.on('close', () => {
      try {
        resolvePromise(JSON.parse(stdout || '{}'));
      } catch {
        rejectPromise(new ApiError(500, stderr || 'Python parser returned invalid output.'));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

function resolvePythonExecutable() {
  const configured = process.env.PYTHON_PATH || process.env.PYTHON;
  if (configured && existsSync(configured)) return configured;
  const bundled = join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  if (existsSync(bundled)) return bundled;
  return 'python';
}

async function processQueue() {
  if (activeRunId || queue.length === 0) return;
  activeRunId = queue.shift();

  try {
    setRunStatus(activeRunId, 'running');
    const state = readState();
    const run = state.runs.find((item) => item.id === activeRunId);
    if (!run) return;

    const result = await runCareerOpsAnalysis({
      runId: run.id,
      jobUrl: run.jobUrl,
      jobDescription: run.jobDescription,
      generateResume: run.generateResume,
      resumeMode: run.resumeMode || 'two_page',
      generateCoverLetter: run.generateCoverLetter,
    }, (status) => setRunStatus(run.id, status));

    completeRun(run.id, result);
    if (run.saveToTracker) {
      saveApplication(run.id, true);
    }
  } catch (error) {
    failRun(activeRunId, error);
  } finally {
    activeRunId = null;
    processQueue();
  }
}

function setRunStatus(runId, status) {
  const now = new Date().toISOString();
  updateState((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) return;
    run.status = status;
    run.updatedAt = now;
    run.startedAt ||= now;
    run.logs.push({ at: now, message: `Status changed to ${status}` });
  });
}

function completeRun(runId, result) {
  const now = new Date().toISOString();
  updateState((state) => {
    const run = state.runs.find((item) => item.id === runId);
    const job = run ? state.jobs.find((item) => item.id === run.jobId) : null;
    if (!run) return;
    const normalizedResult = normalizeRunResult(result, run, job);
    run.status = 'completed';
    run.completedAt = now;
    run.updatedAt = now;
    run.result = normalizedResult;
    run.logs.push({ at: now, message: 'Career-Ops analysis completed.' });

    if (job) {
      applyNormalizedJobMetadata(job, normalizedResult, run);
      job.status = normalizedResult.resumePdfError || normalizedResult.resumeQa?.status === 'needs_review' ? 'needs_review' : 'resume_ready';
      job.score = normalizedResult.score;
      job.recommendation = normalizedResult.resumePdfError || normalizedResult.resumeQa?.status === 'needs_review' ? 'Review' : normalizedResult.recommendation;
      job.summary = normalizedResult.summary;
      job.updatedAt = now;
    }

    addDocument(state, run, 'career_ops_report', normalizedResult.reportPath);
    addDocument(state, run, 'resume_pdf', normalizedResult.resumePdfPath);
    addDocument(state, run, 'resume_html', normalizedResult.resumeHtmlPath);
    addDocument(state, run, 'resume_pdf_error', normalizedResult.resumePdfErrorLogPath);
    addDocument(state, run, 'cover_letter', normalizedResult.coverLetterPath);
  });
}

function failRun(runId, error) {
  const now = new Date().toISOString();
  const message = publicErrorMessage(error);
  updateState((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run) return;
    const job = state.jobs.find((item) => item.id === run.jobId);
    run.status = 'failed';
    run.errorMessage = message;
    run.updatedAt = now;
    run.completedAt = now;
    run.logs.push({ at: now, message });
    if (job) {
      job.status = 'failed';
      job.updatedAt = now;
      job.errorMessage = message;
    }
  });
}

function saveApplication(runId, fromWorker = false) {
  const now = new Date().toISOString();
  return updateState((state) => {
    const run = state.runs.find((item) => item.id === runId);
    if (!run || run.status !== 'completed') throw new Error('Run must be completed before saving an application.');
    const existing = state.applications.find((item) => item.runId === runId);
    if (existing) return existing;

    let tracker = null;
    try {
      tracker = appendTrackerEntry(run.result, 'Resume Ready');
    } catch (error) {
      run.logs.push({ at: now, message: `Tracker append failed: ${error.message}` });
      if (!fromWorker) throw error;
    }

    const application = {
      id: makeId('app'),
      jobId: run.jobId,
      runId,
      status: 'resume_ready',
      company: run.result.company,
      title: run.result.title,
      score: run.result.score,
      recommendation: run.result.recommendation,
      reportPath: run.result.reportPath,
      resumePdfPath: run.result.resumePdfPath,
      coverLetterPath: run.result.coverLetterPath,
      trackerNumber: tracker?.number,
      notes: run.notes || '',
      recruiterName: '',
      recruiterEmail: '',
      contactUrl: '',
      interviewStage: '',
      lastContactAt: null,
      appliedAt: null,
      nextFollowUpAt: null,
      followUpNotes: '',
      outcomeReason: '',
      createdAt: now,
      updatedAt: now,
    };
    state.applications.unshift(application);
    return application;
  });
}

function updateApplication(applicationId, patch) {
  const now = new Date().toISOString();
  return updateState((state) => {
    if (applicationId.startsWith('tracker-')) {
      state.trackerOverrides ||= {};
      const id = applicationId.replace('tracker-', '');
      const previous = state.trackerOverrides[id] || {};
      const nextStatus = patch.status || previous.status;
      state.trackerOverrides[id] = {
        ...previous,
        status: nextStatus,
        notes: patch.notes ?? previous.notes,
        recruiterName: patch.recruiterName ?? previous.recruiterName,
        recruiterEmail: patch.recruiterEmail ?? previous.recruiterEmail,
        contactUrl: patch.contactUrl ?? previous.contactUrl,
        interviewStage: patch.interviewStage ?? previous.interviewStage,
        lastContactAt: patch.lastContactAt ?? previous.lastContactAt,
        nextFollowUpAt: patch.nextFollowUpAt ?? previous.nextFollowUpAt,
        followUpNotes: patch.followUpNotes ?? previous.followUpNotes,
        outcomeReason: patch.outcomeReason ?? previous.outcomeReason,
        appliedAt: patch.appliedAt ?? previous.appliedAt ?? (nextStatus === 'applied' ? now : undefined),
        updatedAt: now,
      };
      return { id: applicationId, ...state.trackerOverrides[id] };
    }
    const application = state.applications.find((item) => item.id === applicationId);
    if (!application) throw new Error('Application not found.');
    const oldStatus = application.status;
    Object.assign(application, {
      status: patch.status || application.status,
      notes: patch.notes ?? application.notes,
      recruiterName: patch.recruiterName ?? application.recruiterName ?? '',
      recruiterEmail: patch.recruiterEmail ?? application.recruiterEmail ?? '',
      contactUrl: patch.contactUrl ?? application.contactUrl ?? '',
      interviewStage: patch.interviewStage ?? application.interviewStage ?? '',
      lastContactAt: patch.lastContactAt ?? application.lastContactAt ?? null,
      nextFollowUpAt: patch.nextFollowUpAt ?? application.nextFollowUpAt,
      followUpNotes: patch.followUpNotes ?? application.followUpNotes ?? '',
      outcomeReason: patch.outcomeReason ?? application.outcomeReason ?? '',
      appliedAt: patch.appliedAt ?? application.appliedAt ?? (patch.status === 'applied' ? now : undefined),
      updatedAt: now,
    });
    if (oldStatus !== application.status) {
      state.events.push({
        id: makeId('evt'),
        applicationId,
        type: 'status_change',
        oldStatus,
        newStatus: application.status,
        createdAt: now,
      });
    }
    return application;
  });
}

function updateJob(jobId, patch) {
  const now = new Date().toISOString();
  return updateState((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error('Job not found.');
    const nextStatus = patch.status ?? job.status;
    Object.assign(job, {
      title: patch.title ?? job.title,
      company: patch.company ?? job.company,
      resolvedTitle: patch.resolvedTitle ?? patch.title ?? job.resolvedTitle,
      resolvedCompany: patch.resolvedCompany ?? patch.company ?? job.resolvedCompany,
      location: patch.location ?? job.location,
      status: nextStatus,
      notes: patch.notes ?? job.notes,
      matchBucket: patch.matchBucket ?? (nextStatus === 'skipped' || nextStatus === 'rejected' ? 'skipped' : job.matchBucket),
      skipReason: patch.skipReason ?? job.skipReason,
      hidden: patch.hidden === undefined ? job.hidden : Boolean(patch.hidden),
      hiddenReason: patch.hiddenReason ?? job.hiddenReason,
      hiddenAt: patch.hidden ? now : job.hiddenAt,
      updatedAt: now,
    });
    return job;
  });
}

function updateJobFeedback(jobId, input = {}) {
  const now = new Date().toISOString();
  const action = String(input.action || '').trim();
  if (!action) throw new ApiError(400, 'Feedback action is required.');
  return updateState((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) throw new ApiError(404, 'Job not found.');
    job.userFeedback ||= {};
    job.userFeedback[action] = {
      at: now,
      reason: String(input.reason || ''),
    };
    job.updatedAt = now;

    if (action === 'save') {
      job.status = 'saved';
      job.userFeedback.saved = true;
    } else if (action === 'interested') {
      job.status = 'interested';
      job.userFeedback.interested = true;
      job.matchBucket = job.matchBucket === 'skipped' ? 'maybe' : job.matchBucket;
    } else if (action === 'hide_company') {
      const company = chooseDisplayCompany(job.resolvedCompany, job.company, '');
      hideJobRecord(state, job, `Company hidden by user: ${company || 'unknown company'}`, now);
      if (company) {
        state.profilePreferences = defaultProfilePreferences({
          ...state.profilePreferences,
          companiesToAvoid: appendPreferenceTerm(state.profilePreferences?.companiesToAvoid, company),
        });
      }
    } else if (action === 'hide_similar_title') {
      const titleKeyword = titlePreferenceKeyword(job.resolvedTitle || job.title || '');
      hideJobRecord(state, job, `Similar title hidden by user: ${titleKeyword || 'title keyword'}`, now);
      if (titleKeyword) {
        state.profilePreferences = defaultProfilePreferences({
          ...state.profilePreferences,
          excludedKeywords: appendPreferenceTerm(state.profilePreferences?.excludedKeywords, titleKeyword),
        });
      }
    } else if (action === 'archive') {
      hideJobRecord(state, job, String(input.reason || 'Archived by user.'), now);
    } else {
      throw new ApiError(400, 'Unsupported feedback action.');
    }
    return job;
  });
}

function appendPreferenceTerm(existing, term) {
  const terms = String(existing || '')
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const normalized = new Set(terms.map((item) => item.toLowerCase()));
  if (term && !normalized.has(String(term).toLowerCase())) terms.push(term);
  return terms.slice(0, 60).join(', ');
}

function titlePreferenceKeyword(title) {
  const text = cleanDisplayText(title).toLowerCase();
  if (!text) return '';
  if (text.includes('frontend') || text.includes('front end')) return 'frontend';
  if (text.includes('ios')) return 'iOS';
  if (text.includes('mobile')) return 'mobile';
  if (text.includes('copywriter')) return 'copywriter';
  if (text.includes('sales')) return 'sales';
  if (text.includes('product manager')) return 'product manager';
  return cleanDisplayText(title).split(/\s+/).slice(0, 3).join(' ');
}

function updateJobSource(sourceId, patch) {
  const now = new Date().toISOString();
  return updateState((state) => {
    const sources = defaultJobSources(state.jobSources);
    const source = sources.find((item) => item.id === sourceId);
    if (!source) throw new ApiError(404, 'Job source not found.');
    if (source.id === 'adzuna' && patch.enabled && (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY)) {
      throw new ApiError(400, 'Add ADZUNA_APP_ID and ADZUNA_APP_KEY to .env before enabling Adzuna.');
    }
    Object.assign(source, {
      enabled: patch.enabled === undefined ? source.enabled : Boolean(patch.enabled),
      userEnabled: source.id === 'remotive' && patch.enabled !== undefined ? Boolean(patch.enabled) : source.userEnabled,
      limit: Number.isFinite(Number(patch.limit)) ? Math.max(1, Math.min(100, Number(patch.limit))) : source.limit,
      maxPages: Number.isFinite(Number(patch.maxPages)) ? Math.max(1, Math.min(30, Number(patch.maxPages))) : source.maxPages,
      timeoutMs: Number.isFinite(Number(patch.timeoutMs)) ? Math.max(5000, Math.min(300000, Number(patch.timeoutMs))) : source.timeoutMs,
      query: patch.query === undefined ? source.query : String(patch.query || ''),
      seedUrls: patch.seedUrls === undefined ? source.seedUrls : sanitizeSeedUrls(patch.seedUrls),
      notes: patch.notes === undefined ? source.notes : String(patch.notes || ''),
      updatedAt: now,
    });
    state.jobSources = sources;
    return source;
  });
}

function sanitizeSeedUrls(value) {
  return String(value || '')
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 30)
    .join('\n');
}

function deleteJob(jobId) {
  updateState((state) => {
    const job = state.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error('Job not found.');
    const now = new Date().toISOString();
    hideJobRecord(state, job, 'Hidden from active views by user.');
    state.applications = state.applications.map((app) => (
      app.jobId === jobId ? { ...app, hidden: true, hiddenAt: now, hiddenReason: 'Parent job hidden.' } : app
    ));
  });
}

function hideDocument(filePath) {
  const normalized = normalizeRelPath(filePath);
  if (!normalized) throw new Error('Document path is required.');
  if (!isAllowedArtifactPath(normalized)) throw new Error('Only Career-Ops report/output documents can be hidden.');
  updateState((state) => {
    state.hiddenDocuments ||= [];
    if (!state.hiddenDocuments.includes(normalized)) state.hiddenDocuments.push(normalized);
    state.documents = state.documents.filter((doc) => normalizeRelPath(doc.filePath) !== normalized);
  });
}

function importStateBackup(body = {}) {
  const candidate = body.state && typeof body.state === 'object' ? body.state : body;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ApiError(400, 'Import file must contain a JSON state object.');
  }
  if (!Array.isArray(candidate.jobs) || !Array.isArray(candidate.runs)) {
    throw new ApiError(400, 'Import file does not look like an EaZy Job Apply state backup.');
  }
  const before = readState();
  const importedAt = new Date().toISOString();
  const nextState = {
    ...candidate,
    schemaVersion: Math.max(2, Number(candidate.schemaVersion || 2)),
    importedAt,
    importHistory: [
      ...(Array.isArray(before.importHistory) ? before.importHistory : []).slice(0, 10),
      {
        importedAt,
        previousCounts: stateCounts(before),
        importedCounts: stateCounts(candidate),
      },
    ],
  };
  writeState(nextState);
  return { ok: true, importedAt, counts: stateCounts(nextState) };
}

function stateCounts(state = {}) {
  return {
    jobs: Array.isArray(state.jobs) ? state.jobs.length : 0,
    runs: Array.isArray(state.runs) ? state.runs.length : 0,
    applications: Array.isArray(state.applications) ? state.applications.length : 0,
    documents: Array.isArray(state.documents) ? state.documents.length : 0,
    discoveryRuns: Array.isArray(state.discoveryRuns) ? state.discoveryRuns.length : 0,
    resumeSnapshots: Array.isArray(state.resumeSnapshots) ? state.resumeSnapshots.length : 0,
  };
}

function addDocument(state, run, type, filePath) {
  if (!filePath) return;
  const normalized = normalizeRelPath(filePath);
  if (state.documents.some((doc) => normalizeRelPath(doc.filePath) === normalized && doc.runId === run.id)) return;
  const job = state.jobs?.find((item) => item.id === run.jobId);
  state.documents.unshift({
    id: makeId('doc'),
    jobId: run.jobId,
    runId: run.id,
    type,
    filePath: normalized,
    fileName: normalized.split(/[\\/]/).pop(),
    displayName: documentDisplayName(type, job, run, normalized),
    company: job?.company || run.result?.company || '',
    title: job?.title || run.result?.title || '',
    resumeMode: run.result?.resumeMode || run.resumeMode || '',
    qaStatus: run.result?.resumeQa?.status || '',
    qaScore: Number.isFinite(Number(run.result?.resumeQa?.score)) ? Number(run.result.resumeQa.score) : null,
    createdAt: new Date().toISOString(),
  });
}

async function getHealth() {
  const required = ['cv.md', 'config/profile.yml', 'modes/_profile.md', 'portals.yml'];
  const state = readState();
  const providers = await providerHealth();
  return {
    ok: required.every((file) => existsSync(join(CAREER_OPS_ROOT, file))),
    appRoot: DEBUG_LOCAL_PATHS ? APP_ROOT : 'local app root',
    careerOpsRoot: DEBUG_LOCAL_PATHS ? CAREER_OPS_ROOT : 'local Career-Ops root',
    node: process.version,
    schemaVersion: state.schemaVersion || 2,
    resumeSnapshots: (state.resumeSnapshots || []).length,
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
    geminiModel: process.env.GEMINI_MODEL,
    localCaches: {
      jobDescriptions: safeCountFiles(join(APP_ROOT, 'data', 'cache', 'job-descriptions')),
      geminiEvaluations: safeCountFiles(join(APP_ROOT, 'data', 'cache', 'gemini-evaluations')),
      note: 'Private local cache used to reduce repeated fetches and Gemini token usage.',
    },
    providers,
    required: required.map((file) => ({ file, exists: existsSync(join(CAREER_OPS_ROOT, file)) })),
  };
}

function safeCountFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

async function providerHealth() {
  const python = process.env.SCRAPEGRAPH_PYTHON || 'python';
  const pythonVersion = spawnSync(python, ['--version'], { encoding: 'utf-8', windowsHide: true });
  const pythonOk = pythonVersion.status === 0;
  const scrapegraph = pythonOk
    ? spawnSync(python, ['-c', 'import importlib.util; print("ready" if importlib.util.find_spec("scrapegraphai") else "missing")'], { encoding: 'utf-8', windowsHide: true })
    : null;
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  const ollama = await checkOllama(ollamaBaseUrl);
  return {
    scrapegraphLocal: {
      configured: true,
      enabled: defaultJobSources(readState().jobSources).some((source) => source.id === 'scrapegraph_local' && source.enabled),
      pythonOk,
      python: pythonOk ? String(pythonVersion.stdout || pythonVersion.stderr || '').trim() : 'not found',
      scrapegraphInstalled: scrapegraph ? /ready/.test(scrapegraph.stdout || '') : false,
      ollamaReachable: ollama.reachable,
      ollamaModel: process.env.SCRAPEGRAPH_LLM || process.env.OLLAMA_MODEL || 'ollama/llama3.2:1b',
      ollamaBaseUrl,
      message: scrapegraphLocalHealthMessage(pythonOk, scrapegraph, ollama),
    },
    scrapegraphCloud: {
      configured: Boolean(process.env.SCRAPEGRAPH_API_KEY),
      enabled: defaultJobSources(readState().jobSources).some((source) => source.id === 'scrapegraph_cloud' && source.enabled),
      privacy: 'Job/career page URL only. Resume/profile data is never sent.',
      message: process.env.SCRAPEGRAPH_API_KEY ? 'ScrapeGraph Cloud API key configured.' : 'ScrapeGraph Cloud API key not configured.',
    },
  };
}

async function checkOllama(baseUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const res = await fetch(new URL('/api/tags', baseUrl), { signal: controller.signal });
    return { reachable: res.ok };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}

function scrapegraphLocalHealthMessage(pythonOk, scrapegraph, ollama) {
  if (!pythonOk) return 'Python was not found. Local AI Scraper can stay off.';
  if (!scrapegraph || !/ready/.test(scrapegraph.stdout || '')) return 'Python is ready, but scrapegraphai is not installed.';
  if (!ollama.reachable) return 'ScrapeGraphAI is installed, but Ollama is not reachable.';
  return 'Local AI Scraper dependencies look ready.';
}

function getProfile() {
  const profilePath = join(CAREER_OPS_ROOT, 'config', 'profile.yml');
  const cvPath = join(CAREER_OPS_ROOT, 'cv.md');
  const digestPath = join(CAREER_OPS_ROOT, 'article-digest.md');
  const cvText = existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '';
  const digestText = existsSync(digestPath) ? readFileSync(digestPath, 'utf-8') : '';
  const state = readState();
  const latest = latestResumeSnapshot(state);
  return {
    profilePath: 'config/profile.yml',
    cvPath: 'cv.md',
    articleDigestPath: 'article-digest.md',
    articleDigestExists: existsSync(digestPath),
    articleDigestPreview: digestText.slice(0, 3000),
    profileText: existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '',
    cvPreview: cvText.slice(0, 3000),
    cvText,
    discoveryResumeSource: latest ? publicResumeSnapshot(latest) : {
      id: 'cv_md_current',
      source: 'cv_md',
      label: 'Career-Ops cv.md',
      textLength: cvText.length,
      inferredRole: inferTargetRoleFromText(cvText),
    },
    resumeSnapshots: (state.resumeSnapshots || []).map(publicResumeSnapshot),
    profilePreferences: defaultProfilePreferences(state.profilePreferences),
  };
}

function updateProfilePreferences(input) {
  const profile = defaultProfilePreferences(input);
  return updateState((state) => {
    state.profilePreferences = profile;
    return state.profilePreferences;
  });
}

function defaultProfilePreferences(input = {}) {
  return {
    currentRole: String(input.currentRole || ''),
    yearsOfExperience: String(input.yearsOfExperience || ''),
    targetRoles: String(input.targetRoles || ''),
    targetLocations: String(input.targetLocations || ''),
    remotePreference: String(input.remotePreference || 'Remote'),
    salaryExpectation: String(input.salaryExpectation || ''),
    workAuthorization: String(input.workAuthorization || ''),
    preferredSkills: String(input.preferredSkills || ''),
    excludedKeywords: String(input.excludedKeywords || ''),
    companiesToWatch: String(input.companiesToWatch || ''),
    companiesToAvoid: String(input.companiesToAvoid || ''),
    preferredIndustries: String(input.preferredIndustries || ''),
    proofBank: String(input.proofBank || ''),
    defaultDiscoveryQuery: String(input.defaultDiscoveryQuery || ''),
    defaultDiscoveryLocation: String(input.defaultDiscoveryLocation || ''),
    defaultDiscoverySourceScope: String(input.defaultDiscoverySourceScope || 'balanced'),
    defaultDiscoveryMinScore: String(input.defaultDiscoveryMinScore || '80'),
    persistDiscoveryResumeSnapshots: String(input.persistDiscoveryResumeSnapshots ?? 'true'),
    dailyDiscoveryEnabled: String(input.dailyDiscoveryEnabled || 'false'),
  };
}

function normalizeResumeMode(value) {
  return value === 'one_page' ? 'one_page' : 'two_page';
}

function visibleJobsPayload(state) {
  const hiddenJobIds = hiddenJobIdSet(state);
  const hiddenRunIds = hiddenRunIdSet(state);
  const jobs = state.jobs
    .filter((job) => !hiddenJobIds.has(job.id))
    .map(sanitizeJobForClient);
  const visibleJobIds = new Set(jobs.map((job) => job.id));
  const runs = state.runs
    .filter((run) => !hiddenRunIds.has(run.id) && (!run.jobId || visibleJobIds.has(run.jobId)))
    .map((run) => ({
      ...run,
      result: run.result ? sanitizeRunResultForClient(run.result) : run.result,
    }));
  return { jobs, runs };
}

function hiddenJobIdSet(state = {}) {
  return new Set([
    ...(state.hiddenJobs || []).map((item) => typeof item === 'string' ? item : item.id),
    ...(state.jobs || []).filter((job) => job.hidden).map((job) => job.id),
  ].filter(Boolean));
}

function hiddenRunIdSet(state = {}) {
  return new Set([
    ...(state.hiddenRuns || []).map((item) => typeof item === 'string' ? item : item.id),
    ...(state.runs || []).filter((run) => run.hidden).map((run) => run.id),
  ].filter(Boolean));
}

function visibleApplications(state) {
  const hiddenJobIds = hiddenJobIdSet(state);
  const hiddenRunIds = hiddenRunIdSet(state);
  return (state.applications || [])
    .filter((app) => !app.hidden)
    .filter((app) => !app.jobId || !hiddenJobIds.has(app.jobId))
    .filter((app) => !app.runId || !hiddenRunIds.has(app.runId))
    .map((app) => sanitizeApplication(app, state));
}

function sanitizeApplication(app, state) {
  const job = state.jobs.find((item) => item.id === app.jobId);
  const run = state.runs.find((item) => item.id === app.runId);
  const result = run?.result || {};
  const title = chooseDisplayTitle(job?.resolvedTitle, result.resolvedTitle, result.title, app.title, job?.title);
  const company = chooseDisplayCompany(job?.resolvedCompany, result.resolvedCompany, result.company, app.company, job?.company);
  return {
    ...app,
    company,
    title,
    recommendation: normalizeRecommendation(app.recommendation || result.recommendation),
    notes: cleanSummaryForStorage(app.notes, {
      company,
      title,
      score: app.score || result.score,
      recommendation: app.recommendation || result.recommendation,
    }),
  };
}

function sanitizeTrackerRow(row, state) {
  const override = state.trackerOverrides?.[row.number] || {};
  const company = chooseDisplayCompany(row.company);
  const role = chooseDisplayTitle(row.role);
  return {
    ...row,
    company,
    role,
    notes: cleanSummaryForStorage(override.notes || row.notes, {
      company,
      title: role,
      score: row.score,
      recommendation: row.status,
    }),
    overrideStatus: override.status,
    overrideNotes: override.notes ? cleanDisplayText(override.notes) : override.notes,
    overrideRecruiterName: override.recruiterName,
    overrideRecruiterEmail: override.recruiterEmail,
    overrideContactUrl: override.contactUrl,
    overrideInterviewStage: override.interviewStage,
    overrideLastContactAt: override.lastContactAt,
    overrideNextFollowUpAt: override.nextFollowUpAt,
    overrideFollowUpNotes: override.followUpNotes,
    overrideOutcomeReason: override.outcomeReason,
    overrideAppliedAt: override.appliedAt,
  };
}

function normalizeRunResult(result = {}, run = {}, job = {}) {
  const urlFallback = inferMetadataFromUrl(run.jobUrl || result.applyUrl || job.applyUrl || job.jobUrl || '');
  const title = chooseDisplayTitle(result.title, job?.title, urlFallback.title);
  const company = chooseDisplayCompany(result.company, job?.company, urlFallback.company);
  const summary = cleanSummaryForStorage(result.summary, { company, title, score: result.score, recommendation: result.recommendation });
  return {
    ...result,
    company,
    title,
    resolvedCompany: company,
    resolvedTitle: title,
    metadataConfidence: metadataConfidence(result, job, urlFallback),
    sourceProvider: result.sourceProvider || inferProviderFromUrl(result.applyUrl || run.jobUrl || job.applyUrl || ''),
    atsJobId: result.atsJobId || inferAtsJobId(result.applyUrl || run.jobUrl || job.applyUrl || ''),
    recommendation: normalizeRecommendation(result.recommendation),
    summary,
    matchingSkills: cleanList(result.matchingSkills, 10),
    missingSkills: cleanList(result.missingSkills, 8),
    risks: cleanList(result.risks, 5),
    resumeQa: result.resumeQa ? normalizeResumeQa(result.resumeQa) : result.resumeQa,
  };
}

function applyNormalizedJobMetadata(job, result, run) {
  job.title = result.title || job.title;
  job.company = result.company || job.company;
  job.resolvedTitle = result.resolvedTitle || result.title || job.resolvedTitle;
  job.resolvedCompany = result.resolvedCompany || result.company || job.resolvedCompany;
  job.metadataConfidence = result.metadataConfidence || job.metadataConfidence || 'medium';
  job.sourceProvider = result.sourceProvider || job.sourceProvider || inferProviderFromUrl(run.jobUrl || job.applyUrl || '');
  job.atsJobId = result.atsJobId || job.atsJobId || inferAtsJobId(run.jobUrl || job.applyUrl || '');
  job.applyUrl = result.applyUrl || job.applyUrl;
}

function sanitizeJobForClient(job) {
  const title = chooseDisplayTitle(job.resolvedTitle, job.title, inferMetadataFromUrl(job.applyUrl || job.jobUrl).title);
  const company = chooseDisplayCompany(job.resolvedCompany, job.company, inferMetadataFromUrl(job.applyUrl || job.jobUrl).company);
  return {
    ...job,
    title,
    company,
    resolvedTitle: title,
    resolvedCompany: company,
    summary: cleanSummaryForStorage(job.summary, { company, title, score: job.score, recommendation: job.recommendation }),
  };
}

function sanitizeRunResultForClient(result = {}) {
  const title = chooseDisplayTitle(result.resolvedTitle, result.title, 'this role');
  const company = chooseDisplayCompany(result.resolvedCompany, result.company, 'the company');
  return {
    ...result,
    title,
    company,
    resolvedTitle: title,
    resolvedCompany: company,
    summary: cleanSummaryForStorage(result.summary, { company, title, score: result.score, recommendation: result.recommendation }),
    resumeQa: result.resumeQa ? normalizeResumeQa(result.resumeQa) : result.resumeQa,
  };
}

function sanitizeRunForClient(run = {}, state = {}) {
  const job = state.jobs?.find((item) => item.id === run.jobId);
  const result = run.result
    ? normalizeRunResult(sanitizeRunResultForClient(run.result), run, job)
    : run.result;
  return {
    ...run,
    result,
  };
}

function cleanStateData() {
  const now = new Date().toISOString();
  const result = { hiddenJobs: 0, hiddenRuns: 0, updatedJobs: 0, updatedDocuments: 0, duplicateJobs: 0 };
  updateState((state) => {
    const duplicateLosers = duplicateJobIds(state.jobs);
    for (const job of state.jobs) {
      const before = JSON.stringify({
        title: job.title,
        company: job.company,
        summary: job.summary,
        resolvedTitle: job.resolvedTitle,
        resolvedCompany: job.resolvedCompany,
      });
      const normalized = sanitizeJobForClient(job);
      Object.assign(job, {
        title: normalized.title,
        company: normalized.company,
        resolvedTitle: normalized.resolvedTitle,
        resolvedCompany: normalized.resolvedCompany,
        summary: normalized.summary,
        sourceProvider: job.sourceProvider || inferProviderFromUrl(job.applyUrl || job.jobUrl || ''),
        atsJobId: job.atsJobId || inferAtsJobId(job.applyUrl || job.jobUrl || ''),
      });
      if (before !== JSON.stringify({
        title: job.title,
        company: job.company,
        summary: job.summary,
        resolvedTitle: job.resolvedTitle,
        resolvedCompany: job.resolvedCompany,
      })) result.updatedJobs += 1;

      const reason = cleanupHideReason(job, duplicateLosers.has(job.id));
      if (reason && !job.hidden) {
        hideJobRecord(state, job, reason, now);
        result.hiddenJobs += 1;
        if (duplicateLosers.has(job.id)) result.duplicateJobs += 1;
      }
    }

    for (const run of state.runs) {
      const job = state.jobs.find((item) => item.id === run.jobId);
      if (job?.hidden && !run.hidden) {
        run.hidden = true;
        run.hiddenReason = `Parent job hidden: ${job.hiddenReason || 'cleanup'}`;
        run.hiddenAt = now;
        result.hiddenRuns += 1;
      }
      if (run.result) run.result = sanitizeRunResultForClient(run.result);
    }

    for (const doc of state.documents || []) {
      const job = state.jobs.find((item) => item.id === doc.jobId);
      const before = doc.displayName;
      doc.displayName = documentDisplayName(doc.type, job, state.runs.find((run) => run.id === doc.runId), doc.filePath);
      doc.company = chooseDisplayCompany(job?.resolvedCompany, doc.company, job?.company, '');
      doc.title = chooseDisplayTitle(job?.resolvedTitle, doc.title, job?.title, '');
      if (doc.displayName !== before) result.updatedDocuments += 1;
    }

    for (const app of state.applications || []) {
      if (app.hidden) continue;
      const cleanApp = sanitizeApplication(app, state);
      app.company = cleanApp.company;
      app.title = cleanApp.title;
      app.recommendation = cleanApp.recommendation;
      app.notes = cleanApp.notes;
    }
  });
  return { ok: true, ...result };
}

function duplicateJobIds(jobs = []) {
  const grouped = new Map();
  for (const job of jobs) {
    if (job.hidden) continue;
    const key = duplicateKey(job);
    if (!key) continue;
    grouped.set(key, [...(grouped.get(key) || []), job]);
  }
  const losers = new Set();
  for (const group of grouped.values()) {
    if (group.length < 2) continue;
    const sorted = [...group].sort((a, b) => jobKeepScore(b) - jobKeepScore(a));
    sorted.slice(1).forEach((job) => losers.add(job.id));
  }
  return losers;
}

function duplicateKey(job = {}) {
  const canonical = normalizeComparable(job.canonicalUrl || job.applyUrl || job.jobUrl || '');
  if (canonical) return canonical;
  const company = normalizeComparable(job.resolvedCompany || job.company || '');
  const title = normalizeComparable(job.resolvedTitle || job.title || '');
  return company && title ? `${company}:${title}` : '';
}

function jobKeepScore(job = {}) {
  const updated = Date.parse(job.updatedAt || job.lastSeenAt || job.discoveredAt || '') || 0;
  return updated
    + (job.status === 'resume_ready' ? 1_000_000_000 : 0)
    + (job.latestRunId ? 500_000_000 : 0)
    + (Number(job.score || 0) * 10_000_000);
}

function cleanupHideReason(job, isDuplicate) {
  const title = String(job.title || '');
  const company = String(job.company || '');
  const summary = String(job.summary || '');
  if (isDuplicate) return 'Duplicate job/run hidden by cleanup.';
  if (/smoke test/i.test(`${title} ${company} ${summary}`)) return 'Smoke-test data hidden by cleanup.';
  if (job.status === 'failed' && /unknown|pending/i.test(`${title} ${company}`)) return 'Stale failed run hidden by cleanup.';
  if (title.length > 120 || company.length > 80) return 'Malformed title/company metadata hidden by cleanup.';
  if (looksLikeRawReportSummary(summary) && /unknown|job opportunity|pending/i.test(`${title} ${company}`)) return 'Raw/unknown report card hidden by cleanup.';
  return '';
}

function hideJobRecord(state, job, reason, now = new Date().toISOString()) {
  job.hidden = true;
  job.hiddenReason = reason;
  job.hiddenAt = now;
  job.matchBucket = 'skipped';
  state.hiddenJobs ||= [];
  if (!state.hiddenJobs.some((item) => (typeof item === 'string' ? item : item.id) === job.id)) {
    state.hiddenJobs.push({ id: job.id, reason, hiddenAt: now });
  }
}

function documentDisplayName(type, job = {}, run = {}, filePath = '') {
  const result = run?.result || {};
  const urlFallback = inferMetadataFromUrl(job?.applyUrl || job?.jobUrl || result.applyUrl || run?.jobUrl || filePath);
  const company = chooseDisplayCompany(job?.resolvedCompany, result.resolvedCompany, result.company, job?.company, urlFallback.company);
  const title = chooseDisplayTitle(job?.resolvedTitle, result.resolvedTitle, result.title, job?.title, urlFallback.title);
  const mode = result.resumeMode || run?.resumeMode || '';
  const kind = {
    resume_pdf: mode === 'one_page' ? '1-page tailored resume' : mode === 'two_page' ? '2-page tailored resume' : 'Tailored resume',
    career_ops_report: 'Career-Ops report',
    cover_letter: 'Cover letter',
    original_resume: 'Original resume',
  }[type] || 'Document';
  const context = [company, title].filter(Boolean).join(' - ');
  const ext = String(filePath || '').split('.').pop();
  return cleanDisplayText(`${context ? `${context} - ` : ''}${kind}${ext && !kind.toLowerCase().includes(ext.toLowerCase()) ? `.${ext}` : ''}`);
}

function listExistingDocuments() {
  const docs = [];
  const cvPath = join(CAREER_OPS_ROOT, 'cv.md');
  if (existsSync(cvPath)) docs.push(toDoc('original_resume', cvPath));
  collectFiles(join(CAREER_OPS_ROOT, 'reports'), '.md').forEach((file) => docs.push(toDoc('career_ops_report', file)));
  collectFiles(join(CAREER_OPS_ROOT, 'output'), '.pdf').forEach((file) => docs.push(toDoc('resume_pdf', file)));
  collectFiles(join(CAREER_OPS_ROOT, 'output'), 'cover-letter.md').forEach((file) => docs.push(toDoc('cover_letter', file)));
  return docs.slice(0, 100);
}

function visibleDocuments(state) {
  const hidden = new Set((state.hiddenDocuments || []).map(normalizeRelPath));
  const seen = new Set();
  const hiddenJobIds = hiddenJobIdSet(state);
  return [...state.documents, ...listExistingDocuments()]
    .filter((doc) => doc?.filePath)
    .filter((doc) => !doc.jobId || !hiddenJobIds.has(doc.jobId))
    .map((doc) => {
      const filePath = normalizeRelPath(doc.filePath);
      const job = state.jobs.find((item) => item.id === doc.jobId);
      const run = state.runs.find((item) => item.id === doc.runId);
      return {
        ...doc,
        filePath,
        displayName: documentDisplayName(doc.type, job, run, filePath),
        company: chooseDisplayCompany(job?.resolvedCompany, run?.result?.resolvedCompany, run?.result?.company, doc.company, job?.company, ''),
        title: chooseDisplayTitle(job?.resolvedTitle, run?.result?.resolvedTitle, run?.result?.title, doc.title, job?.title, ''),
        qaStatus: doc.qaStatus || run?.result?.resumeQa?.status || '',
        qaScore: doc.qaScore ?? run?.result?.resumeQa?.score ?? null,
      };
    })
    .filter((doc) => {
      if (hidden.has(doc.filePath)) return false;
      const key = `${doc.type}:${doc.filePath}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function collectFiles(dir, suffix) {
  if (!existsSync(dir)) return [];
  const result = [];
  for (const entry of readdirSafe(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) result.push(...collectFiles(path, suffix));
    else if (entry.name.endsWith(suffix)) result.push(path);
  }
  return result.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
}

function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readJson(req, maxBytes = 1024 * 1024) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new ApiError(413, 'Request body is too large.');
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new ApiError(400, 'Request body must be valid JSON.');
  }
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    ...securityHeaders(),
  });
  res.end(JSON.stringify(data, null, 2));
}

function serveStatic(res, pathname) {
  const file = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = resolve(PUBLIC_DIR, file);
  if (!target.startsWith(PUBLIC_DIR) || !existsSync(target)) {
    serveStatic(res, '/');
    return;
  }
  streamFile(res, target);
}

function serveFile(res, relativePath) {
  const normalized = normalizeRelPath(relativePath);
  if (!isAllowedArtifactPath(normalized)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  const target = resolve(CAREER_OPS_ROOT, normalized);
  if (!target.startsWith(CAREER_OPS_ROOT) || !existsSync(target)) {
    res.writeHead(404);
    res.end('File not found');
    return;
  }
  streamFile(res, target);
}

function streamFile(res, target) {
  const type = contentType(target);
  const headers = { 'content-type': type, ...securityHeaders() };
  if (/\.(html|css|js)$/i.test(target)) {
    headers['cache-control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
    headers.pragma = 'no-cache';
    headers.expires = '0';
  }
  if (/\.html$/i.test(target)) {
    headers['clear-site-data'] = '"cache"';
  }
  res.writeHead(200, headers);
  createReadStream(target).pipe(res);
}

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'x-frame-options': 'SAMEORIGIN',
  };
}

function contentType(file) {
  return {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.log': 'text/plain; charset=utf-8',
    '.pdf': 'application/pdf',
  }[extname(file)] || 'application/octet-stream';
}

function toDoc(type, absolutePath) {
  const rel = normalizeRelPath(relative(CAREER_OPS_ROOT, absolutePath));
  return {
    id: `${type}_${rel}`,
    type,
    filePath: rel,
    fileName: rel.split(/[\\/]/).pop(),
    createdAt: statSync(absolutePath).mtime.toISOString(),
  };
}

function normalizeRelPath(filePath) {
  return String(filePath || '').replaceAll('\\', '/').replace(/^\/+/, '');
}

function isAllowedArtifactPath(filePath) {
  const normalized = normalizeRelPath(filePath);
  return normalized.startsWith('reports/')
    || normalized.startsWith('output/')
    || normalized.startsWith('webapp/storage/logs/')
    || normalized === 'cv.md';
}

function publicErrorMessage(error) {
  const raw = String(error?.message || error || 'Career-Ops run failed.');
  if (error?.statusCode && error.statusCode < 500) return raw;
  const lower = raw.toLowerCase();
  if (lower.includes('429') || lower.includes('quota') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return 'Gemini free-tier quota or rate limit was reached. Please wait a minute and retry. If the job description was pasted, the app can still create a local fallback report.';
  }
  if (lower.includes('api_key') || lower.includes('api key')) {
    return 'Gemini API key is missing or invalid. Check Settings/.env, then retry.';
  }
  if (lower.includes('http 403') || lower.includes('blocked automated fetching')) {
    return 'This job page blocked automated fetching (HTTP 403). Paste the job description manually, or retry with the direct ATS apply link if available.';
  }
  if (lower.includes('unsupported') || lower.includes('not supported')) {
    return 'This job source is not fully supported yet. Paste the job description manually or use the direct Greenhouse, Lever, Ashby, or Workday apply link.';
  }
  if (lower.includes('could not extract text') || lower.includes('resume file')) {
    return 'Could not parse this resume file. Use PDF, DOCX, TXT, or MD, or paste the resume text directly.';
  }
  if (lower.includes('spawn eperm') || lower.includes('uv_handle_closing')) {
    return 'The PDF/browser worker was blocked by the local environment. Restart the app with start-web.bat, then retry.';
  }
  return raw.length > 600 ? `${raw.slice(0, 600)}...` : raw;
}

function chooseDisplayTitle(...values) {
  for (const value of values) {
    const text = cleanDisplayText(value);
    if (isGoodTitle(text)) return text;
  }
  return 'Job opportunity';
}

function chooseDisplayCompany(...values) {
  for (const value of values) {
    const text = cleanDisplayText(value);
    if (isGoodCompany(text)) return text;
  }
  return 'Unknown company';
}

function isGoodTitle(value) {
  const text = cleanDisplayText(value);
  if (!text || /^(unknown|unknown role|pending analysis|this role|job opportunity|null|undefined)$/i.test(text)) return false;
  if (text.length > 120) return false;
  if (looksLikeRawReportSummary(text)) return false;
  if (/^(as|about|at)\s/i.test(text) && text.length > 70) return false;
  return /\b(engineer|analyst|architect|developer|consultant|associate|manager|lead|specialist|administrator|scientist)\b/i.test(text)
    || text.split(/\s+/).length <= 9;
}

function isGoodCompany(value) {
  const text = cleanDisplayText(value);
  if (!text || /^(unknown|unknown company|the company|manual|null|undefined)$/i.test(text)) return false;
  if (/^(jobs|careers|company)$/i.test(text)) return false;
  if (text.length > 80) return false;
  if (looksLikeRawReportSummary(text)) return false;
  if (/\b(mission is|we are|continues to grow|responsibilities include|we need|you will)\b/i.test(text)) return false;
  return true;
}

function inferMetadataFromUrl(rawUrl) {
  if (!rawUrl) return { company: '', title: '' };
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, '');
    const parts = url.pathname.split('/').filter(Boolean).map((part) => decodeURIComponent(part));
    const greenhouse = host.includes('greenhouse') ? parts[0] : '';
    const workdaySite = host.includes('workdayjobs') ? parts[0] : '';
    const company = readableCompany(greenhouse || workdaySite || host.split('.')[0]);
    const titlePart = [...parts].reverse().find((part) => /[a-z]/i.test(part) && !/^(job|jobs|careers|company|candidate|detail)$/i.test(part) && !/^\d+$/.test(part));
    return { company, title: readableTitle(titlePart || '') };
  } catch {
    return { company: '', title: '' };
  }
}

function readableCompany(value) {
  return cleanDisplayText(String(value || '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b(wd\d+|myworkdayjobs|jobs|careers)\b/gi, '')
    .replace(/\s+/g, ' '))
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function readableTitle(value) {
  return cleanDisplayText(String(value || '')
    .replace(/[_]+/g, ' ')
    .replace(/--+/g, ' - ')
    .replace(/[-]+/g, ' ')
    .replace(/\b(req|jr|jid|gh)\s*\d+\b/gi, '')
    .replace(/\b\d{4,}\b/g, '')
    .replace(/\s+/g, ' '))
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function metadataConfidence(result = {}, job = {}, fallback = {}) {
  if (isGoodCompany(result.company) && isGoodTitle(result.title)) return 'high';
  if (isGoodCompany(job?.company) && isGoodTitle(job?.title)) return 'medium';
  if (isGoodCompany(fallback.company) || isGoodTitle(fallback.title)) return 'low';
  return 'needs_review';
}

function inferProviderFromUrl(rawUrl) {
  const text = String(rawUrl || '').toLowerCase();
  if (text.includes('greenhouse')) return 'Greenhouse';
  if (text.includes('lever.co')) return 'Lever';
  if (text.includes('ashby')) return 'Ashby';
  if (text.includes('workdayjobs')) return 'Workday';
  if (text.includes('ripplehire')) return 'RippleHire';
  if (text.includes('smartrecruiters')) return 'SmartRecruiters';
  if (text.includes('icims')) return 'iCIMS';
  return '';
}

function inferAtsJobId(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    return url.pathname.match(/\/jobs\/(\d+)/i)?.[1]
      || url.searchParams.get('gh_jid')
      || url.pathname.match(/_([A-Z]{2,}-?\d+)$/i)?.[1]
      || url.pathname.match(/\/job\/[^/]+\/([^/?#]+)/i)?.[1]
      || url.hash.match(/\/job\/(\d+)/i)?.[1]
      || '';
  } catch {
    return '';
  }
}

function cleanSummaryForStorage(summary, context = {}) {
  const cleanSummary = cleanDisplayText(summary || '');
  if (cleanSummary && !looksLikeRawReportSummary(cleanSummary) && cleanSummary.length <= 450) return cleanSummary;
  const company = chooseDisplayCompany(context.company, 'the company');
  const title = chooseDisplayTitle(context.title, 'this role');
  const score = Number(context.score);
  const scoreText = Number.isFinite(score) && score > 0 ? ` Score: ${score}/5.` : '';
  return `Career-Ops completed the evaluation for ${title} at ${company}.${scoreText} Recommendation: ${normalizeRecommendation(context.recommendation)}. Review the report, resume PDF, QA checks, and apply link before applying.`;
}

function looksLikeRawReportSummary(value) {
  const text = cleanDisplayText(value).toLowerCase();
  return text.includes('archetype detected')
    || text.includes('career-ops evaluation')
    || text.includes('tool: gemini')
    || text.includes('legitimacy:')
    || text.includes('pdf: pending')
    || text.includes('evaluada')
    || text.includes('dimensi')
    || text.includes('arquetipo')
    || /date:\s*\d{8}/i.test(text)
    || /score:\s*\?\/5/i.test(text)
    || /[ÃÂâ�]/.test(value);
}

function normalizeRecommendation(value) {
  const text = cleanDisplayText(value || '');
  if (/^apply$/i.test(text)) return 'Apply';
  if (/^(maybe|review)$/i.test(text)) return 'Review';
  if (/^skip$/i.test(text)) return 'Skip';
  return 'Review';
}

function normalizeResumeQa(qa = {}) {
  const missingTerms = cleanList(qa.missingTerms, 12);
  const matchedTerms = cleanList(qa.matchedTerms, 16);
  const usedDigestBullets = cleanList(qa.usedDigestBullets, 8);
  const suspicious = cleanList(qa.suspiciousPhrases, 8);
  const repeated = cleanList(qa.repeatedMetrics, 8);
  const unsupported = cleanList(qa.unsupportedClaims, 8);
  let score = Number(qa.score || 0);
  if (missingTerms.length >= 5) score = Math.min(score, 69);
  if (suspicious.length || repeated.length || unsupported.length) score = Math.min(score, 74);
  const status = score >= 80 && missingTerms.length <= 3 && !suspicious.length && !unsupported.length
    ? 'strong_match'
    : score >= 65 ? 'review_recommended' : 'needs_review';
  return {
    ...qa,
    score,
    status,
    matchedTerms,
    missingTerms,
    usedDigestBullets,
    articleDigestUsed: Boolean(qa.articleDigestUsed || usedDigestBullets.length),
    articleDigestBulletCount: Number(qa.articleDigestBulletCount || usedDigestBullets.length || 0),
    suspiciousPhrases: suspicious,
    repeatedMetrics: repeated,
    unsupportedClaims: unsupported,
    checks: cleanList(qa.checks, 12),
    summary: cleanSummarySentence(qa.summary),
  };
}

function cleanList(items = [], limit = 10) {
  return [...new Set((items || []).map(cleanDisplayText).filter(Boolean).filter((item) => !looksLikeRawReportSummary(item)))].slice(0, limit);
}

function cleanSummarySentence(value) {
  const text = cleanDisplayText(value || '');
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function normalizeComparable(value) {
  return cleanDisplayText(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function cleanDisplayText(value) {
  return String(value ?? '')
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

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const text = readFileSync(filePath, 'utf-8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, '');
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
