#!/usr/bin/env node
import { appendFileSync, createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { appendTrackerEntry, parseApplicationsTracker } from './lib/tracker.mjs';
import { makeId, readState, updateState, writeState } from './lib/store.mjs';
import { runResumeWorkspaceAnalysis } from './lib/resumeWorkspaceAdapter.mjs';
import { validateJobUrl } from './lib/urlSafety.mjs';

const APP_ROOT = process.cwd();
loadEnvFile(join(APP_ROOT, '.env'));
const RESUME_WORKSPACE_ROOT = resolve(process.env.RESUME_WORKSPACE_PATH || process.env.CAREER_OPS_PATH || join(APP_ROOT, '..', 'Resume-Workspace'));
const RESUME_WORKSPACE_PROFILES_ROOT = join(RESUME_WORKSPACE_ROOT, 'profiles');
const PUBLIC_DIR = join(APP_ROOT, 'public');
const PORT = Number(process.env.PORT || 3025);
const HOST = process.env.HOST || '127.0.0.1';
const DEBUG_LOCAL_PATHS = process.env.DEBUG_LOCAL_PATHS === '1';
const queue = [];
let activeRunId = null;

const RESUME_PROFILE_DEFINITIONS = [
  {
    id: 'resume-1',
    label: 'Resume 1',
    roleFamily: 'Primary Resume',
    ownerName: 'Candidate',
    sourceDir: 'profiles/resume-1',
    articleDigestPath: 'article-digest.md',
    useProfileArticleDigest: true,
    isDefault: true,
  },
  {
    id: 'resume-2',
    label: 'Resume 2',
    roleFamily: 'Resume Variant',
    ownerName: 'Candidate',
    sourceDir: 'profiles/resume-2',
    articleDigestPath: 'article-digest.md',
    useProfileArticleDigest: true,
  },
  {
    id: 'resume-3',
    label: 'Resume 3',
    roleFamily: 'Resume Variant',
    ownerName: 'Candidate',
    sourceDir: 'profiles/resume-3',
    articleDigestPath: 'article-digest.md',
    useProfileArticleDigest: true,
  },
  {
    id: 'resume-4',
    label: 'Resume 4',
    roleFamily: 'Resume Variant',
    ownerName: 'Candidate',
    sourceDir: 'profiles/resume-4',
    articleDigestPath: 'article-digest.md',
    useProfileArticleDigest: true,
  },
  {
    id: 'resume-5',
    label: 'Resume 5',
    roleFamily: 'Resume Variant',
    ownerName: 'Candidate',
    sourceDir: 'profiles/resume-5',
    articleDigestPath: 'article-digest.md',
    useProfileArticleDigest: true,
  },
  {
    id: 'resume-6',
    label: 'Resume 6',
    roleFamily: 'Resume Variant',
    ownerName: 'Candidate',
    sourceDir: 'profiles/resume-6',
    articleDigestPath: 'article-digest.md',
    useProfileArticleDigest: true,
  },
];

loadEnvFile(join(RESUME_WORKSPACE_ROOT, '.env'));
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
  console.log(`Personal Resume Helper Web App running at http://${HOST}:${PORT}`);
});

