import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const STORE_PATH = join(process.cwd(), 'data', 'state.json');

const initialState = {
  schemaVersion: 3,
  runs: [],
  jobs: [],
  jobSources: [],
  discoveryRuns: [],
  applications: [],
  documents: [],
  events: [],
  resumeSnapshots: [],
  resumeProfiles: [],
  defaultResumeProfileId: 'resume-1',
};

export function ensureStore() {
  mkdirSync(dirname(STORE_PATH), { recursive: true });
  if (!existsSync(STORE_PATH)) {
    writeFileSync(STORE_PATH, JSON.stringify(initialState, null, 2));
  }
}

export function readState() {
  ensureStore();
  const raw = readFileSync(STORE_PATH, 'utf-8').replace(/^\uFEFF/, '');
  try {
    return normalizeState({ ...initialState, ...JSON.parse(raw) });
  } catch (error) {
    const backupPath = `${STORE_PATH}.invalid-${Date.now()}`;
    copyFileSync(STORE_PATH, backupPath);
    throw new Error(`State file could not be parsed. Backup saved at ${backupPath}. ${error.message}`);
  }
}

export function writeState(state) {
  ensureStore();
  const normalized = normalizeState({ ...initialState, ...state });
  const backupPath = `${STORE_PATH}.bak-${Date.now()}`;
  if (existsSync(STORE_PATH)) retryFs(() => copyFileSync(STORE_PATH, backupPath));
  const tmpPath = `${STORE_PATH}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8');
  try {
    retryFs(() => renameSync(tmpPath, STORE_PATH));
  } catch (error) {
    if (!isTransientWindowsFsError(error)) throw error;
    // Windows Defender, OneDrive, or an editor can briefly lock state.json and reject
    // an atomic replace. Fall back to a direct write so the app can keep queueing jobs.
    retryFs(() => writeFileSync(STORE_PATH, `${JSON.stringify(normalized, null, 2)}\n`, 'utf-8'));
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      // A stale temp file is harmless and easier to clean later than failing the run.
    }
  }
}

function retryFs(operation, attempts = 8) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      lastError = error;
      if (!isTransientWindowsFsError(error) || attempt === attempts - 1) break;
      sleepSync(40 * (attempt + 1));
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

export function updateState(mutator) {
  const state = readState();
  const result = mutator(state);
  writeState(state);
  return result;
}

export class StateStore {
  read() {
    return readState();
  }

  write(state) {
    writeState(state);
    return state;
  }

  transaction(mutator) {
    return updateState(mutator);
  }

  appendDiscoveryRun(run) {
    return updateState((state) => {
      state.discoveryRuns ||= [];
      state.discoveryRuns.unshift(run);
      return run;
    });
  }

  upsertJobs(jobs = []) {
    return updateState((state) => {
      state.jobs ||= [];
      const byId = new Map(state.jobs.map((job) => [job.id, job]));
      for (const job of jobs) {
        if (job?.id && byId.has(job.id)) Object.assign(byId.get(job.id), job);
        else if (job) state.jobs.unshift(job);
      }
      return state.jobs;
    });
  }
}

export const stateStore = new StateStore();

export function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeState(state) {
  const now = new Date().toISOString();
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  return {
    ...state,
    schemaVersion: Number.isFinite(Number(state.schemaVersion)) ? Math.max(3, Number(state.schemaVersion)) : 3,
    runs: Array.isArray(state.runs) ? state.runs : [],
    jobs: jobs.map((job) => normalizeJobRecord(job, now)),
    jobSources: Array.isArray(state.jobSources) ? state.jobSources : [],
    discoveryRuns: Array.isArray(state.discoveryRuns) ? state.discoveryRuns : [],
    applications: Array.isArray(state.applications) ? state.applications.map((app) => normalizeApplicationRecord(app, now)) : [],
    documents: Array.isArray(state.documents) ? state.documents.map((doc) => normalizeDocumentRecord(doc, now)) : [],
    events: Array.isArray(state.events) ? state.events : [],
    resumeSnapshots: Array.isArray(state.resumeSnapshots) ? state.resumeSnapshots.map((snapshot) => normalizeResumeSnapshot(snapshot, now)) : [],
    resumeProfiles: Array.isArray(state.resumeProfiles) ? state.resumeProfiles.map((profile) => normalizeResumeProfile(profile, now)) : [],
    defaultResumeProfileId: state.defaultResumeProfileId || 'resume-1',
    hiddenDocuments: Array.isArray(state.hiddenDocuments) ? state.hiddenDocuments : [],
    hiddenJobs: Array.isArray(state.hiddenJobs) ? state.hiddenJobs : [],
    hiddenRuns: Array.isArray(state.hiddenRuns) ? state.hiddenRuns : [],
    trackerOverrides: state.trackerOverrides && typeof state.trackerOverrides === 'object' ? state.trackerOverrides : {},
  };
}

function normalizeJobRecord(job, now) {
  const jobUrl = String(job?.jobUrl || job?.applyUrl || '').trim();
  const applyUrl = String(job?.applyUrl || jobUrl || '').trim();
  const canonicalUrl = String(job?.canonicalUrl || canonicalizeUrl(applyUrl || jobUrl)).trim();
  return {
    ...job,
    sourceType: job?.sourceType || 'manual',
    sourceName: job?.sourceName || job?.source || 'Manual',
    externalId: job?.externalId || '',
    canonicalUrl,
    jobUrl,
    applyUrl,
    postedAt: job?.postedAt || '',
    discoveredAt: job?.discoveredAt || job?.createdAt || now,
    lastSeenAt: job?.lastSeenAt || job?.updatedAt || now,
    isActive: job?.isActive !== false,
    remoteType: job?.remoteType || '',
    employmentType: job?.employmentType || '',
    experienceLevel: job?.experienceLevel || '',
    salaryMin: job?.salaryMin ?? null,
    salaryMax: job?.salaryMax ?? null,
    currency: job?.currency || 'USD',
    skills: Array.isArray(job?.skills) ? job.skills : [],
    industry: job?.industry || '',
    quickScore: Number.isFinite(Number(job?.quickScore)) ? Number(job.quickScore) : null,
    quickScoreBreakdown: Array.isArray(job?.quickScoreBreakdown) ? job.quickScoreBreakdown : [],
    matchBucket: job?.matchBucket || inferMatchBucket(job),
    skipReason: job?.skipReason || '',
    duplicateOf: job?.duplicateOf || '',
    hidden: Boolean(job?.hidden),
    hiddenReason: job?.hiddenReason || '',
    hiddenAt: job?.hiddenAt || '',
    resolvedTitle: job?.resolvedTitle || job?.title || '',
    resolvedCompany: job?.resolvedCompany || job?.company || '',
    metadataConfidence: job?.metadataConfidence || '',
    sourceProvider: job?.sourceProvider || inferSourceProvider(job),
    atsJobId: job?.atsJobId || inferAtsJobId(applyUrl || jobUrl),
    matchReasons: Array.isArray(job?.matchReasons) ? job.matchReasons : Array.isArray(job?.quickScoreBreakdown) ? job.quickScoreBreakdown : [],
    matchedSkills: Array.isArray(job?.matchedSkills) ? job.matchedSkills : [],
    missingSkills: Array.isArray(job?.missingSkills) ? job.missingSkills : [],
    matchScoreFactors: job?.matchScoreFactors && typeof job.matchScoreFactors === 'object' ? job.matchScoreFactors : {},
    semanticScore: Number.isFinite(Number(job?.semanticScore)) ? Number(job.semanticScore) : null,
    scoreVersion: job?.scoreVersion || job?.discoveryScoreVersion || '',
    sourceTrust: job?.sourceTrust || inferSourceTrust(job),
    directApply: job?.directApply === undefined ? /greenhouse|lever\.co|ashbyhq|myworkdayjobs|workdayjobs|jobvite|smartrecruiters|icims|applytojob|jazzhr/i.test(applyUrl || jobUrl) : Boolean(job.directApply),
    freshness: job?.freshness || '',
    discoveryScoreVersion: job?.discoveryScoreVersion || '',
    userFeedback: job?.userFeedback && typeof job.userFeedback === 'object' ? job.userFeedback : {},
  };
}

function normalizeApplicationRecord(app, now) {
  return {
    ...app,
    status: app?.status || 'saved',
    recruiterName: app?.recruiterName || '',
    recruiterEmail: app?.recruiterEmail || '',
    contactUrl: app?.contactUrl || '',
    interviewStage: app?.interviewStage || '',
    lastContactAt: app?.lastContactAt || null,
    nextFollowUpAt: app?.nextFollowUpAt || null,
    followUpNotes: app?.followUpNotes || '',
    outcomeReason: app?.outcomeReason || '',
    appliedAt: app?.appliedAt || null,
    hidden: Boolean(app?.hidden),
    hiddenReason: app?.hiddenReason || '',
    hiddenAt: app?.hiddenAt || '',
    createdAt: app?.createdAt || now,
    updatedAt: app?.updatedAt || app?.createdAt || now,
  };
}

function normalizeDocumentRecord(doc, now) {
  return {
    ...doc,
    resumeProfileId: doc?.resumeProfileId || '',
    resumeProfileLabel: doc?.resumeProfileLabel || '',
    qaStatus: doc?.qaStatus || '',
    qaScore: Number.isFinite(Number(doc?.qaScore)) ? Number(doc.qaScore) : null,
    hidden: Boolean(doc?.hidden),
    hiddenReason: doc?.hiddenReason || '',
    hiddenAt: doc?.hiddenAt || '',
    createdAt: doc?.createdAt || now,
  };
}

function normalizeResumeProfile(profile, now) {
  return {
    id: profile?.id || makeId('profile'),
    label: profile?.label || 'Resume Profile',
    roleFamily: profile?.roleFamily || '',
    ownerName: profile?.ownerName || '',
    sourceDir: profile?.sourceDir || '',
    cvPath: profile?.cvPath || 'cv.md',
    articleDigestPath: profile?.articleDigestPath || 'article-digest.md',
    profileYmlPath: profile?.profileYmlPath || 'profile.yml',
    storyBankPath: profile?.storyBankPath || 'story-bank.md',
    isDefault: Boolean(profile?.isDefault),
    isEnabled: profile?.isEnabled !== false,
    archived: Boolean(profile?.archived),
    createdAt: profile?.createdAt || now,
    updatedAt: profile?.updatedAt || profile?.createdAt || now,
  };
}

function normalizeResumeSnapshot(snapshot, now) {
  return {
    id: snapshot?.id || makeId('resume'),
    source: snapshot?.source || 'pasted',
    fileName: snapshot?.fileName || '',
    label: snapshot?.label || resumeSnapshotLabel(snapshot),
    text: String(snapshot?.text || '').slice(0, 120000),
    textLength: Number(snapshot?.textLength || String(snapshot?.text || '').length || 0),
    inferredRole: snapshot?.inferredRole || '',
    createdAt: snapshot?.createdAt || now,
    updatedAt: snapshot?.updatedAt || snapshot?.createdAt || now,
  };
}

function resumeSnapshotLabel(snapshot = {}) {
  if (snapshot.fileName) return snapshot.fileName;
  if (snapshot.source === 'cv_md') return 'Career-Ops cv.md';
  return 'Discovery resume text';
}

function canonicalizeUrl(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|src|gh_src|lever-origin|iis|iisn)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(rawUrl || '').trim().toLowerCase();
  }
}

function inferMatchBucket(job) {
  if (job?.duplicateOf) return 'duplicate';
  if (['rejected', 'skipped'].includes(job?.status)) return 'skipped';
  if (job?.latestRunId || ['completed', 'resume_ready'].includes(job?.status)) return 'analyzed';
  const score = Number(job?.quickScore ?? job?.score ?? 0);
  if (score >= 80) return 'strong';
  if (score >= 55) return 'maybe';
  if (job?.quickScore !== undefined && score < 35) return 'skipped';
  return 'new';
}

function inferSourceProvider(job) {
  const text = `${job?.sourceType || ''} ${job?.sourceName || ''} ${job?.source || ''} ${job?.jobUrl || ''} ${job?.applyUrl || ''}`.toLowerCase();
  if (text.includes('greenhouse')) return 'Greenhouse';
  if (text.includes('lever')) return 'Lever';
  if (text.includes('ashby')) return 'Ashby';
  if (text.includes('workday')) return 'Workday';
  if (text.includes('ripplehire')) return 'RippleHire';
  return job?.sourceProvider || '';
}

function inferSourceTrust(job) {
  const type = job?.sourceType || '';
  if (['career_ops_ats', 'curated_direct_ats', 'greenhouse', 'lever', 'ashby'].includes(type)) return 'High';
  if (['career_ops_pipeline', 'arbeitnow', 'adzuna'].includes(type)) return 'Medium';
  if (['himalayas', 'remotejobs_org', 'remotive'].includes(type)) return 'Low';
  return '';
}

function inferAtsJobId(rawUrl) {
  if (!rawUrl) return '';
  try {
    const url = new URL(rawUrl);
    const greenhouse = url.pathname.match(/\/jobs\/(\d+)/i)?.[1] || url.searchParams.get('gh_jid');
    if (greenhouse) return greenhouse;
    const workday = url.pathname.match(/_([A-Z]{2,}-?\d+)$/i)?.[1] || url.pathname.match(/\/job\/[^/]+\/([^/?#]+)/i)?.[1];
    if (workday) return workday;
    const ripple = url.hash.match(/\/job\/(\d+)/i)?.[1] || url.searchParams.get('jobId');
    return ripple || '';
  } catch {
    return '';
  }
}