scrubStoredPrivateDiscoveryCriteria();

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
    sendJson(res, 200, getProfile(url.searchParams.get('resumeProfileId') || ''));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/resume-profiles') {
    sendJson(res, 200, getResumeProfilesPayload(url.searchParams.get('resumeProfileId') || ''));
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
  if (req.method === 'GET' && url.pathname === '/api/scanner/inbox') {
    sendJson(res, 200, getScannerInbox());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/scanner/run-api') {
    const body = await readJson(req).catch(() => ({}));
    const dryRun = ['1', 'true', 'yes'].includes(String(url.searchParams.get('dryRun') || body.dryRun || '').toLowerCase());
    sendJson(res, 200, await runResumeWorkspaceApiScanner({ dryRun }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/scanner/archive') {
    const body = await readJson(req);
    sendJson(res, 200, hideScannerInboxRow(body));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/job-sources') {
    sendDiscoveryDisabled(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/source-library') {
    sendDiscoveryDisabled(res);
    return;
  }

  const sourceMatch = url.pathname.match(/^\/api\/job-sources\/([^/]+)$/);
  if (sourceMatch && req.method === 'PATCH') {
    sendDiscoveryDisabled(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/discovery/runs') {
    sendDiscoveryDisabled(res);
    return;
  }

  const discoveryRunMatch = url.pathname.match(/^\/api\/discovery\/runs\/([^/]+)$/);
  if (req.method === 'GET' && discoveryRunMatch) {
    sendDiscoveryDisabled(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/discovery/run-now') {
    sendDiscoveryDisabled(res);
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
      app: 'Personal Resume Helper',
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
    const body = await readJson(req, 10 * 1024 * 1024);
    const response = createAnalysisRun(body);
    sendJson(res, 202, response);
    return;
  }

  const analyzeExistingMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/analyze$/);
  if (analyzeExistingMatch && req.method === 'POST') {
    const body = await readJson(req, 10 * 1024 * 1024);
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
  if (req.method === 'PATCH' && docMatch) {
    const decoded = decodeURIComponent(docMatch[1]);
    const body = await readJson(req);
    const document = updateDocumentLabel(decoded, body.label);
    sendJson(res, 200, { document });
    return;
  }
  if (req.method === 'DELETE' && docMatch) {
    const decoded = decodeURIComponent(docMatch[1]);
    hideDocument(decoded);
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { error: 'Not found' });
}

function sendDiscoveryDisabled(res) {
  sendJson(res, 410, {
    error: 'Discovery Jobs is disabled from the active app. Use Add Job with a job link or pasted JD.',
    disabled: true,
  });
}

function getResumeProfilesPayload(selectedId = '') {
  const state = readState();
  const profiles = buildResumeProfiles(state, { includeText: false });
  const defaultResumeProfileId = state.defaultResumeProfileId || defaultResumeProfileIdFromDefinitions();
  const activeResumeProfile = profiles.find((profile) => profile.id === (selectedId || defaultResumeProfileId))
    || profiles.find((profile) => profile.id === defaultResumeProfileId)
    || profiles[0]
    || null;
  return {
    resumeProfiles: profiles,
    defaultResumeProfileId,
    activeResumeProfile,
  };
}

function buildResumeProfiles(state = readState(), options = {}) {
  const overrides = new Map((state.resumeProfiles || []).map((profile) => [profile.id, profile]));
  return RESUME_PROFILE_DEFINITIONS.map((definition) => {
    const override = overrides.get(definition.id) || {};
    return buildResumeProfile({
      ...definition,
      ...override,
      isDefault: definition.isDefault || override.isDefault,
      isEnabled: definition.isEnabled === false ? false : override.isEnabled !== false,
    }, options);
  });
}

function buildResumeProfile(profile, options = {}) {
  const sourceDir = profile.sourceDir || `profiles/${profile.id}`;
  const dir = safeResumeWorkspaceProfilePath(sourceDir);
  const cvPath = safeResumeWorkspaceProfilePath(join(sourceDir, profile.cvPath || 'cv.md'));
  const profileYmlPath = safeResumeWorkspaceProfilePath(join(sourceDir, profile.profileYmlPath || 'profile.yml'));
  const storyBankPath = safeResumeWorkspaceProfilePath(join(sourceDir, profile.storyBankPath || 'story-bank.md'));
  const rootFallbackCvPath = join(RESUME_WORKSPACE_ROOT, 'cv.md');
  const sharedArticleDigestPath = join(RESUME_WORKSPACE_ROOT, 'article-digest.md');
  const rootFallbackProfileYmlPath = join(RESUME_WORKSPACE_ROOT, 'config', 'profile.yml');
  const rootFallbackStoryBankPath = join(RESUME_WORKSPACE_ROOT, 'interview-prep', 'story-bank.md');
  const useRootFallback = profile.id === defaultResumeProfileIdFromDefinitions() && !existsSync(cvPath) && existsSync(rootFallbackCvPath);
  const effectiveCvPath = useRootFallback ? rootFallbackCvPath : cvPath;
  const profileDigestPath = profileArticleDigestPath(profile, sourceDir);
  const effectiveDigestPath = profileDigestPath || sharedArticleDigestPath;
  const effectiveProfileYmlPath = existsSync(profileYmlPath) ? profileYmlPath : (useRootFallback ? rootFallbackProfileYmlPath : profileYmlPath);
  const effectiveStoryBankPath = existsSync(storyBankPath) ? storyBankPath : (useRootFallback ? rootFallbackStoryBankPath : storyBankPath);
  const cvText = options.includeText && existsSync(effectiveCvPath) ? readFileSync(effectiveCvPath, 'utf-8') : '';
  const articleDigestText = options.includeText && existsSync(effectiveDigestPath) ? readFileSync(effectiveDigestPath, 'utf-8') : '';
  const profileYmlText = options.includeText && existsSync(effectiveProfileYmlPath) ? readFileSync(effectiveProfileYmlPath, 'utf-8') : '';
  const storyBankText = options.includeText && existsSync(effectiveStoryBankPath) ? readFileSync(effectiveStoryBankPath, 'utf-8') : '';
  const cvExists = existsSync(effectiveCvPath);
  const explicitlyEnabled = profile.isEnabled !== false && !profile.archived;
  const sourceStatus = !explicitlyEnabled
    ? 'disabled'
    : cvExists ? 'ready' : 'missing_cv';
  return {
    id: profile.id,
    label: profile.label,
    roleFamily: profile.roleFamily || '',
    ownerName: profile.ownerName || '',
    sourceDir,
    cvPath: relative(RESUME_WORKSPACE_ROOT, effectiveCvPath).replace(/\\/g, '/'),
    articleDigestPath: relative(RESUME_WORKSPACE_ROOT, effectiveDigestPath).replace(/\\/g, '/'),
    profileYmlPath: relative(RESUME_WORKSPACE_ROOT, effectiveProfileYmlPath).replace(/\\/g, '/'),
    storyBankPath: relative(RESUME_WORKSPACE_ROOT, effectiveStoryBankPath).replace(/\\/g, '/'),
    isDefault: Boolean(profile.isDefault),
    isEnabled: explicitlyEnabled && cvExists,
    archived: Boolean(profile.archived),
    sourceStatus,
    sourceHealth: {
      cvLoaded: cvExists,
      articleDigestLoaded: existsSync(effectiveDigestPath),
      profileLoaded: existsSync(effectiveProfileYmlPath),
      storyBankLoaded: existsSync(effectiveStoryBankPath),
      usingRootFallback: useRootFallback,
      usingSharedArticleDigest: effectiveDigestPath === sharedArticleDigestPath,
    },
    cvLength: cvExists ? safeFileSize(effectiveCvPath) : 0,
    articleDigestLength: existsSync(effectiveDigestPath) ? safeFileSize(effectiveDigestPath) : 0,
    cvText,
    articleDigestText,
    profileYmlText,
    storyBankText,
  };
}

function profileArticleDigestPath(profile, sourceDir) {
  const digestPath = String(profile.articleDigestPath || '').trim();
  const explicitlyProfileScoped = profile.useProfileArticleDigest === true
    || (digestPath && digestPath !== 'article-digest.md');
  if (!explicitlyProfileScoped) return '';
  return safeResumeWorkspaceProfilePath(join(sourceDir, digestPath || 'article-digest.md'));
}

function resolveResumeProfile(profileId = '', options = {}) {
  const state = readState();
  const profiles = buildResumeProfiles(state, { includeText: true });
  const requestedId = String(profileId || state.defaultResumeProfileId || defaultResumeProfileIdFromDefinitions()).trim();
  const profile = profiles.find((item) => item.id === requestedId)
    || profiles.find((item) => item.id === state.defaultResumeProfileId)
    || profiles.find((item) => item.id === defaultResumeProfileIdFromDefinitions())
    || profiles[0];
  if (!profile) throw new ApiError(400, 'No resume profiles are configured.');
  if (options.requireCv && !profile.isEnabled) {
    const hint = profile.sourceStatus === 'missing_cv'
      ? `Add cv.md to ${profile.sourceDir} to enable this resume profile.`
      : 'Choose an enabled resume profile before generating a resume.';
    throw new ApiError(400, `Resume profile unavailable: ${profile.label}. ${hint}`);
  }
  return profile;
}

function defaultResumeProfileIdFromDefinitions() {
  return RESUME_PROFILE_DEFINITIONS.find((profile) => profile.isDefault)?.id || RESUME_PROFILE_DEFINITIONS[0]?.id || '';
}

function safeResumeWorkspaceProfilePath(relativePath = '') {
  const target = resolve(RESUME_WORKSPACE_ROOT, relativePath);
  const rel = relative(RESUME_WORKSPACE_PROFILES_ROOT, target);
  if (rel.startsWith('..') || rel === '' || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\')) {
    throw new ApiError(400, 'Resume profile paths must stay inside Resume-Workspace/profiles.');
  }
  return target;
}

function safeFileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

function createAnalysisRun(input) {
  const jobUrl = String(input.jobUrl || '').trim();
  const jobDescription = String(input.jobDescription || '').trim();
  if (!jobUrl && !jobDescription) throw new ApiError(400, 'Provide a job URL or paste a job description.');

  const urlCheck = validateJobUrl(jobUrl);
  if (!urlCheck.ok) throw new ApiError(400, urlCheck.error);

  const now = new Date().toISOString();
  const runId = makeId('run');
  const resumeMode = normalizeResumeMode(input.resumeMode);
  const resumeProfile = resolveResumeProfile(input.resumeProfileId, { requireCv: input.generateResume !== false });
  const analysisKey = buildAnalysisKey(urlCheck.url, jobDescription);
  let response;

  updateState((state) => {
    let job = findExistingJobForAnalysis(state, analysisKey);
    if (!job) {
      job = {
        id: makeId('job'),
        title: 'Pending analysis',
        company: 'Unknown company',
        location: '',
        jobUrl: urlCheck.url,
        applyUrl: urlCheck.url,
        source: urlCheck.url ? new URL(urlCheck.url).hostname : 'manual',
        description: jobDescription,
        discoveredAt: now,
        analysisKey,
      };
      state.jobs.unshift(job);
    } else {
      job.jobUrl = urlCheck.url || job.jobUrl;
      job.applyUrl = urlCheck.url || job.applyUrl;
      job.description = jobDescription || job.description;
      job.notes = String(input.notes || job.notes || '');
      job.analysisKey = analysisKey;
      job.hidden = false;
      job.hiddenReason = '';
      job.hiddenAt = '';
      state.hiddenJobs = (state.hiddenJobs || []).filter((item) => (typeof item === 'string' ? item : item.id) !== job.id);
    }
    const run = {
      id: runId,
      jobId: job.id,
      jobUrl: urlCheck.url,
      jobDescription,
      notes: String(input.notes || ''),
      status: 'queued',
      generateResume: input.generateResume !== false,
      resumeMode,
      resumeProfileId: resumeProfile.id,
      resumeProfileLabel: resumeProfile.label,
      resumeProfileSourceDir: resumeProfile.sourceDir,
      analysisKey,
      generateCoverLetter: Boolean(input.generateCoverLetter),
      saveToTracker: Boolean(input.saveToTracker),
      createdAt: now,
      updatedAt: now,
      result: null,
      errorMessage: '',
      logs: [],
    };
    supersedeRunsForMode(state, job.id, resumeMode, runId, now, resumeProfile.id);
    job.status = 'analyzing';
    job.latestRunId = runId;
    job.updatedAt = now;
    state.runs.unshift(run);
    response = { runId, status: 'queued', jobId: job.id, replaced: true };
  });

  queue.push(response.runId);
  processQueue();
  return response;
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
    const resumeMode = normalizeResumeMode(input.resumeMode);
    const resumeProfile = resolveResumeProfile(input.resumeProfileId, { requireCv: input.generateResume !== false });
    const run = {
      id: runId,
      jobId: job.id,
      jobUrl: urlCheck.url,
      jobDescription,
      notes: String(input.notes ?? job.notes ?? ''),
      status: 'queued',
      generateResume: input.generateResume !== false,
      resumeMode,
      resumeProfileId: resumeProfile.id,
      resumeProfileLabel: resumeProfile.label,
      resumeProfileSourceDir: resumeProfile.sourceDir,
      analysisKey: job.analysisKey || buildAnalysisKey(urlCheck.url, jobDescription),
      generateCoverLetter: Boolean(input.generateCoverLetter),
      saveToTracker: Boolean(input.saveToTracker),
      createdAt: now,
      updatedAt: now,
      result: null,
      errorMessage: '',
      logs: [],
    };

    supersedeRunsForMode(state, job.id, resumeMode, runId, now, resumeProfile.id);
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

function buildAnalysisKey(jobUrl = '', jobDescription = '') {
  const canonical = canonicalUrlForAnalysis(jobUrl);
  if (canonical) return `url:${canonical}`;
  const text = normalizeComparable(jobDescription).slice(0, 900);
  return text ? `jd:${text}` : '';
}

function canonicalUrlForAnalysis(jobUrl = '') {
  const raw = String(jobUrl || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|src|gh_src|lever-origin|iis|iisn|t)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

function findExistingJobForAnalysis(state, analysisKey) {
  if (!analysisKey) return null;
  return (state.jobs || []).find((job) => !job.hidden && (
    job.analysisKey === analysisKey
    || buildAnalysisKey(job.jobUrl || job.applyUrl || '', job.description || '') === analysisKey
  )) || null;
}

function supersedeRunsForMode(state, jobId, resumeMode, newRunId, now = new Date().toISOString(), resumeProfileId = '') {
  const profileId = normalizeResumeProfileId(resumeProfileId);
  for (const run of state.runs || []) {
    if (run.jobId !== jobId || run.id === newRunId || normalizeResumeMode(run.resumeMode) !== resumeMode || normalizeResumeProfileId(run.resumeProfileId || run.result?.resumeProfileId) !== profileId || run.hidden) continue;
    run.hidden = true;
    run.hiddenReason = `Superseded by latest ${resumeMode === 'one_page' ? '1-page' : '2-page'} run for this job and resume profile.`;
    run.hiddenAt = now;
    run.supersededByRunId = newRunId;
    run.supersededAt = now;
  }
  for (const doc of state.documents || []) {
    if (doc.jobId !== jobId || normalizeResumeMode(doc.resumeMode) !== resumeMode || normalizeResumeProfileId(doc.resumeProfileId) !== profileId || doc.hidden) continue;
    doc.hidden = true;
    doc.hiddenReason = `Superseded by latest ${resumeMode === 'one_page' ? '1-page' : '2-page'} run for this job and resume profile.`;
    doc.hiddenAt = now;
    state.hiddenDocuments ||= [];
    const normalized = normalizeRelPath(doc.filePath);
    if (normalized && !state.hiddenDocuments.includes(normalized)) state.hiddenDocuments.push(normalized);
  }
}

function normalizeResumeProfileId(profileId = '') {
  return String(profileId || defaultResumeProfileIdFromDefinitions()).trim() || defaultResumeProfileIdFromDefinitions();
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
  const cvText = readResumeWorkspaceText('cv.md');
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
    label: snapshot.fileName || (snapshot.source === 'cv_md' ? 'Resume Workspace cv.md' : 'Discovery resume text'),
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

function readResumeWorkspaceText(relativePath) {
  const target = join(RESUME_WORKSPACE_ROOT, relativePath);
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
    const resumeProfile = resolveResumeProfile(run.resumeProfileId, { requireCv: run.generateResume !== false });

    const result = await runResumeWorkspaceAnalysis({
      runId: run.id,
      jobUrl: run.jobUrl,
      jobDescription: run.jobDescription,
      generateResume: run.generateResume,
      resumeMode: run.resumeMode || 'two_page',
      resumeProfileId: resumeProfile.id,
      resumeProfileLabel: resumeProfile.label,
      resumeProfileSourceDir: resumeProfile.sourceDir,
      resumeContext: {
        cv: resumeProfile.cvText,
        articleDigest: resumeProfile.articleDigestText,
        profileYml: resumeProfile.profileYmlText,
        storyBank: resumeProfile.storyBankText,
        resumeProfileId: resumeProfile.id,
        resumeProfileLabel: resumeProfile.label,
      },
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
    run.logs.push({ at: now, message: 'Resume Workspace analysis completed.' });

    if (job) {
      applyNormalizedJobMetadata(job, normalizedResult, run);
      job.status = normalizedResult.resumePdfError || normalizedResult.resumeQa?.status === 'needs_review' ? 'needs_review' : 'resume_ready';
      job.score = normalizedResult.score;
      job.recommendation = normalizedResult.resumePdfError || normalizedResult.resumeQa?.status === 'needs_review' ? 'Review' : normalizedResult.recommendation;
      job.summary = normalizedResult.summary;
      job.updatedAt = now;
    }

    addDocument(state, run, 'resume_workspace_report', normalizedResult.reportPath);
    addDocument(state, run, 'resume_pdf', normalizedResult.resumePdfPath);
    addDocument(state, run, 'resume_docx', normalizedResult.resumeDocxPath);
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
    const existing = state.applications.find((item) => !item.hidden && (item.runId === runId || item.jobId === run.jobId));
    if (existing) {
      Object.assign(existing, {
        runId,
        status: existing.status === 'saved' ? 'resume_ready' : existing.status,
        company: run.result.company,
        title: run.result.title,
        score: run.result.score,
        recommendation: run.result.recommendation,
        reportPath: run.result.reportPath,
        resumePdfPath: run.result.resumePdfPath,
        resumeDocxPath: run.result.resumeDocxPath,
        coverLetterPath: run.result.coverLetterPath,
        resumeProfileId: run.resumeProfileId || run.result.resumeProfileId || existing.resumeProfileId || '',
        resumeProfileLabel: run.resumeProfileLabel || run.result.resumeProfileLabel || existing.resumeProfileLabel || '',
        resumeMode: run.result.resumeMode || run.resumeMode || existing.resumeMode || '',
        updatedAt: now,
      });
      return existing;
    }

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
      resumeDocxPath: run.result.resumeDocxPath,
      coverLetterPath: run.result.coverLetterPath,
      resumeProfileId: run.resumeProfileId || run.result.resumeProfileId || '',
      resumeProfileLabel: run.resumeProfileLabel || run.result.resumeProfileLabel || '',
      resumeMode: run.result.resumeMode || run.resumeMode || '',
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
  if (!isAllowedArtifactPath(normalized)) throw new Error('Only Resume Workspace report/output documents can be hidden.');
  updateState((state) => {
    state.hiddenDocuments ||= [];
    if (!state.hiddenDocuments.includes(normalized)) state.hiddenDocuments.push(normalized);
    for (const doc of state.documents || []) {
      if (normalizeRelPath(doc.filePath) === normalized) {
        doc.hidden = true;
        doc.hiddenAt = new Date().toISOString();
        doc.hiddenReason = 'Hidden from active documents list by user.';
      }
    }
  });
}

function updateDocumentLabel(filePath, label) {
  const normalized = normalizeRelPath(filePath);
  if (!normalized) throw new Error('Document path is required.');
  if (!isAllowedArtifactPath(normalized)) throw new Error('Only Resume Workspace report/output documents can be edited.');
  const cleanLabel = cleanDisplayText(label).slice(0, 160);
  if (!cleanLabel) throw new ApiError(400, 'Document label cannot be empty.');
  return updateState((state) => {
    state.documents ||= [];
    let doc = state.documents.find((item) => normalizeRelPath(item.filePath) === normalized);
    if (!doc) {
      doc = {
        id: makeId('doc'),
        type: inferDocumentTypeFromPath(normalized),
        filePath: normalized,
        fileName: normalized.split(/[\\/]/).pop(),
        createdAt: new Date().toISOString(),
      };
      state.documents.unshift(doc);
    }
    doc.customLabel = cleanLabel;
    doc.displayName = cleanLabel;
    doc.hidden = false;
    return doc;
  });
}

function importStateBackup(body = {}) {
  const candidate = body.state && typeof body.state === 'object' ? body.state : body;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new ApiError(400, 'Import file must contain a JSON state object.');
  }
  if (!Array.isArray(candidate.jobs) || !Array.isArray(candidate.runs)) {
    throw new ApiError(400, 'Import file does not look like an Personal Resume Helper state backup.');
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
    resumeProfileId: run.resumeProfileId || run.result?.resumeProfileId || '',
    resumeProfileLabel: run.resumeProfileLabel || run.result?.resumeProfileLabel || '',
    resumeProfileSourceDir: run.resumeProfileSourceDir || run.result?.resumeProfileSourceDir || '',
    qaStatus: run.result?.resumeQa?.status || '',
    qaScore: Number.isFinite(Number(run.result?.resumeQa?.score)) ? Number(run.result.resumeQa.score) : null,
    createdAt: new Date().toISOString(),
  });
}

function getScannerInbox() {
  const state = readState();
  const pipelinePath = join(RESUME_WORKSPACE_ROOT, 'data', 'pipeline.md');
  const historyPath = join(RESUME_WORKSPACE_ROOT, 'data', 'scan-history.tsv');
  const history = readScannerHistory(historyPath);
  const hiddenRows = new Set((state.hiddenScannerRows || []).map((item) => String(item?.id || item?.url || item || '')));
  const rows = existsSync(pipelinePath)
    ? readFileSync(pipelinePath, 'utf-8').split(/\r?\n/).map(parsePipelineLine).filter(Boolean)
    : [];
  const decorated = rows.map((row) => {
    const key = scannerRowId(row.url, row.company, row.title);
    const historyItem = history.get(canonicalUrlForAnalysis(row.url)) || null;
    const sourceStatus = historyItem?.status || row.sourceStatus || row.status;
    const firstSeen = historyItem?.firstSeen || '';
    const lastSeen = historyItem?.lastSeen || firstSeen;
    const ageDays = scannerAgeDays(lastSeen);
    const expired = /expired|closed|removed|not_found|no_h1b/i.test(sourceStatus || '') || /expired|closed/i.test(row.note || '');
    const stale = Number.isFinite(ageDays) && ageDays > 14;
    const isAnalyzable = row.status === 'pending' && /^https?:\/\//i.test(row.url) && !row.warning && !expired;
    const qualityStatus = expired
      ? 'expired'
      : row.status === 'review_source'
        ? 'review_source'
        : row.status === 'processed'
          ? 'processed'
          : stale
            ? 'stale'
            : isAnalyzable
              ? 'ready'
              : 'review_source';
    return {
      ...row,
      id: key,
      source: historyItem?.portal || row.source || 'Resume Workspace pipeline',
      location: historyItem?.location || row.location || '',
      sourceStatus,
      firstSeen,
      lastSeen,
      ageDays: Number.isFinite(ageDays) ? ageDays : null,
      freshness: scannerFreshnessLabel(ageDays, lastSeen ? 'Verified' : 'Seen'),
      hidden: hiddenRows.has(key) || hiddenRows.has(row.url),
      isAnalyzable,
      qualityStatus,
    };
  });
  const sortedRows = decorated
    .filter((row) => !row.hidden)
    .sort((a, b) => {
      const rank = { ready: 0, stale: 1, review_source: 2, processed: 3, expired: 4 };
      const statusDelta = (rank[a.qualityStatus] ?? 9) - (rank[b.qualityStatus] ?? 9);
      if (statusDelta) return statusDelta;
      return String(b.lastSeen || b.firstSeen || '').localeCompare(String(a.lastSeen || a.firstSeen || ''));
    });
  return {
    rows: sortedRows,
    counts: {
      total: decorated.length,
      visible: decorated.filter((row) => !row.hidden).length,
      ready: decorated.filter((row) => !row.hidden && row.qualityStatus === 'ready').length,
      pending: decorated.filter((row) => !row.hidden && row.status === 'pending').length,
      stale: decorated.filter((row) => !row.hidden && row.qualityStatus === 'stale').length,
      expired: decorated.filter((row) => !row.hidden && row.qualityStatus === 'expired').length,
      review: decorated.filter((row) => !row.hidden && row.qualityStatus === 'review_source').length,
      processed: decorated.filter((row) => !row.hidden && row.qualityStatus === 'processed').length,
      hidden: decorated.filter((row) => row.hidden).length,
    },
    health: getScannerHealthSummary(),
  };
}

function hideScannerInboxRow(input = {}) {
  const rowId = String(input.id || '').trim();
  const url = String(input.url || '').trim();
  if (!rowId && !url) throw new ApiError(400, 'Scanner row id or URL is required.');
  const now = new Date().toISOString();
  updateState((state) => {
    state.hiddenScannerRows ||= [];
    const existing = state.hiddenScannerRows.some((item) => item?.id === rowId || item?.url === url || item === rowId || item === url);
    if (!existing) {
      state.hiddenScannerRows.push({
        id: rowId || scannerRowId(url, input.company || '', input.title || ''),
        url,
        hiddenAt: now,
        hiddenReason: 'Hidden from Scanner Inbox by user.',
      });
    }
  });
  return { ok: true };
}

function parsePipelineLine(line = '') {
  const match = String(line).match(/^- \[([ x!])\]\s+(.+)$/i);
  if (!match) return null;
  const marker = match[1].toLowerCase();
  const body = match[2].trim();
  const parts = body.split('|').map((part) => part.trim()).filter(Boolean);
  const urlIndex = parts.findIndex((part) => /^https?:\/\//i.test(part));
  const urlMatch = body.match(/https?:\/\/[^\s|]+/i);
  const url = urlMatch?.[0] || (urlIndex >= 0 ? parts[urlIndex].split(/\s+(?:-|–|—|â€”|â€“)\s+/)[0] : '');
  const warning = marker === '!' || /search page|not a single jd|use [`/]?resume-workspace scan/i.test(body);
  if (urlIndex >= 0) {
    const company = parts[urlIndex + 1] || '';
    const title = parts[urlIndex + 2] || '';
    return {
      status: marker === 'x' ? 'processed' : warning ? 'review_source' : 'pending',
      url,
      company: cleanScannerText(company || 'Unknown company'),
      title: cleanScannerText(title || 'Job opportunity'),
      warning,
      note: warning ? cleanScannerText(body.replace(url, '').replace(/^[\s\-|—–]+/, '')) : '',
    };
  }
  return {
    status: warning ? 'review_source' : marker === 'x' ? 'processed' : 'pending',
    url,
    company: 'Review source',
    title: cleanScannerText(body.replace(url, '').replace(/^[\s\-|—–]+/, '') || 'Pipeline row'),
    warning,
    note: cleanScannerText(body.replace(url, '').replace(/^[\s\-|—–]+/, '')),
  };
}

async function runResumeWorkspaceApiScanner({ dryRun = false } = {}) {
  const portalsPath = join(RESUME_WORKSPACE_ROOT, 'portals.yml');
  if (!existsSync(portalsPath)) throw new ApiError(404, 'Resume Workspace portals.yml was not found.');
  const config = parseApiScannerPortalConfig(readFileSync(portalsPath, 'utf-8'));
  const titleFilter = buildApiScannerTitleFilter(config.titleFilter);
  const locationFilter = buildApiScannerLocationFilter(config.locationFilter);
  const targets = config.companies
    .filter((company) => company.enabled !== false)
    .map((company) => ({ ...company, api: detectScannerApi(company) }))
    .filter((company) => company.api);

  const seen = loadScannerSeenSets();
  const newOffers = [];
  const verifiedOffers = [];
  const errors = [];
  let totalFound = 0;
  let totalFiltered = 0;
  let totalLocationFiltered = 0;
  let totalDupes = 0;

  const sourceResults = await Promise.all(targets.map(async (company) => {
    try {
      const json = await scannerPromiseTimeout(fetchScannerJson(company.api.url), 12_000, company.name);
      return {
        company,
        jobs: parseScannerApiJobs(company.api.type, json, scannerCompanyDisplayName(company.name)),
      };
    } catch (error) {
      return {
        company,
        jobs: [],
        error: cleanScannerText(error.message || String(error)),
      };
    }
  }));

  for (const result of sourceResults) {
    const { company, jobs } = result;
    if (result.error) errors.push({ company: company.name, error: result.error });
    totalFound += jobs.length;
    for (const job of jobs) {
      if (!job.url || !titleFilter(job.title)) {
        totalFiltered += 1;
        continue;
      }
      if (!locationFilter(job.location)) {
        totalLocationFiltered += 1;
        continue;
      }
      const verifiedOffer = { ...job, source: `${company.api.type}-api` };
      verifiedOffers.push(verifiedOffer);
      const canonical = canonicalUrlForAnalysis(job.url);
      const roleKey = `${String(job.company || '').toLowerCase()}::${String(job.title || '').toLowerCase()}`;
      if (seen.urls.has(canonical) || seen.companyRoles.has(roleKey)) {
        totalDupes += 1;
        continue;
      }
      seen.urls.add(canonical);
      seen.companyRoles.add(roleKey);
      newOffers.push(verifiedOffer);
    }
  }

  const date = new Date().toISOString().slice(0, 10);
  if (!dryRun && verifiedOffers.length) {
    if (newOffers.length) appendScannerOffersToPipeline(newOffers);
    upsertScannerOffersInHistory(verifiedOffers, date);
  }

  return {
    ok: true,
    dryRun,
    summary: {
      apiDetectableCompanies: String(targets.length),
      totalJobsFound: String(totalFound),
      filteredByTitle: `${totalFiltered} removed`,
      filteredByLocation: `${totalLocationFiltered} removed`,
      duplicates: `${totalDupes} skipped`,
      verifiedLive: String(verifiedOffers.length),
      newOffersAdded: String(newOffers.length),
      written: dryRun ? 'No - dry run' : verifiedOffers.length ? 'Yes - history refreshed' : 'No live matches',
    },
    errors,
    offers: (newOffers.length ? newOffers : verifiedOffers).slice(0, 25),
  };
}

function parseApiScannerPortalConfig(text = '') {
  return {
    titleFilter: {
      positive: parseYamlListUnder(text, 'positive'),
      negative: parseYamlListUnder(text, 'negative'),
    },
    locationFilter: {
      include: parseYamlListInSection(text, 'location_filter', 'include'),
      exclude: parseYamlListInSection(text, 'location_filter', 'exclude'),
    },
    companies: parseTrackedCompanies(text),
  };
}

function parseYamlListUnder(text = '', key = '') {
  const match = text.match(new RegExp(`\\n\\s*${key}:\\s*\\n([\\s\\S]*?)(?=\\n\\s*[a-zA-Z_]+:|\\ntracked_companies:|$)`, 'i'));
  if (!match) return [];
  return [...match[1].matchAll(/^\s*-\s+['"]?(.+?)['"]?\s*$/gm)]
    .map((item) => cleanScannerText(item[1]).replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function parseYamlListInSection(text = '', sectionKey = '', listKey = '') {
  const sectionMatch = text.match(new RegExp(`\\n${sectionKey}:\\s*\\n([\\s\\S]*?)(?=\\n[a-zA-Z_]+:|\\ntracked_companies:|$)`, 'i'));
  if (!sectionMatch) return [];
  const listMatch = sectionMatch[1].match(new RegExp(`\\n\\s*${listKey}:\\s*\\n([\\s\\S]*?)(?=\\n\\s{2}[a-zA-Z_]+:|\\n[a-zA-Z_]+:|$)`, 'i'));
  if (!listMatch) return [];
  return [...listMatch[1].matchAll(/^\s*-\s+['"]?(.+?)['"]?\s*$/gm)]
    .map((item) => cleanScannerText(item[1]).replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}
function parseTrackedCompanies(text = '') {
  const section = text.split(/\ntracked_companies:\s*\n/)[1] || '';
  return section.split(/\n\s*-\s+name:\s+/).slice(1).map((block) => {
    const firstLineEnd = block.indexOf('\n');
    const name = cleanScannerText(firstLineEnd >= 0 ? block.slice(0, firstLineEnd) : block);
    const field = (fieldName) => {
      const match = block.match(new RegExp(`\\n\\s*${fieldName}:\\s*(.+)`, 'i'));
      return cleanScannerText(match?.[1] || '').replace(/^['"]|['"]$/g, '');
    };
    return {
      name,
      careersUrl: field('careers_url'),
      apiUrl: field('api'),
      scanMethod: field('scan_method'),
      enabled: !/\n\s*enabled:\s*false\b/i.test(block),
    };
  }).filter((company) => company.name);
}

function buildApiScannerTitleFilter(titleFilter = {}) {
  const positive = (titleFilter.positive || []).map((item) => item.toLowerCase());
  const negative = (titleFilter.negative || []).map((item) => item.toLowerCase());
  return (title = '') => {
    const lower = String(title || '').toLowerCase();
    const hasPositive = !positive.length || positive.some((item) => lower.includes(item));
    const hasNegative = negative.some((item) => lower.includes(item));
    return hasPositive && !hasNegative;
  };
}

function buildApiScannerLocationFilter(locationFilter = {}) {
  const include = (locationFilter.include || []).map((item) => item.toLowerCase()).filter(Boolean);
  const exclude = (locationFilter.exclude || []).map((item) => item.toLowerCase()).filter(Boolean);
  return (location = '') => {
    const lower = String(location || '').toLowerCase();
    if (!lower) return true;
    if (exclude.some((item) => lower.includes(item))) return false;
    if (!include.length) return true;
    return include.some((item) => lower.includes(item));
  };
}

function detectScannerApi(company = {}) {
  if (company.apiUrl && /greenhouse/i.test(company.apiUrl)) return { type: 'greenhouse', url: company.apiUrl };
  const url = company.careersUrl || '';
  const ashby = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/i);
  if (ashby) return { type: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${ashby[1]}?includeCompensation=true` };
  const lever = url.match(/jobs\.lever\.co\/([^/?#]+)/i);
  if (lever) return { type: 'lever', url: `https://api.lever.co/v0/postings/${lever[1]}` };
  const greenhouse = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/i);
  if (greenhouse) return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${greenhouse[1]}/jobs` };
  return null;
}

function scannerPromiseTimeout(promise, ms, label = 'source') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout after ${Math.round(ms / 1000)}s for ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
async function fetchScannerJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function scannerCompanyDisplayName(name = '') {
  return cleanScannerText(name).replace(/\s+Direct ATS$/i, '');
}
function parseScannerApiJobs(type, json, companyName) {
  if (type === 'greenhouse') {
    return (json.jobs || []).map((job) => ({
      title: job.title || '',
      url: job.absolute_url || '',
      company: companyName,
      location: job.location?.name || '',
    }));
  }
  if (type === 'ashby') {
    return (json.jobs || []).map((job) => ({
      title: job.title || '',
      url: job.jobUrl || '',
      company: companyName,
      location: job.location || '',
    }));
  }
  if (type === 'lever' && Array.isArray(json)) {
    return json.map((job) => ({
      title: job.text || '',
      url: job.hostedUrl || '',
      company: companyName,
      location: job.categories?.location || '',
    }));
  }
  return [];
}

function loadScannerSeenSets() {
  const urls = new Set();
  const companyRoles = new Set();
  const historyPath = join(RESUME_WORKSPACE_ROOT, 'data', 'scan-history.tsv');
  const pipelinePath = join(RESUME_WORKSPACE_ROOT, 'data', 'pipeline.md');
  const applicationsPath = join(RESUME_WORKSPACE_ROOT, 'data', 'applications.md');
  for (const filePath of [historyPath, pipelinePath, applicationsPath]) {
    if (!existsSync(filePath)) continue;
    const text = readFileSync(filePath, 'utf-8');
    for (const match of text.matchAll(/https?:\/\/[^\s|)]+/g)) urls.add(canonicalUrlForAnalysis(match[0]));
  }
  if (existsSync(applicationsPath)) {
    const text = readFileSync(applicationsPath, 'utf-8');
    for (const match of text.matchAll(/\|[^|]+\|[^|]+\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|/g)) {
      const company = cleanScannerText(match[1]).toLowerCase();
      const title = cleanScannerText(match[2]).toLowerCase();
      if (company && title && company !== 'company') companyRoles.add(`${company}::${title}`);
    }
  }
  return { urls, companyRoles };
}

function appendScannerOffersToPipeline(offers = []) {
  const pipelinePath = join(RESUME_WORKSPACE_ROOT, 'data', 'pipeline.md');
  let text = existsSync(pipelinePath) ? readFileSync(pipelinePath, 'utf-8') : '# Pipeline Inbox\n\n## Pendientes\n\n## Procesadas\n';
  const block = offers.map((offer) => `- [ ] ${offer.url} | ${offer.company} | ${offer.title}`).join('\n') + '\n';
  const marker = '## Pendientes';
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) {
    text += `\n${marker}\n\n${block}`;
  } else {
    const insertAt = text.indexOf('\n## ', markerIndex + marker.length);
    const at = insertAt < 0 ? text.length : insertAt;
    text = `${text.slice(0, at).trimEnd()}\n${block}\n${text.slice(at).trimStart()}`;
  }
  writeFileSync(pipelinePath, text, 'utf-8');
}

function upsertScannerOffersInHistory(offers = [], date = new Date().toISOString().slice(0, 10)) {
  const historyPath = join(RESUME_WORKSPACE_ROOT, 'data', 'scan-history.tsv');
  const byUrl = new Map();
  if (existsSync(historyPath)) {
    for (const line of readFileSync(historyPath, 'utf-8').split(/\r?\n/).slice(1)) {
      if (!line.trim()) continue;
      const item = parseScannerHistoryLine(line);
      if (item?.url) byUrl.set(canonicalUrlForAnalysis(item.url), item);
    }
  }
  for (const offer of offers) {
    const key = canonicalUrlForAnalysis(offer.url);
    if (!key) continue;
    const existing = byUrl.get(key) || {};
    byUrl.set(key, {
      url: offer.url,
      firstSeen: existing.firstSeen || date,
      lastSeen: date,
      portal: offer.source || existing.portal || 'api-scan',
      title: offer.title || existing.title || '',
      company: offer.company || existing.company || '',
      location: offer.location || existing.location || '',
      status: `live:${date}`,
    });
  }
  const header = 'url\tfirst_seen\tlast_seen\tportal\ttitle\tcompany\tlocation\tstatus\n';
  const lines = [...byUrl.values()]
    .sort((a, b) => String(b.lastSeen || b.firstSeen || '').localeCompare(String(a.lastSeen || a.firstSeen || '')))
    .map((item) => [item.url, item.firstSeen, item.lastSeen || item.firstSeen || '', item.portal, item.title, item.company, item.location || '', item.status]
      .map((value) => cleanScannerText(value).replace(/\t/g, ' '))
      .join('\t'));
  writeFileSync(historyPath, header + lines.join('\n') + (lines.length ? '\n' : ''), 'utf-8');
}
function scannerAgeDays(firstSeen = '') {
  const time = Date.parse(firstSeen);
  if (!Number.isFinite(time)) return null;
  return Math.floor((Date.now() - time) / 86_400_000);
}

function scannerFreshnessLabel(ageDays, verb = 'Seen') {
  if (!Number.isFinite(ageDays)) return 'Unknown age';
  if (ageDays <= 0) return `${verb} today`;
  if (ageDays === 1) return `${verb} yesterday`;
  if (ageDays <= 14) return `${verb} ${ageDays} days ago`;
  return `Stale - ${verb.toLowerCase()} ${ageDays} days ago`;
}
function readScannerHistory(historyPath) {
  const byUrl = new Map();
  if (!existsSync(historyPath)) return byUrl;
  const lines = readFileSync(historyPath, 'utf-8').split(/\r?\n/).slice(1);
  for (const line of lines) {
    if (!line.trim()) continue;
    const item = parseScannerHistoryLine(line);
    if (!item?.url) continue;
    byUrl.set(canonicalUrlForAnalysis(item.url), item);
  }
  return byUrl;
}

function parseScannerHistoryLine(line = '') {
  const parts = line.split('\t');
  if (parts.length >= 8) {
    const [url, firstSeen, lastSeen, portal, title, company, location, status] = parts;
    return {
      url,
      firstSeen: firstSeen || '',
      lastSeen: lastSeen || firstSeen || '',
      portal: cleanScannerText(portal || ''),
      title: cleanScannerText(title || ''),
      company: cleanScannerText(company || ''),
      location: cleanScannerText(location || ''),
      status: cleanScannerText(status || ''),
    };
  }
  if (parts.length >= 7) {
    const [url, firstSeen, lastSeen, portal, title, company, status] = parts;
    return {
      url,
      firstSeen: firstSeen || '',
      lastSeen: lastSeen || firstSeen || '',
      portal: cleanScannerText(portal || ''),
      title: cleanScannerText(title || ''),
      company: cleanScannerText(company || ''),
      location: '',
      status: cleanScannerText(status || ''),
    };
  }
  const [url, firstSeen, portal, title, company, status] = parts;
  const cleanStatus = cleanScannerText(status || '');
  const liveDate = cleanStatus.match(/\blive:(\d{4}-\d{2}-\d{2})\b/i)?.[1] || '';
  return {
    url,
    firstSeen: firstSeen || '',
    lastSeen: liveDate || firstSeen || '',
    portal: cleanScannerText(portal || ''),
    title: cleanScannerText(title || ''),
    company: cleanScannerText(company || ''),
    location: '',
    status: cleanStatus.replace(/\blive:\d{4}-\d{2}-\d{2}\b/i, 'live').trim(),
  };
}

function scannerRowId(url = '', company = '', title = '') {
  const base = canonicalUrlForAnalysis(url) || `${company}|${title}`;
  let hash = 0;
  for (const char of base) hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0;
  return `scanner_${Math.abs(hash).toString(36)}`;
}

function cleanScannerText(value = '') {
  return String(value || '')
    .replace(/[\uFFFD]/g, '')
    .replace(/â€”|â€“|Ã¢â‚¬â€|Ã¢â‚¬â€œ/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function getScannerHealthSummary() {
  const portalsPath = join(RESUME_WORKSPACE_ROOT, 'portals.yml');
  const pipelinePath = join(RESUME_WORKSPACE_ROOT, 'data', 'pipeline.md');
  const historyPath = join(RESUME_WORKSPACE_ROOT, 'data', 'scan-history.tsv');
  const stats = existsSync(portalsPath) ? scannerPortalStats(readFileSync(portalsPath, 'utf-8')) : {
    trackedCompanies: 0,
    enabledCompanies: 0,
    apiDetectableCompanies: 0,
    websearchCompanies: 0,
    enabledSearchQueries: 0,
  };
  return {
    portalsFound: existsSync(portalsPath),
    pipelineFound: existsSync(pipelinePath),
    scanHistoryFound: existsSync(historyPath),
    ...stats,
  };
}

function scannerPortalStats(text = '') {
  const searchSection = (text.split(/\nsearch_queries:\s*\n/)[1] || '').split(/\ntracked_companies:\s*\n/)[0] || '';
  const trackedSection = text.split(/\ntracked_companies:\s*\n/)[1] || '';
  const queryBlocks = searchSection.split(/\n\s*-\s+name:\s+/).slice(1);
  const companyBlocks = trackedSection.split(/\n\s*-\s+name:\s+/).slice(1);
  const enabledQueries = queryBlocks.filter((block) => !/\n\s*enabled:\s*false\b/i.test(block));
  const enabledCompanies = companyBlocks.filter((block) => !/\n\s*enabled:\s*false\b/i.test(block));
  const apiDetectable = enabledCompanies.filter((block) => /\n\s*api:\s*|jobs\.ashbyhq\.com|jobs\.lever\.co|job-boards(?:\.eu)?\.greenhouse\.io|boards-api\.greenhouse/i.test(block));
  const websearch = enabledCompanies.filter((block) => /\n\s*scan_method:\s*websearch\b/i.test(block));
  return {
    trackedCompanies: companyBlocks.length,
    enabledCompanies: enabledCompanies.length,
    apiDetectableCompanies: apiDetectable.length,
    websearchCompanies: websearch.length,
    enabledSearchQueries: enabledQueries.length,
  };
}
async function getHealth() {
  const required = ['profiles/resume-1/cv.md', 'profiles/resume-1/article-digest.md'];
  const state = readState();
  return {
    ok: required.every((file) => existsSync(join(RESUME_WORKSPACE_ROOT, file))),
    appRoot: DEBUG_LOCAL_PATHS ? APP_ROOT : 'local app root',
    resumeWorkspaceRoot: DEBUG_LOCAL_PATHS ? RESUME_WORKSPACE_ROOT : 'local Resume Workspace root',
    node: process.version,
    schemaVersion: state.schemaVersion || 2,
    resumeSnapshots: (state.resumeSnapshots || []).length,
    resumeProfiles: buildResumeProfiles(state).filter((profile) => profile.isEnabled).length,
    geminiConfigured: hasUsableGeminiApiKey(process.env.GEMINI_API_KEY),
    geminiModel: process.env.GEMINI_MODEL,
    localCaches: {
      jobDescriptions: safeCountFiles(join(APP_ROOT, 'data', 'cache', 'job-descriptions')),
      geminiEvaluations: safeCountFiles(join(APP_ROOT, 'data', 'cache', 'gemini-evaluations')),
      note: 'Private local cache used to reduce repeated fetches and Gemini token usage.',
    },
    discoveryDisabled: true,
    scanner: getScannerHealthSummary(),
    required: required.map((file) => ({ file, exists: existsSync(join(RESUME_WORKSPACE_ROOT, file)) })),
  };
}

function hasUsableGeminiApiKey(value = '') {
  const key = String(value || '').trim();
  if (!key) return false;
  return !/^(your_|replace_|changeme|example_|test_|dummy_|placeholder)/i.test(key);
}

function safeCountFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function getProfile(selectedResumeProfileId = '') {
  const state = readState();
  const profilePayload = getResumeProfilesPayload(selectedResumeProfileId);
  const activeProfile = resolveResumeProfile(profilePayload.activeResumeProfile?.id || selectedResumeProfileId);
  const profilePath = join(RESUME_WORKSPACE_ROOT, activeProfile.profileYmlPath || 'config/profile.yml');
  const cvPath = join(RESUME_WORKSPACE_ROOT, activeProfile.cvPath || 'cv.md');
  const digestPath = join(RESUME_WORKSPACE_ROOT, activeProfile.articleDigestPath || 'article-digest.md');
  const cvText = activeProfile.cvText || (existsSync(cvPath) ? readFileSync(cvPath, 'utf-8') : '');
  const digestText = activeProfile.articleDigestText || (existsSync(digestPath) ? readFileSync(digestPath, 'utf-8') : '');
  const latest = latestResumeSnapshot(state);
  return {
    profilePath: activeProfile.profileYmlPath || 'config/profile.yml',
    cvPath: activeProfile.cvPath || 'cv.md',
    articleDigestPath: activeProfile.articleDigestPath || 'article-digest.md',
    articleDigestExists: existsSync(digestPath),
    articleDigestText: digestText,
    articleDigestPreview: digestText.slice(0, 3000),
    articleDigestLength: digestText.length,
    articleDigestPreviewLength: Math.min(digestText.length, 3000),
    articleDigestBulletCount: digestText
      .split(/\r?\n/)
      .filter((line) => line.trim().startsWith('*')).length,
    sourceHealth: {
      cvLoaded: Boolean(cvText),
      articleDigestLoaded: Boolean(digestText),
      profileLoaded: existsSync(profilePath),
      storyBankLoaded: existsSync(join(RESUME_WORKSPACE_ROOT, activeProfile.storyBankPath || 'interview-prep/story-bank.md')),
      usingRootFallback: Boolean(activeProfile.sourceHealth?.usingRootFallback),
      usingSharedArticleDigest: Boolean(activeProfile.sourceHealth?.usingSharedArticleDigest),
    },
    profileText: existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '',
    cvPreview: cvText.slice(0, 3000),
    cvText,
    discoveryResumeSource: latest ? publicResumeSnapshot(latest) : {
      id: 'cv_md_current',
      source: 'cv_md',
      label: 'Resume Workspace cv.md',
      textLength: cvText.length,
      inferredRole: inferTargetRoleFromText(cvText),
    },
    resumeSnapshots: (state.resumeSnapshots || []).map(publicResumeSnapshot),
    resumeProfiles: profilePayload.resumeProfiles,
    defaultResumeProfileId: profilePayload.defaultResumeProfileId,
    activeResumeProfile: {
      ...profilePayload.activeResumeProfile,
      cvText,
      cvPreview: cvText.slice(0, 3000),
      articleDigestText: digestText,
      articleDigestPreview: digestText.slice(0, 3000),
    },
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
    resumeProfileId: app.resumeProfileId || run?.resumeProfileId || result.resumeProfileId || '',
    resumeProfileLabel: app.resumeProfileLabel || run?.resumeProfileLabel || result.resumeProfileLabel || '',
    resumeMode: app.resumeMode || run?.resumeMode || result.resumeMode || '',
    recommendation: normalizeRecommendation(app.recommendation || result.recommendation),
    applyUrl: app.applyUrl || result.applyUrl || job?.applyUrl || job?.jobUrl || run?.jobUrl || '',
    reportPath: app.reportPath || result.reportPath || '',
    resumePdfPath: app.resumePdfPath || result.resumePdfPath || '',
    resumeDocxPath: app.resumeDocxPath || result.resumeDocxPath || '',
    coverLetterPath: app.coverLetterPath || result.coverLetterPath || '',
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
    resumeProfileId: result.resumeProfileId || run.resumeProfileId || '',
    resumeProfileLabel: result.resumeProfileLabel || run.resumeProfileLabel || '',
    resumeProfileSourceDir: result.resumeProfileSourceDir || run.resumeProfileSourceDir || '',
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
  state.hiddenDocuments ||= [];
  for (const doc of state.documents || []) {
    if (doc.jobId === job.id) {
      doc.hidden = true;
      doc.hiddenReason = `Parent job hidden: ${reason}`;
      doc.hiddenAt = now;
      const normalized = normalizeRelPath(doc.filePath);
      if (normalized && !state.hiddenDocuments.includes(normalized)) state.hiddenDocuments.push(normalized);
    }
  }
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
    resume_docx: mode === 'one_page' ? '1-page tailored resume Word' : mode === 'two_page' ? '2-page tailored resume Word' : 'Tailored resume Word',
    resume_workspace_report: 'Resume Workspace report',
    cover_letter: 'Cover letter',
    original_resume: 'Original resume',
  }[type] || 'Document';
  const context = [company, title].filter(Boolean).join(' - ');
  const ext = String(filePath || '').split('.').pop();
  return cleanDisplayText(`${context ? `${context} - ` : ''}${kind}${ext && !kind.toLowerCase().includes(ext.toLowerCase()) ? `.${ext}` : ''}`);
}

function inferDocumentTypeFromPath(filePath = '') {
  const normalized = normalizeRelPath(filePath);
  if (normalized === 'cv.md') return 'original_resume';
  if (normalized.endsWith('cover-letter.md')) return 'cover_letter';
  if (normalized.startsWith('reports/')) return 'resume_workspace_report';
  if (normalized.endsWith('.docx')) return 'resume_docx';
  if (normalized.endsWith('.html')) return 'resume_html';
  if (normalized.endsWith('.log')) return 'resume_pdf_error';
  if (normalized.endsWith('.pdf')) return 'resume_pdf';
  return 'document';
}

function listExistingDocuments() {
  const docs = [];
  const cvPath = join(RESUME_WORKSPACE_ROOT, 'cv.md');
  if (existsSync(cvPath)) docs.push(toDoc('original_resume', cvPath));
  collectFiles(join(RESUME_WORKSPACE_ROOT, 'reports'), '.md', 30).forEach((file) => docs.push(toDoc('resume_workspace_report', file)));
  collectFiles(join(RESUME_WORKSPACE_ROOT, 'output'), '.pdf', 40).forEach((file) => docs.push(toDoc('resume_pdf', file)));
  collectFiles(join(RESUME_WORKSPACE_ROOT, 'output'), '.docx', 40).forEach((file) => docs.push(toDoc('resume_docx', file)));
  collectFiles(join(RESUME_WORKSPACE_ROOT, 'output'), 'cover-letter.md', 20).forEach((file) => docs.push(toDoc('cover_letter', file)));
  return docs.slice(0, 100);
}

function visibleDocuments(state) {
  const hidden = new Set((state.hiddenDocuments || []).map(normalizeRelPath));
  const seen = new Set();
  const hiddenJobIds = hiddenJobIdSet(state);
  return [...state.documents, ...listExistingDocuments()]
    .filter((doc) => doc?.filePath)
    .filter((doc) => !doc.hidden)
    .filter((doc) => !doc.jobId || !hiddenJobIds.has(doc.jobId))
    .map((doc) => {
      const filePath = normalizeRelPath(doc.filePath);
      const job = state.jobs.find((item) => item.id === doc.jobId);
      const run = state.runs.find((item) => item.id === doc.runId);
      return {
        ...doc,
        filePath,
        displayName: doc.customLabel || documentDisplayName(doc.type, job, run, filePath),
        company: chooseDisplayCompany(job?.resolvedCompany, run?.result?.resolvedCompany, run?.result?.company, doc.company, job?.company, ''),
        title: chooseDisplayTitle(job?.resolvedTitle, run?.result?.resolvedTitle, run?.result?.title, doc.title, job?.title, ''),
        resumeProfileId: doc.resumeProfileId || run?.resumeProfileId || run?.result?.resumeProfileId || '',
        resumeProfileLabel: doc.resumeProfileLabel || run?.resumeProfileLabel || run?.result?.resumeProfileLabel || '',
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

function collectFiles(dir, suffix, limit = 100) {
  if (!existsSync(dir)) return [];
  const result = [];
  const visit = (currentDir) => {
    if (result.length >= limit) return;
    const entries = readdirSafe(currentDir)
      .map((entry) => ({ entry, path: join(currentDir, entry.name), mtimeMs: statMtimeSafe(join(currentDir, entry.name)) }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const { entry, path } of entries) {
      if (result.length >= limit) break;
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith(suffix)) result.push(path);
    }
  };
  visit(dir);
  return result.sort((a, b) => statMtimeSafe(b) - statMtimeSafe(a)).slice(0, limit);
}

function statMtimeSafe(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
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
  const target = normalized.startsWith('app-data/')
    ? resolve(APP_ROOT, normalized.replace(/^app-data\//, ''))
    : resolve(RESUME_WORKSPACE_ROOT, normalized);
  const allowedRoot = normalized.startsWith('app-data/') ? APP_ROOT : RESUME_WORKSPACE_ROOT;
  if (!target.startsWith(allowedRoot) || !existsSync(target)) {
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
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  }[extname(file)] || 'application/octet-stream';
}

function toDoc(type, absolutePath) {
  const rel = normalizeRelPath(relative(RESUME_WORKSPACE_ROOT, absolutePath));
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
    || normalized.startsWith('app-data/data/resume-workspace-runtime/reports/')
    || normalized.startsWith('app-data/data/resume-workspace-runtime/logs/')
    || normalized.startsWith('app-data/data/resume-workspace-runtime/output/')
    || normalized === 'cv.md';
}

function publicErrorMessage(error) {
  const raw = String(error?.message || error || 'Resume Workspace run failed.');
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
    return 'Windows blocked an external renderer. The app now uses a native PDF renderer for new runs; retry this job from Add Job or Analyzed Jobs.';
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
  return `Resume Workspace completed the evaluation for ${title} at ${company}.${scoreText} Recommendation: ${normalizeRecommendation(context.recommendation)}. Review the report, resume PDF, QA checks, and apply link before applying.`;
}

function looksLikeRawReportSummary(value) {
  const text = cleanDisplayText(value).toLowerCase();
  return text.includes('archetype detected')
    || text.includes('resume-workspace evaluation')
    || text.includes('tool: gemini')
    || text.includes('legitimacy:')
    || text.includes('pdf: pending')
    || text.includes('evaluada')
    || text.includes('dimensi')
    || text.includes('arquetipo')
    || /date:\s*\d{8}/i.test(text)
    || /score:\s*\?\/5/i.test(text)
    || /[ÃƒÃ‚Ã¢ï¿½]/.test(value);
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
  const selectedDigestBullets = cleanList(qa.selectedDigestBullets || qa.usedDigestBullets, 8);
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
    selectedDigestBullets,
    selectedCvBullets: (qa.selectedCvBullets || []).slice(0, 12),
    finalBullets: (qa.finalBullets || []).slice(0, 20),
    articleDigestUsed: Boolean(qa.articleDigestUsed || selectedDigestBullets.length || usedDigestBullets.length),
    articleDigestBulletCount: Number(qa.articleDigestBulletCount || selectedDigestBullets.length || usedDigestBullets.length || 0),
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
    .replace(/Ã¢â‚¬â„¢|Ã¢â‚¬Ëœ|ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢/g, "'")
    .replace(/Ã¢â‚¬Å“|Ã¢â‚¬Â|ÃƒÂ¢Ã¢â€šÂ¬Ã…â€œ|ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â/g, '"')
    .replace(/Ã¢â‚¬â€œ|Ã¢â‚¬â€|ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Å“|ÃƒÂ¢Ã¢â€šÂ¬Ã¢â‚¬Â/g, '-')
    .replace(/Ã¢â‚¬Â¢/g, '-')
    .replace(/Ã‚/g, '')
    .replace(/ÃƒÂ©/g, 'e')
    .replace(/ÃƒÂ³/g, 'o')
    .replace(/ÃƒÂ¡/g, 'a')
    .replace(/ÃƒÂ­/g, 'i')
    .replace(/ÃƒÂº/g, 'u')
    .replace(/ÃƒÂ±/g, 'n')
    .replace(/ÃƒÂ¼/g, 'u')
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



