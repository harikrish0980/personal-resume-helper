const pages = {
  dashboard: ['Dashboard', "Review today's jobs, runs, documents, and next actions."],
  add: ['Add Job', 'Paste a job link, optional JD text, and start a background Career-Ops run.'],
  jobs: ['Analyzed Jobs', 'Review jobs that already ran through Career-Ops analysis.'],
  discovery: ['Discovery Jobs', 'Find latest jobs, review quick matches, and choose what to analyze.'],
  applications: ['Applications', 'Track saved jobs from resume ready through offer or archive.'],
  documents: ['Documents', 'Open generated reports and resume PDFs.'],
  profile: ['Profile & Resume', 'Read the Career-Ops profile and resume source files.'],
  settings: ['Settings', 'Check local setup and integration status.'],
  run: ['Run Detail', 'Watch one Career-Ops job analysis.'],
};

const applicationStatuses = [
  ['saved', 'Saved'],
  ['analyzing', 'Analyzing'],
  ['resume_ready', 'Resume Ready'],
  ['applied', 'Applied'],
  ['recruiter_screen', 'Recruiter Screen'],
  ['technical_round', 'Technical Round'],
  ['final_round', 'Final Round'],
  ['offer', 'Offer'],
  ['rejected', 'Rejected'],
  ['archived', 'Archived'],
];

let state = { jobs: [], runs: [], applications: [], documents: [], tracker: [], discoveryRuns: [], jobSources: [], guidedSearches: [], profile: null };
let currentRunId = '';
let pollTimer = null;
let discoveryPollTimer = null;
let suppressHashRoute = false;
let editingApplicationId = '';

document.querySelectorAll('[data-route]').forEach((button) => {
  button.addEventListener('click', () => routeTo(button.dataset.route));
});
document.querySelectorAll('[data-route-jump]').forEach((button) => {
  button.addEventListener('click', () => routeTo(button.dataset.routeJump));
});

document.getElementById('theme-toggle').addEventListener('click', () => {
  document.body.classList.toggle('dark');
  localStorage.setItem('careerOpsTheme', document.body.classList.contains('dark') ? 'dark' : 'light');
});

document.getElementById('add-job-form').addEventListener('submit', submitJob);
document.getElementById('profile-preferences-form').addEventListener('submit', saveProfilePreferences);
document.getElementById('run-discovery').addEventListener('click', runDiscoveryNow);
document.getElementById('run-discovery-resume').addEventListener('click', () => runDiscoveryNow({ fromResume: true }));
document.getElementById('job-search').addEventListener('input', renderJobs);
document.getElementById('score-filter').addEventListener('change', renderJobs);
document.getElementById('discovery-search').addEventListener('input', renderDiscoveryJobs);
document.getElementById('discovery-bucket-filter').addEventListener('change', renderDiscoveryJobs);
document.getElementById('discovery-min-score').addEventListener('change', renderDiscoveryJobs);
document.getElementById('discovery-source-scope').addEventListener('change', renderDiscoveryJobs);
document.getElementById('discovery-work-mode').addEventListener('change', renderDiscoveryJobs);
document.getElementById('discovery-employment-type').addEventListener('change', renderDiscoveryJobs);
document.getElementById('discovery-sponsorship').addEventListener('change', renderDiscoveryJobs);
document.getElementById('discovery-resume-file').addEventListener('change', loadDiscoveryResumeFile);
document.getElementById('discovery-resume-text').addEventListener('input', renderDiscoveryResumeSource);
document.getElementById('document-search').addEventListener('input', renderDocuments);
document.getElementById('document-type-filter').addEventListener('change', renderDocuments);
document.getElementById('kanban-left').addEventListener('click', () => scrollKanban(-1));
document.getElementById('kanban-right').addEventListener('click', () => scrollKanban(1));
document.getElementById('export-state').addEventListener('click', exportStateBackup);
document.getElementById('import-state-file').addEventListener('change', importStateBackup);
document.getElementById('app-editor-close').addEventListener('click', closeApplicationEditor);
document.getElementById('app-editor-form').addEventListener('submit', saveApplicationEditor);

if (localStorage.getItem('careerOpsTheme') === 'dark') document.body.classList.add('dark');
initLiquidGlassPointer();

window.addEventListener('hashchange', () => {
  if (suppressHashRoute) {
    suppressHashRoute = false;
    return;
  }
  routeFromHash();
});

loadAll().then(() => {
  routeFromHash();
});

async function routeFromHash() {
  const hash = location.hash.replace('#', '');
  if (hash.startsWith('run/')) {
    await showRun(hash.split('/')[1], { updateHash: false });
    return;
  }
  routeTo(hash || 'dashboard', { updateHash: false });
}

async function loadAll() {
  const [jobs, applications, documents, discovery, sources, sourceLibrary, profile] = await Promise.all([
    api('/api/jobs'),
    api('/api/applications'),
    api('/api/documents'),
    api('/api/discovery/runs'),
    api('/api/job-sources'),
    api('/api/source-library'),
    api('/api/profile'),
  ]);
  state.jobs = jobs.jobs || [];
  state.applications = applications.applications || [];
  state.tracker = applications.tracker || [];
  state.documents = documents.documents || [];
  state.runs = jobs.runs || state.jobs.map((job) => job.latestRunId).filter(Boolean);
  state.discoveryRuns = discovery.discoveryRuns || [];
  state.jobSources = sources.jobSources || [];
  state.guidedSearches = sourceLibrary.guidedSearches || [];
  state.profile = profile;
  setDiscoveryDefaults();
  renderDiscoveryResumeSource();
  renderDashboard();
  renderJobs();
  renderDiscoveryJobs();
  renderApplications();
  renderDocuments();
  const runningDiscovery = state.discoveryRuns.find((run) => run.status === 'running');
  if (runningDiscovery && !discoveryPollTimer) pollDiscoveryRun(runningDiscovery.id);
}

async function submitJob(event) {
  event.preventDefault();
  const payload = {
    jobUrl: document.getElementById('job-url').value,
    jobDescription: document.getElementById('job-description').value,
    notes: document.getElementById('job-notes').value,
    generateResume: document.getElementById('generate-resume').checked,
    resumeMode: document.querySelector('input[name="resume-mode"]:checked')?.value || 'two_page',
    generateCoverLetter: document.getElementById('generate-cover-letter').checked,
    saveToTracker: document.getElementById('save-to-tracker').checked,
  };

  try {
    const response = await api('/api/jobs/analyze', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    showToast('Job run queued.');
    showRun(response.runId);
  } catch (error) {
    showToast(error.message);
  }
}

function routeTo(route, options = {}) {
  if (route === 'run' && currentRunId) return showRun(currentRunId);
  clearInterval(pollTimer);
  pollTimer = null;
  currentRunId = '';
  if (options.updateHash !== false && location.hash !== `#${route}`) {
    suppressHashRoute = true;
    location.hash = route;
  }
  document.querySelectorAll('.page').forEach((page) => page.classList.remove('active'));
  document.querySelectorAll('.nav button').forEach((button) => button.classList.toggle('active', button.dataset.route === route));
  document.getElementById(route)?.classList.add('active');
  document.getElementById('page-title').textContent = pages[route]?.[0] || 'EaZy Job Apply';
  document.getElementById('page-subtitle').textContent = pages[route]?.[1] || '';
  if (route === 'profile') loadProfile();
  if (route === 'settings') loadHealth();
  if (route === 'dashboard') loadAll();
}

async function showRun(runId, options = {}) {
  currentRunId = runId;
  if (options.updateHash !== false && location.hash !== `#run/${runId}`) {
    suppressHashRoute = true;
    location.hash = `run/${runId}`;
  }
  routeToWithoutHash('run');
  await renderRun(runId);
  clearInterval(pollTimer);
  pollTimer = setInterval(() => renderRun(runId), 3000);
}

function routeToWithoutHash(route) {
  document.querySelectorAll('.page').forEach((page) => page.classList.remove('active'));
  document.querySelectorAll('.nav button').forEach((button) => button.classList.toggle('active', false));
  document.getElementById(route)?.classList.add('active');
  document.getElementById('page-title').textContent = pages[route][0];
  document.getElementById('page-subtitle').textContent = pages[route][1];
}

async function renderRun(runId) {
  try {
    const data = await api(`/api/jobs/runs/${runId}`);
    const run = data.run;
    const result = run.result || {};
    const job = state.jobs.find((item) => item.id === run.jobId) || {};
    const terminal = ['completed', 'failed'].includes(run.status);
    if (terminal) {
      clearInterval(pollTimer);
      pollTimer = null;
      await loadAll();
    }
    document.getElementById('run-detail').innerHTML = `
      <div class="panel-head">
        <div>
          <h2>${escapeHtml(cleanDisplayText(result.resolvedCompany || result.company || 'Career-Ops Run'))} - ${escapeHtml(cleanDisplayText(result.resolvedTitle || result.title || run.status))}</h2>
          <span class="status ${run.status === 'failed' ? 'failed' : ''}">${escapeHtml(statusLabel(run.status))}</span>
        </div>
        <button class="secondary-btn" onclick="location.reload()">Refresh</button>
      </div>
      ${run.errorMessage ? `<p class="muted">${escapeHtml(run.errorMessage)}</p>` : ''}
      ${result.score ? `<div class="metric-grid">
        <article class="metric-card"><span>Score</span><strong>${escapeHtml(String(result.score))}/5</strong></article>
        <article class="metric-card"><span>Recommendation</span><strong>${escapeHtml(result.recommendation || 'Review')}</strong></article>
        <article class="metric-card"><span>Report</span><strong>${result.reportPath ? 'Ready' : 'Pending'}</strong></article>
        <article class="metric-card"><span>Resume</span><strong>${resumeArtifactStatus(result)}</strong></article>
      </div>` : ''}
      ${result.summary ? `<p>${escapeHtml(englishRunSummary(result))}</p>` : ''}
      ${result.resumePdfError ? `<div class="callout danger"><strong>Resume PDF blocked</strong><p>${escapeHtml(result.resumePdfError)}</p></div>` : ''}
      ${renderResumeQa(result.resumeQa)}
      ${renderTags('Matching Skills', result.matchingSkills)}
      ${renderTags('Missing Skills', result.missingSkills)}
      ${renderList('Risks', result.risks)}
      <div class="actions">
        ${result.reportPath ? `<a href="/files/${encodeURIComponent(result.reportPath)}" target="_blank">Open Report</a>` : ''}
        ${result.resumePdfPath ? `<a href="/files/${encodeURIComponent(result.resumePdfPath)}" target="_blank">Open Resume PDF</a>` : ''}
        ${result.resumePdfPath ? `<a href="/files/${encodeURIComponent(result.resumePdfPath)}" download>Download Resume</a>` : ''}
        ${result.resumeHtmlPath ? `<a href="/files/${encodeURIComponent(result.resumeHtmlPath)}" target="_blank">Open Resume HTML</a>` : ''}
        ${result.resumePdfErrorLogPath ? `<a href="/files/${encodeURIComponent(result.resumePdfErrorLogPath)}" target="_blank">PDF Error Log</a>` : ''}
        ${result.coverLetterPath ? `<a href="/files/${encodeURIComponent(result.coverLetterPath)}" target="_blank">Open Cover Letter</a>` : ''}
        ${result.logPath ? `<a href="/files/${encodeURIComponent(result.logPath)}" target="_blank">Open Log</a>` : ''}
        ${result.applyUrl ? `<a href="${escapeAttribute(result.applyUrl)}" target="_blank" rel="noreferrer">Open Apply Link</a>` : ''}
        ${run.status === 'completed' ? `<button onclick="saveApplication('${run.id}')">Save to Applications</button>` : ''}
        ${job.id ? `<button class="danger-action" onclick="rejectJob('${job.id}', '${run.id}')">Reject Job</button>` : ''}
      </div>
      <h3>Run Log</h3>
      <div class="list">${(run.logs || []).map((log) => `<div class="list-row"><span>${escapeHtml(log.message)}</span><span class="muted">${formatDate(log.at)}</span></div>`).join('')}</div>
    `;
  } catch (error) {
    clearInterval(pollTimer);
    pollTimer = null;
    document.getElementById('run-detail').innerHTML = `
      <div class="panel-head">
        <div>
          <h2>Run Detail Unavailable</h2>
          <span class="status failed">Needs Review</span>
        </div>
        <button class="secondary-btn" onclick="location.reload()">Refresh</button>
      </div>
      <p class="muted">${escapeHtml(error.message || 'Could not load this run. Return to Analyzed Jobs and open the latest run again.')}</p>
    `;
  }
}

function renderDashboard() {
  document.getElementById('metric-runs').textContent = state.runs.filter((run) => !run.hidden).length;
  document.getElementById('metric-recommended').textContent = discoveryJobs().filter((job) => jobBucket(job) === 'strong').length;
  document.getElementById('metric-needs-review').textContent = reviewNeededCount();
  document.getElementById('metric-followups').textContent = followupsDue().length;
  document.getElementById('metric-documents').textContent = state.documents.length;

  const nextActions = dashboardNextActions();
  document.getElementById('next-actions').innerHTML = nextActions.map((item) => `
    <div class="list-row">
      <div>
        <strong>${escapeHtml(item.title)}</strong>
        <div class="muted">${escapeHtml(item.detail)}</div>
      </div>
      <button class="secondary-btn" onclick="${item.runId ? `showRun('${item.runId}')` : `routeTo('${item.route}')`}">${escapeHtml(item.action)}</button>
    </div>
  `).join('') || '<p class="muted">You are clear for now. Run Discovery or add a job when ready.</p>';

  const rows = analyzedJobs().slice(0, 8).map((job) => `
    <div class="list-row">
      <div>
        <strong>${escapeHtml(cleanDisplayText(job.resolvedCompany || job.company || 'Unknown'))}</strong>
        <div class="muted">${escapeHtml(cleanDisplayText(job.resolvedTitle || job.title || 'Pending analysis'))}</div>
      </div>
      ${job.latestRunId ? `<button class="secondary-btn" onclick="showRun('${job.latestRunId}')">${escapeHtml(statusLabel(jobEffectiveStatus(job)))}</button>` : `<span class="status">${escapeHtml(statusLabel(jobEffectiveStatus(job)))}</span>`}
    </div>
  `).join('');
  document.getElementById('recent-runs').innerHTML = rows || '<p class="muted">No runs yet. Add a job to start.</p>';
}

function dashboardNextActions() {
  const actions = [];
  const strong = discoveryJobs().filter((job) => jobBucket(job) === 'strong').slice(0, 1);
  const needsReview = state.runs.find((run) => run.result?.resumeQa?.status && !/strong|ready/i.test(run.result.resumeQa.status));
  const due = followupsDue()[0];
  const failed = state.runs.find((run) => run.status === 'failed' && !run.hidden);
  if (strong.length) {
    actions.push({
      title: `${strong[0].resolvedCompany || strong[0].company || 'Company'} - ${strong[0].resolvedTitle || strong[0].title || 'Role'}`,
      detail: 'Strong Discovery match is ready to analyze.',
      route: 'discovery',
      action: 'Review',
    });
  }
  if (needsReview) {
    actions.push({
      title: 'Resume QA needs review',
      detail: needsReview.result?.title ? `${needsReview.result.title} at ${needsReview.result.company || 'company'}` : 'A tailored resume needs a manual check.',
      route: 'run',
      runId: needsReview.id,
      action: 'Open QA',
    });
  }
  if (due) {
    actions.push({
      title: `Follow up: ${due.company || 'Application'}`,
      detail: [due.title, shortDate(due.nextFollowUpAt)].filter(Boolean).join(' - '),
      route: 'applications',
      action: 'Track',
    });
  }
  if (failed) {
    actions.push({
      title: 'Run failed',
      detail: failed.errorMessage || 'Open the run detail for the friendly error and retry path.',
      route: 'run',
      runId: failed.id,
      action: 'Fix',
    });
  }
  if (!actions.length && !state.runs.length) {
    actions.push({
      title: 'Start with one job',
      detail: 'Paste a job link or description and generate a tailored resume/report.',
      route: 'add',
      action: 'Add Job',
    });
  }
  return actions.slice(0, 4);
}

function reviewNeededCount() {
  return state.runs.filter((run) => {
    const qa = run.result?.resumeQa;
    return qa && !/strong_match|ready/i.test(String(qa.status || ''));
  }).length;
}

function followupsDue() {
  const now = Date.now();
  const apps = [...state.applications, ...state.tracker.map((row) => ({
    id: `tracker-${row.number}`,
    company: row.company,
    title: row.role,
    nextFollowUpAt: row.overrideNextFollowUpAt,
  }))];
  return apps.filter((app) => {
    const due = Date.parse(app.nextFollowUpAt || '');
    return Number.isFinite(due) && due <= now;
  });
}

function renderJobs() {
  const search = document.getElementById('job-search')?.value?.toLowerCase() || '';
  const scoreMin = Number(document.getElementById('score-filter')?.value || 0);
  const jobs = analyzedJobs().filter((job) => {
    const text = `${job.title} ${job.company} ${job.sourceName || job.source || ''}`.toLowerCase();
    const score = Number(job.score || 0);
    return text.includes(search) && (!scoreMin || score >= scoreMin);
  });

  document.getElementById('job-board').innerHTML = jobs.map((job) => `
    <article class="job-card">
      <h3>${escapeHtml(cleanDisplayText(job.resolvedTitle || job.title || 'Pending analysis'))}</h3>
      <p class="muted">${escapeHtml(cleanDisplayText(job.resolvedCompany || job.company || 'Unknown company'))} ${job.sourceName || job.source ? `- ${escapeHtml(cleanDisplayText(job.sourceName || job.source))}` : ''}</p>
      <div class="tags">
        <span class="tag">${escapeHtml(bucketLabel(jobBucket(job)))}</span>
        <span class="tag">${escapeHtml(statusLabel(jobEffectiveStatus(job)))}</span>
        ${job.score ? `<span class="tag">${escapeHtml(String(job.score))}/5</span>` : ''}
        ${job.recommendation ? `<span class="tag">${escapeHtml(job.recommendation)}</span>` : ''}
      </div>
      <p>${escapeHtml(englishJobSummary(job))}</p>
      <div class="actions">
        ${job.latestRunId ? `<button onclick="showRun('${job.latestRunId}')">View Run</button>` : ''}
        <button onclick="editJob('${job.id}')">Edit</button>
        <button class="danger-action" onclick="rejectJob('${job.id}', '${job.latestRunId || ''}')">Reject</button>
        <button class="danger-action" onclick="deleteJob('${job.id}')">Archive</button>
        ${job.applyUrl ? `<a href="${escapeAttribute(job.applyUrl)}" target="_blank" rel="noreferrer">Apply</a>` : ''}
      </div>
    </article>
  `).join('') || '<p class="muted">No matching jobs yet.</p>';
}

function renderDiscoveryJobs() {
  const search = document.getElementById('discovery-search')?.value?.toLowerCase() || '';
  const bucket = document.getElementById('discovery-bucket-filter')?.value || '';
  const latestDiscovery = state.discoveryRuns[0];
  const sourceText = state.jobSources.length ? `${state.jobSources.filter((source) => source.enabled).length}/${state.jobSources.length} sources enabled` : 'No sources configured';
  document.getElementById('discovery-summary').textContent = latestDiscovery
    ? `Last targeted search: ${latestDiscovery.status} at ${formatDate(latestDiscovery.completedAt || latestDiscovery.updatedAt)}. ${sourceText}.`
    : `Enter a target job and find direct company postings from targeted ATS sources. ${sourceText}.`;
  document.getElementById('discovery-runs').innerHTML = state.discoveryRuns.slice(0, 3).map((run) => `
    <div class="list-row">
      <div>
        <strong>${escapeHtml(run.criteria?.query || 'Targeted search')} - ${escapeHtml(run.status || 'unknown')}</strong>
        <div class="muted">${escapeHtml(discoveryRunSummary(run))}</div>
      </div>
      <span class="muted">${escapeHtml(formatDate(run.completedAt || run.updatedAt || run.createdAt))}</span>
    </div>
  `).join('') || '<p class="muted">No discovery runs yet.</p>';

  const discovered = discoveryJobs().filter((job) => {
    const text = `${job.title} ${job.company} ${job.sourceName || job.source || ''}`.toLowerCase();
    const currentBucket = jobBucket(job);
    return text.includes(search) && (!bucket ? currentBucket !== 'skipped' : currentBucket === bucket);
  });
  const buckets = ['strong', 'maybe', 'new', 'skipped'];
  document.getElementById('discovery-buckets').innerHTML = buckets.map((key) => `
    <button class="${bucket === key ? 'active' : ''}" type="button" onclick="setDiscoveryBucket('${key}')">
      ${escapeHtml(bucketLabel(key))} <span>${discoveryJobs().filter((job) => jobBucket(job) === key).length}</span>
    </button>
  `).join('');

  document.getElementById('discovery-board').innerHTML = discovered.map((job) => `
    <article class="job-card">
      <h3>${escapeHtml(cleanDisplayText(job.resolvedTitle || job.title || 'Unknown role'))}</h3>
      <p class="muted">${escapeHtml(cleanDisplayText(job.resolvedCompany || job.company || 'Unknown company'))} ${job.sourceName || job.source ? `- ${escapeHtml(cleanDisplayText(job.sourceName || job.source))}` : ''}</p>
      <div class="tags">
        <span class="tag">${escapeHtml(bucketLabel(jobBucket(job)))}</span>
        <span class="tag">${escapeHtml(statusLabel(jobEffectiveStatus(job)))}</span>
        ${job.quickScore ? `<span class="tag">${escapeHtml(String(job.quickScore))}/100 quick</span>` : ''}
        <span class="tag">${escapeHtml(job.sourceTrust ? `${job.sourceTrust} trust` : sourceTrustLabel(job))}</span>
        ${['scrapegraph_local', 'scrapegraph_cloud'].includes(job.sourceType) ? '<span class="tag">AI extracted</span>' : ''}
        ${job.sourceType === 'scrapegraph_cloud' ? '<span class="tag">Cloud extraction</span>' : ''}
        ${['scrapegraph_local', 'scrapegraph_cloud'].includes(job.sourceType) && Number.isFinite(Number(job.extractionConfidence)) ? `<span class="tag">Confidence ${escapeHtml(String(Math.round(Number(job.extractionConfidence))))}%</span>` : ''}
        ${job.directApply ? '<span class="tag">Direct apply</span>' : '<span class="tag">Review link</span>'}
        ${job.freshness ? `<span class="tag">${escapeHtml(job.freshness)}</span>` : ''}
        ${job.remoteType ? `<span class="tag">${escapeHtml(job.remoteType)}</span>` : ''}
      </div>
      <p>${escapeHtml(discoveryCardSummary(job))}</p>
      ${matchFactorSummary(job) ? `<div class="score-factors">${matchFactorSummary(job).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
      ${job.matchReasons?.length ? `<div class="mini-meta">${job.matchReasons.slice(0, 4).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
      ${job.extractionWarnings?.length ? `<div class="mini-meta">${job.extractionWarnings.slice(0, 3).map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</div>` : ''}
      ${job.matchedSkills?.length ? `<div class="tags compact-tags">${job.matchedSkills.slice(0, 8).map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('')}</div>` : ''}
      ${job.missingSkills?.length ? `<div class="mini-meta"><span>Missing: ${escapeHtml(job.missingSkills.slice(0, 6).join(', '))}</span></div>` : ''}
      ${job.userFeedback?.action ? `<div class="mini-meta"><span>Your signal: ${escapeHtml(statusLabel(job.userFeedback.action) || job.userFeedback.action)}</span></div>` : ''}
      <div class="actions">
        <button onclick="markDiscoveryJob('${job.id}', 'save')">Save</button>
        <button onclick="markDiscoveryJob('${job.id}', 'interested')">Interested</button>
        <button onclick="analyzeExistingJob('${job.id}')">Analyze</button>
        <button onclick="editJob('${job.id}')">Edit</button>
        <button class="danger-action" onclick="markDiscoveryJob('${job.id}', 'hide_company')">Hide Company</button>
        <button class="danger-action" onclick="markDiscoveryJob('${job.id}', 'hide_similar_title')">Hide Similar</button>
        <button class="danger-action" onclick="skipJob('${job.id}')">Skip</button>
        <button class="danger-action" onclick="deleteJob('${job.id}')">Archive</button>
        ${job.applyUrl ? `<a href="${escapeAttribute(job.applyUrl)}" target="_blank" rel="noreferrer">${escapeHtml(applyLinkLabel(job))}</a>` : ''}
      </div>
    </article>
  `).join('') || '<p class="muted">No targeted 4/5+ discovery jobs yet. Enter a target job, run Find Matching Jobs, or add more direct ATS/company sources.</p>';
}

function renderApplications() {
  const apps = [...state.applications, ...state.tracker.map((row) => ({
    id: `tracker-${row.number}`,
    status: row.overrideStatus || normalizeTrackerStatus(row.status),
    company: row.company,
    title: row.role,
    score: row.score,
    recommendation: row.status,
    notes: row.overrideNotes || row.notes,
    recruiterName: row.overrideRecruiterName || '',
    recruiterEmail: row.overrideRecruiterEmail || '',
    contactUrl: row.overrideContactUrl || '',
    interviewStage: row.overrideInterviewStage || '',
    lastContactAt: row.overrideLastContactAt || '',
    appliedAt: row.overrideAppliedAt || row.date,
    nextFollowUpAt: row.overrideNextFollowUpAt,
    followUpNotes: row.overrideFollowUpNotes || '',
    outcomeReason: row.overrideOutcomeReason || '',
    resumePdfPath: row.pdf === 'Yes' ? 'tracker' : '',
    reportPath: row.report,
  }))];
  document.getElementById('kanban').innerHTML = applicationStatuses.map(([key, label]) => `
    <section class="kanban-col" data-status="${key}" ondragover="handleDragOver(event)" ondragleave="handleDragLeave(event)" ondrop="handleDrop(event, '${key}')">
      <h3>${label} <span>${apps.filter((app) => app.status === key).length}</span></h3>
      <div class="kanban-card-list">
      ${apps.filter((app) => app.status === key).map((app) => `
        <article class="kanban-card" draggable="true" ondragstart="handleDragStart(event, '${app.id}')">
          <strong>${escapeHtml(cleanDisplayText(app.company || 'Unknown'))}</strong>
          <p class="muted">${escapeHtml(cleanDisplayText(app.title || 'Role'))}</p>
          <div class="tags">
            ${app.score ? `<span class="tag">${escapeHtml(String(app.score))}</span>` : ''}
            ${app.recommendation ? `<span class="tag">${escapeHtml(app.recommendation)}</span>` : ''}
            ${app.resumePdfPath ? '<span class="tag">Resume</span>' : ''}
          </div>
          <div class="mini-meta">
            ${app.appliedAt ? `<span>Applied: ${escapeHtml(shortDate(app.appliedAt))}</span>` : ''}
            ${app.interviewStage ? `<span>Stage: ${escapeHtml(app.interviewStage)}</span>` : ''}
            ${app.recruiterName || app.recruiterEmail ? `<span>Contact: ${escapeHtml([app.recruiterName, app.recruiterEmail].filter(Boolean).join(' - '))}</span>` : ''}
            ${app.nextFollowUpAt ? `<span>Follow-up: ${escapeHtml(shortDate(app.nextFollowUpAt))}</span>` : ''}
          </div>
          ${applicationSummary(app) ? `<p>${escapeHtml(applicationSummary(app))}</p>` : ''}
          <div class="actions">
            <button onclick="quickMoveApplication('${app.id}', 'applied')">Mark Applied</button>
            <button onclick="editApplication('${app.id}')">Edit</button>
          </div>
        </article>
      `).join('') || '<p class="muted">Empty</p>'}
      </div>
    </section>
  `).join('');
}

function renderDocuments() {
  const search = document.getElementById('document-search')?.value?.toLowerCase() || '';
  const type = document.getElementById('document-type-filter')?.value || '';
  const docs = state.documents.filter((doc) => {
    const text = `${doc.displayName || ''} ${doc.fileName} ${doc.filePath} ${doc.type} ${doc.company || ''} ${doc.title || ''}`.toLowerCase();
    return (!type || doc.type === type) && (!search || text.includes(search));
  });
  const groups = groupByDocumentContext(docs);
  document.getElementById('documents-list').innerHTML = Object.entries(groups).map(([folder, files]) => `
    <section class="folder-card">
      <div class="folder-head">
        <div class="folder-icon">EZ</div>
        <div>
          <h3>${escapeHtml(folder)}</h3>
          <p class="muted">${files.length} file${files.length === 1 ? '' : 's'}</p>
        </div>
      </div>
      <div class="file-list">
        ${files.map((doc) => `
          <div class="file-row">
            <div>
              <strong>${escapeHtml(doc.displayName || doc.fileName || 'Document')}</strong>
              <span>${escapeHtml(documentTypeLabel(doc.type))}${doc.resumeMode ? ` - ${escapeHtml(resumeModeLabel(doc.resumeMode))}` : ''} - ${formatDate(doc.createdAt)}</span>
              ${['resume_pdf', 'resume_html'].includes(doc.type) && doc.qaStatus ? `<span>QA: ${escapeHtml(resumeQaLabel(doc.qaStatus))}${doc.qaScore ? ` (${escapeHtml(String(doc.qaScore))}/100)` : ''}</span>` : ''}
              ${(doc.company || doc.title) ? `<span>${escapeHtml(cleanDisplayText([doc.company, doc.title].filter(Boolean).join(' - ')))}</span>` : ''}
            </div>
            <div class="file-actions">
              <a href="/files/${encodeURIComponent(doc.filePath)}" target="_blank">${doc.type === 'resume_pdf' ? 'Preview PDF' : doc.type === 'resume_html' ? 'Preview HTML' : 'Open'}</a>
              ${doc.runId ? `<button onclick="showRun('${doc.runId}')">Run</button>` : ''}
              <button onclick="hideDocument('${encodeURIComponent(doc.filePath)}')">Remove</button>
            </div>
          </div>
        `).join('')}
      </div>
    </section>
  `).join('') || '<p class="muted">No documents found. Analyze a job with resume generation enabled to create tailored documents.</p>';
}

async function loadProfile() {
  const profile = await api('/api/profile');
  state.profile = profile;
  setProfileForm(profile.profilePreferences || {});
  document.getElementById('profile-text').textContent = profile.profileText || 'config/profile.yml not found';
  document.getElementById('cv-preview').textContent = profile.cvText || profile.cvPreview || 'cv.md not found';
  renderProfileSourceSummary(profile);
  renderDiscoveryResumeSource();
}

async function saveProfilePreferences(event) {
  event.preventDefault();
  const payload = getProfileForm();
  try {
    await api('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    });
    showToast('Profile preferences saved.');
  } catch (error) {
    showToast(error.message);
  }
}

function renderProfileSourceSummary(profile = state.profile || {}) {
  const source = profile.discoveryResumeSource || {};
  const snapshots = profile.resumeSnapshots || [];
  document.getElementById('profile-source-summary').innerHTML = `
    <div class="list-row"><strong>Primary resume</strong><span>${escapeHtml(profile.cvPath || 'cv.md')}</span></div>
    <div class="list-row"><strong>article-digest.md</strong><span>${profile.articleDigestExists ? 'Available for tailoring QA' : 'Not found'}</span></div>
    <div class="list-row"><strong>Discovery source</strong><span>${escapeHtml(resumeSourceLabel(source))}</span></div>
    <div class="list-row"><strong>Resume snapshots</strong><span>${escapeHtml(String(snapshots.length))}</span></div>
    <div class="list-row"><strong>Snapshot retention</strong><span>${profile.profilePreferences?.persistDiscoveryResumeSnapshots === 'false' ? 'Do not persist new pasted/uploaded resumes' : 'Persist new pasted/uploaded resumes locally'}</span></div>
    ${source.inferredRole ? `<div class="list-row"><strong>Inferred role</strong><span>${escapeHtml(source.inferredRole)}</span></div>` : ''}
    ${snapshots.length ? `<h3>Saved Discovery Resume Snapshots</h3><div class="compact-list">${snapshots.map((snapshot) => `
      <div class="list-row">
        <div>
          <strong>${escapeHtml(snapshot.label || snapshot.fileName || snapshot.source || 'Resume snapshot')}</strong>
          <div class="muted">${escapeHtml(`${snapshot.textLength || 0} chars${snapshot.inferredRole ? ` - ${snapshot.inferredRole}` : ''}`)}</div>
        </div>
        <button class="secondary-btn danger-action" type="button" onclick="deleteResumeSnapshot('${escapeAttribute(snapshot.id)}')">Delete</button>
      </div>
    `).join('')}</div>` : ''}
    ${profile.articleDigestPreview ? `<h3>article-digest.md Preview</h3><pre class="code-block small-code">${escapeHtml(profile.articleDigestPreview)}</pre>` : ''}
  `;
}

function renderDiscoveryResumeSource() {
  const target = document.getElementById('discovery-resume-source');
  if (!target) return;
  const text = document.getElementById('discovery-resume-text')?.value?.trim() || '';
  const file = document.getElementById('discovery-resume-file')?.files?.[0];
  if (text && file) target.textContent = `Using uploaded resume: ${file.name} (${text.length.toLocaleString()} characters parsed).`;
  else if (text) target.textContent = `Using pasted resume text (${text.length.toLocaleString()} characters).`;
  else target.textContent = 'Using Career-Ops cv.md until you upload or paste resume text.';
}

async function runDiscoveryNow(options = {}) {
  const button = options.fromResume ? document.getElementById('run-discovery-resume') : document.getElementById('run-discovery');
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Starting...';
  try {
    const resumeText = document.getElementById('discovery-resume-text').value.trim();
    const resumeFile = document.getElementById('discovery-resume-file').files?.[0];
    let query = document.getElementById('discovery-query').value.trim();
    if (!query && options.fromResume) {
      query = inferQueryFromResume(resumeText);
      if (query) document.getElementById('discovery-query').value = query;
    }
    const payload = {
      query,
      location: document.getElementById('discovery-location').value,
      minScore: Number(document.getElementById('discovery-min-score').value || 80),
      sourceScope: document.getElementById('discovery-source-scope').value,
      workMode: document.getElementById('discovery-work-mode').value,
      employmentType: document.getElementById('discovery-employment-type').value,
      sponsorship: document.getElementById('discovery-sponsorship').value,
      resumeText,
      resumeSource: resumeText ? (resumeFile ? 'uploaded' : 'pasted') : '',
      resumeFileName: resumeFile?.name || '',
      persistResumeSnapshot: document.getElementById('persist-discovery-resume')?.checked !== false,
    };
    if (!payload.query.trim() && !payload.resumeText.trim()) {
      payload.resumeSource = 'cv_md';
    }
    if (payload.query.trim()) localStorage.setItem('discoveryQuery', payload.query.trim());
    const response = await api('/api/discovery/run-now', { method: 'POST', body: JSON.stringify(payload) });
    const run = response.discoveryRun || {};
    showToast('Discovery started. Results will appear as sources finish.');
    await loadAll();
    routeTo('discovery');
    if (run.id) pollDiscoveryRun(run.id);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

function pollDiscoveryRun(runId) {
  clearInterval(discoveryPollTimer);
  discoveryPollTimer = setInterval(async () => {
    try {
      const response = await api(`/api/discovery/runs/${runId}`);
      const run = response.discoveryRun;
      const index = state.discoveryRuns.findIndex((item) => item.id === run.id);
      if (index >= 0) state.discoveryRuns[index] = run;
      else state.discoveryRuns.unshift(run);
      renderDiscoveryJobs();
      if (['completed', 'failed'].includes(run.status)) {
        clearInterval(discoveryPollTimer);
        discoveryPollTimer = null;
        await loadAll();
        showToast(discoveryRunSummary(run));
      }
    } catch (error) {
      clearInterval(discoveryPollTimer);
      discoveryPollTimer = null;
      showToast(error.message || 'Could not refresh discovery status.');
    }
  }, 2500);
}

async function loadDiscoveryResumeFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    showToast('Reading resume...');
    const data = await fileToDataUrl(file);
    const response = await api('/api/resume/parse', {
      method: 'POST',
      body: JSON.stringify({ fileName: file.name, mimeType: file.type, data }),
    });
    const text = response.text || '';
    document.getElementById('discovery-resume-text').value = text;
    document.getElementById('discovery-resume-source').textContent = `Using uploaded resume: ${file.name}`;
    const inferred = inferQueryFromResume(text);
    if (inferred && !document.getElementById('discovery-query').value.trim()) {
      document.getElementById('discovery-query').value = inferred;
    }
    showToast(`Resume loaded${inferred ? `; target inferred as ${inferred}` : ''}.`);
  } catch (error) {
    showToast(error.message);
  }
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the selected file.'));
    reader.readAsDataURL(file);
  });
}

function inferQueryFromResume(text) {
  const lower = String(text || '').toLowerCase();
  if (!lower.trim()) return '';
  const roles = [
    ['Data Engineer', ['data engineer', 'data engineering', 'etl', 'elt', 'spark', 'databricks', 'snowflake', 'data pipeline']],
    ['Analytics Engineer', ['analytics engineer', 'dbt', 'semantic layer', 'looker']],
    ['Data Analyst', ['data analyst', 'power bi', 'tableau', 'dashboard', 'reporting analyst']],
    ['Software Engineer', ['software engineer', 'full stack', 'frontend', 'backend', 'react', 'node.js']],
    ['Cloud Engineer', ['cloud engineer', 'devops', 'terraform', 'kubernetes', 'aws', 'azure']],
    ['Business Intelligence Engineer', ['business intelligence', 'bi engineer', 'power bi', 'looker']],
  ];
  const ranked = roles
    .map(([role, signals]) => ({ role, score: signals.reduce((sum, signal) => sum + (lower.includes(signal) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score ? ranked[0].role : '';
}

function setProfileForm(profile) {
  document.getElementById('pref-current-role').value = profile.currentRole || '';
  document.getElementById('pref-years').value = profile.yearsOfExperience || '';
  document.getElementById('pref-target-roles').value = profile.targetRoles || '';
  document.getElementById('pref-target-locations').value = profile.targetLocations || '';
  document.getElementById('pref-remote').value = profile.remotePreference || 'Remote';
  document.getElementById('pref-salary').value = profile.salaryExpectation || '';
  document.getElementById('pref-work-auth').value = profile.workAuthorization || '';
  document.getElementById('pref-skills').value = profile.preferredSkills || '';
  document.getElementById('pref-excluded').value = profile.excludedKeywords || '';
  document.getElementById('pref-watch').value = profile.companiesToWatch || '';
  document.getElementById('pref-avoid').value = profile.companiesToAvoid || '';
  document.getElementById('pref-industries').value = profile.preferredIndustries || '';
  document.getElementById('pref-proof-bank').value = profile.proofBank || '';
  document.getElementById('pref-discovery-query').value = profile.defaultDiscoveryQuery || '';
  document.getElementById('pref-discovery-location').value = profile.defaultDiscoveryLocation || '';
  document.getElementById('pref-discovery-source-scope').value = profile.defaultDiscoverySourceScope || 'balanced';
  document.getElementById('pref-discovery-min-score').value = profile.defaultDiscoveryMinScore || '80';
  document.getElementById('pref-daily-discovery').checked = profile.dailyDiscoveryEnabled === 'true';
  document.getElementById('pref-persist-resume-snapshots').checked = profile.persistDiscoveryResumeSnapshots !== 'false';
  const persistDiscovery = document.getElementById('persist-discovery-resume');
  if (persistDiscovery) persistDiscovery.checked = profile.persistDiscoveryResumeSnapshots !== 'false';
}

function getProfileForm() {
  return {
    currentRole: document.getElementById('pref-current-role').value,
    yearsOfExperience: document.getElementById('pref-years').value,
    targetRoles: document.getElementById('pref-target-roles').value,
    targetLocations: document.getElementById('pref-target-locations').value,
    remotePreference: document.getElementById('pref-remote').value,
    salaryExpectation: document.getElementById('pref-salary').value,
    workAuthorization: document.getElementById('pref-work-auth').value,
    preferredSkills: document.getElementById('pref-skills').value,
    excludedKeywords: document.getElementById('pref-excluded').value,
    companiesToWatch: document.getElementById('pref-watch').value,
    companiesToAvoid: document.getElementById('pref-avoid').value,
    preferredIndustries: document.getElementById('pref-industries').value,
    proofBank: document.getElementById('pref-proof-bank').value,
    defaultDiscoveryQuery: document.getElementById('pref-discovery-query').value,
    defaultDiscoveryLocation: document.getElementById('pref-discovery-location').value,
    defaultDiscoverySourceScope: document.getElementById('pref-discovery-source-scope').value,
    defaultDiscoveryMinScore: document.getElementById('pref-discovery-min-score').value,
    persistDiscoveryResumeSnapshots: document.getElementById('pref-persist-resume-snapshots').checked ? 'true' : 'false',
    dailyDiscoveryEnabled: document.getElementById('pref-daily-discovery').checked ? 'true' : 'false',
  };
}

async function loadHealth() {
  const health = await api('/api/health');
  const localAi = health.providers?.scrapegraphLocal || {};
  const cloudAi = health.providers?.scrapegraphCloud || {};
  document.getElementById('health').innerHTML = `
    <div class="list-row"><strong>Web App Root</strong><span>${escapeHtml(health.appRoot)}</span></div>
    <div class="list-row"><strong>Career-Ops Root</strong><span>${escapeHtml(health.careerOpsRoot)}</span></div>
    <div class="list-row"><strong>Node</strong><span>${escapeHtml(health.node)}</span></div>
    <div class="list-row"><strong>State Schema</strong><span>v${escapeHtml(String(health.schemaVersion || 2))}</span></div>
    <div class="list-row"><strong>Resume Snapshots</strong><span>${escapeHtml(String(health.resumeSnapshots || 0))}</span></div>
    <div class="list-row"><strong>Gemini API</strong><span>${health.geminiConfigured ? 'Configured' : 'Not configured; fallback analysis enabled'}</span></div>
    <div class="list-row"><strong>Gemini Model</strong><span>${escapeHtml(health.geminiModel || 'not set')}</span></div>
    <div class="list-row"><strong>Local AI Scraper</strong><span>${escapeHtml(localAi.message || 'Not checked')}</span></div>
    <div class="list-row"><strong>Ollama</strong><span>${localAi.ollamaReachable ? 'Reachable' : 'Not reachable'}${localAi.ollamaModel ? ` - ${escapeHtml(localAi.ollamaModel)}` : ''}</span></div>
    <div class="list-row"><strong>ScrapeGraph Cloud</strong><span>${escapeHtml(cloudAi.message || 'Not configured')} ${cloudAi.configured ? '- job page only' : ''}</span></div>
    ${(health.required || []).map((item) => `<div class="list-row"><strong>${escapeHtml(item.file)}</strong><span>${item.exists ? 'Ready' : 'Missing'}</span></div>`).join('')}
  `;
  renderSourceManager();
}

function renderSourceManager() {
  document.getElementById('automated-sources').innerHTML = state.jobSources.map((source) => `
    <article class="source-card">
      <div class="source-head">
        <div>
          <h3>${escapeHtml(source.name)}</h3>
          <p class="muted">${escapeHtml(source.category || source.type)}</p>
        </div>
        <label class="source-toggle">
          <input type="checkbox" ${source.enabled ? 'checked' : ''} onchange="toggleJobSource('${source.id}', this.checked)">
          <span>${source.enabled ? 'Enabled' : 'Off'}</span>
        </label>
      </div>
      <div class="tags">
        <span class="tag">${escapeHtml(source.trustLevel || 'Medium')} trust</span>
        <span class="tag">${escapeHtml(source.automation || 'Configured source')}</span>
        <span class="tag">Limit ${escapeHtml(String(source.limit || 0))}</span>
        ${['scrapegraph_local', 'scrapegraph_cloud'].includes(source.type) ? '<span class="tag">Review required</span>' : ''}
        ${source.type === 'scrapegraph_cloud' ? '<span class="tag">Cloud: job page only</span>' : ''}
      </div>
      <p>${escapeHtml(source.notes || '')}</p>
      ${['scrapegraph_local', 'scrapegraph_cloud'].includes(source.type) ? renderAiSourceConfig(source) : ''}
    </article>
  `).join('') || '<p class="muted">No automated sources configured.</p>';

  const grouped = groupBy(state.guidedSearches, (source) => source.category || 'Guided Search');
  document.getElementById('guided-searches').innerHTML = Object.entries(grouped).map(([category, sources]) => `
    <section class="source-group">
      <h3>${escapeHtml(category)}</h3>
      <div class="source-list">
        ${sources.map((source) => `
          <article class="source-card compact-source">
            <div class="source-head">
              <div>
                <strong>${escapeHtml(source.name)}</strong>
                <p class="muted">${escapeHtml(source.provider)} - ${escapeHtml(source.trustLevel)} trust</p>
              </div>
              <a href="${escapeAttribute(source.searchUrl)}" target="_blank" rel="noreferrer">Open Search</a>
            </div>
            <p>${escapeHtml(source.notes)}</p>
          </article>
        `).join('')}
      </div>
    </section>
  `).join('') || '<p class="muted">No guided searches found in Career-Ops portals.yml.</p>';
}

function renderAiSourceConfig(source) {
  const prefix = source.type === 'scrapegraph_cloud' ? 'cloud-ai' : 'local-ai';
  const label = source.type === 'scrapegraph_cloud' ? 'ScrapeGraph Cloud' : 'Local AI';
  return `
    <div class="source-config">
      <label>Approved seed URLs
        <textarea id="${prefix}-seeds" rows="4" placeholder="https://company.com/careers">${escapeHtml(source.seedUrls || '')}</textarea>
      </label>
      <div class="mini-fields">
        <label>Max pages
          <input id="${prefix}-max-pages" type="number" min="1" max="30" value="${escapeAttribute(String(source.maxPages || 8))}">
        </label>
        <label>Max jobs
          <input id="${prefix}-limit" type="number" min="1" max="50" value="${escapeAttribute(String(source.limit || 15))}">
        </label>
        <label>Timeout ms
          <input id="${prefix}-timeout" type="number" min="5000" max="300000" step="5000" value="${escapeAttribute(String(source.timeoutMs || 60000))}">
        </label>
      </div>
      <p class="hint">${source.type === 'scrapegraph_cloud' ? 'Cloud mode sends only approved public job/career page URLs to ScrapeGraphAI. Resume/profile data is not sent.' : 'Local mode runs on this machine when Python, ScrapeGraphAI, and Ollama are ready.'} LinkedIn, Indeed, Glassdoor, local/private URLs, and login pages are blocked.</p>
      <button class="secondary-btn fit-btn" type="button" onclick="saveAiSourceSettings('${source.id}', '${prefix}')">Save ${label} settings</button>
    </div>
  `;
}

window.toggleJobSource = async (sourceId, enabled) => {
  try {
    await api(`/api/job-sources/${sourceId}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled }),
    });
    await loadAll();
    if (location.hash.replace('#', '') === 'settings') renderSourceManager();
    showToast(enabled ? 'Source enabled.' : 'Source disabled.');
  } catch (error) {
    showToast(error.message);
  }
};

window.saveAiSourceSettings = async (sourceId, prefix) => {
  try {
    await api(`/api/job-sources/${sourceId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        seedUrls: document.getElementById(`${prefix}-seeds`)?.value || '',
        maxPages: document.getElementById(`${prefix}-max-pages`)?.value || '',
        limit: document.getElementById(`${prefix}-limit`)?.value || '',
        timeoutMs: document.getElementById(`${prefix}-timeout`)?.value || '',
      }),
    });
    await loadAll();
    renderSourceManager();
    showToast('AI scraper settings saved.');
  } catch (error) {
    showToast(error.message);
  }
};

window.deleteResumeSnapshot = async (snapshotId) => {
  if (!confirm('Delete this saved Discovery resume snapshot from local state?')) return;
  try {
    await api(`/api/resume/snapshots/${encodeURIComponent(snapshotId)}`, { method: 'DELETE' });
    await loadProfile();
    showToast('Resume snapshot deleted.');
  } catch (error) {
    showToast(error.message);
  }
};

async function exportStateBackup() {
  try {
    const redacted = document.getElementById('export-redacted')?.checked !== false;
    const data = await api(`/api/state/export${redacted ? '' : '?redacted=false'}`);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `eazy-job-apply-state-${new Date().toISOString().slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    showToast('State backup exported.');
  } catch (error) {
    showToast(error.message);
  }
}

async function importStateBackup(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (!confirm('Import this state backup? The current state will be backed up automatically first.')) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const result = await api('/api/state/import', { method: 'POST', body: JSON.stringify(payload) });
    await loadAll();
    showToast(`State imported: ${result.counts?.jobs || 0} jobs, ${result.counts?.applications || 0} applications.`);
  } catch (error) {
    showToast(error.message || 'Could not import this backup.');
  }
}

window.showRun = showRun;
window.setDiscoveryBucket = (bucket) => {
  const select = document.getElementById('discovery-bucket-filter');
  select.value = select.value === bucket ? '' : bucket;
  renderDiscoveryJobs();
};

window.analyzeExistingJob = async (jobId) => {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return showToast('Job not found.');
  try {
    const response = await api(`/api/jobs/${jobId}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ generateResume: true, resumeMode: 'two_page', generateCoverLetter: false, saveToTracker: true }),
    });
    showToast('Career-Ops analysis queued.');
    showRun(response.runId);
  } catch (error) {
    showToast(error.message);
  }
};

window.markDiscoveryJob = async (jobId, action) => {
  const labels = {
    save: 'saved',
    interested: 'marked interested',
    hide_company: 'hidden and company added to avoid list',
    hide_similar_title: 'hidden and similar title added to excluded keywords',
    archive: 'archived',
  };
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return showToast('Job not found.');
  if (['hide_company', 'hide_similar_title', 'archive'].includes(action)) {
    const ok = confirm(`Apply this Discovery preference to ${job.company || 'this company'} - ${job.title || 'this job'}?`);
    if (!ok) return;
  }
  try {
    await api(`/api/jobs/${jobId}/feedback`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    });
    await loadAll();
    showToast(`Discovery job ${labels[action] || 'updated'}.`);
  } catch (error) {
    showToast(error.message);
  }
};

window.skipJob = async (jobId) => {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return showToast('Job not found.');
  const reason = prompt('Skip reason', job.skipReason || 'Not a fit after review.');
  if (reason === null) return;
  await api(`/api/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'skipped', matchBucket: 'skipped', skipReason: reason.trim() }),
  });
  await loadAll();
  showToast('Job skipped.');
};

window.saveApplication = async (runId) => {
  try {
    await api('/api/applications', { method: 'POST', body: JSON.stringify({ runId }) });
    await loadAll();
    showToast('Saved to applications.');
  } catch (error) {
    showToast(error.message);
  }
};

window.editJob = async (jobId) => {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return showToast('Job not found.');
  const title = prompt('Job title', job.title || '');
  if (title === null) return;
  const company = prompt('Company', job.company || '');
  if (company === null) return;
  const location = prompt('Location', job.location || '');
  if (location === null) return;
  await api(`/api/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title: title.trim(), company: company.trim(), location: location.trim() }),
  });
  await loadAll();
  showToast('Job updated.');
};

window.deleteJob = async (jobId) => {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return showToast('Job not found.');
  if (!confirm(`Archive ${job.company || 'this company'} - ${job.title || 'this job'} from active views? Files stay on disk and this is reversible in state.json.`)) return;
  await api(`/api/jobs/${jobId}`, { method: 'DELETE' });
  await loadAll();
  showToast('Job archived from active views.');
};

window.rejectJob = async (jobId, runId = '') => {
  if (!confirm('Mark this job as rejected/skipped in the web app?')) return;
  await api(`/api/jobs/${jobId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'rejected', matchBucket: 'skipped', notes: 'Rejected by user review.', skipReason: 'Rejected by user review.' }),
  });
  await loadAll();
  if (runId) await showRun(runId);
  showToast('Job marked rejected.');
};

window.hideDocument = async (encodedPath) => {
  const filePath = decodeURIComponent(encodedPath);
  if (!confirm(`Remove ${filePath} from the documents list? The file will stay on disk.`)) return;
  await api(`/api/documents/${encodeURIComponent(filePath)}`, { method: 'DELETE' });
  await loadAll();
  showToast('Document hidden from list.');
};

window.handleDragStart = (event, appId) => {
  event.dataTransfer.setData('text/plain', appId);
  event.currentTarget.classList.add('dragging');
};

window.handleDragOver = (event) => {
  event.preventDefault();
  event.currentTarget.classList.add('drop-target');
};

window.handleDragLeave = (event) => {
  event.currentTarget.classList.remove('drop-target');
};

window.handleDrop = async (event, status) => {
  event.preventDefault();
  event.currentTarget.classList.remove('drop-target');
  const appId = event.dataTransfer.getData('text/plain');
  if (!appId) return;
  try {
    await api(`/api/applications/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, appliedAt: status === 'applied' ? new Date().toISOString() : undefined }),
    });
    await loadAll();
    showToast(`Moved to ${applicationStatuses.find(([key]) => key === status)?.[1] || status}.`);
  } catch (error) {
    showToast(error.message);
  }
};

window.quickMoveApplication = async (appId, status) => {
  try {
    await api(`/api/applications/${appId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, appliedAt: status === 'applied' ? new Date().toISOString() : undefined }),
    });
    await loadAll();
    showToast(`Moved to ${applicationStatuses.find(([key]) => key === status)?.[1] || status}.`);
  } catch (error) {
    showToast(error.message);
  }
};

window.editApplication = async (appId) => {
  const app = [...state.applications, ...state.tracker.map((row) => ({
    id: `tracker-${row.number}`,
    status: row.overrideStatus || normalizeTrackerStatus(row.status),
    company: row.company,
    title: row.role,
    notes: row.overrideNotes || row.notes || '',
    recruiterName: row.overrideRecruiterName || '',
    recruiterEmail: row.overrideRecruiterEmail || '',
    contactUrl: row.overrideContactUrl || '',
    interviewStage: row.overrideInterviewStage || '',
    lastContactAt: row.overrideLastContactAt || '',
    nextFollowUpAt: row.overrideNextFollowUpAt || '',
    followUpNotes: row.overrideFollowUpNotes || '',
    outcomeReason: row.overrideOutcomeReason || '',
    appliedAt: row.overrideAppliedAt || '',
  }))].find((item) => item.id === appId);
  if (!app) return showToast('Application not found.');
  openApplicationEditor(app);
};

function openApplicationEditor(app) {
  editingApplicationId = app.id;
  document.getElementById('app-editor-context').textContent = [app.company, app.title].filter(Boolean).join(' - ') || 'Application';
  document.getElementById('edit-app-status').innerHTML = applicationStatuses
    .map(([key, label]) => `<option value="${key}">${label}</option>`)
    .join('');
  document.getElementById('edit-app-status').value = app.status || 'saved';
  document.getElementById('edit-app-stage').value = app.interviewStage || '';
  document.getElementById('edit-app-recruiter').value = app.recruiterName || '';
  document.getElementById('edit-app-email').value = app.recruiterEmail || '';
  document.getElementById('edit-app-contact-url').value = app.contactUrl || '';
  document.getElementById('edit-app-applied').value = shortDate(app.appliedAt);
  document.getElementById('edit-app-last-contact').value = shortDate(app.lastContactAt);
  document.getElementById('edit-app-follow-up').value = shortDate(app.nextFollowUpAt);
  document.getElementById('edit-app-notes').value = app.notes || '';
  document.getElementById('edit-app-follow-up-notes').value = app.followUpNotes || '';
  document.getElementById('edit-app-outcome').value = app.outcomeReason || '';
  document.getElementById('app-editor').hidden = false;
}

function closeApplicationEditor() {
  editingApplicationId = '';
  document.getElementById('app-editor').hidden = true;
}

async function saveApplicationEditor(event) {
  event.preventDefault();
  if (!editingApplicationId) return;
  const dateOrEmpty = (id) => {
    const value = document.getElementById(id).value;
    return value ? new Date(`${value}T09:00:00`).toISOString() : '';
  };
  try {
    await api(`/api/applications/${editingApplicationId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        status: document.getElementById('edit-app-status').value,
        interviewStage: document.getElementById('edit-app-stage').value.trim(),
        recruiterName: document.getElementById('edit-app-recruiter').value.trim(),
        recruiterEmail: document.getElementById('edit-app-email').value.trim(),
        contactUrl: document.getElementById('edit-app-contact-url').value.trim(),
        appliedAt: dateOrEmpty('edit-app-applied'),
        lastContactAt: dateOrEmpty('edit-app-last-contact'),
        nextFollowUpAt: dateOrEmpty('edit-app-follow-up'),
        notes: document.getElementById('edit-app-notes').value.trim(),
        followUpNotes: document.getElementById('edit-app-follow-up-notes').value.trim(),
        outcomeReason: document.getElementById('edit-app-outcome').value.trim(),
      }),
    });
    closeApplicationEditor();
    await loadAll();
    showToast('Application updated.');
  } catch (error) {
    showToast(error.message);
  }
}

function renderTags(title, items = []) {
  if (!items?.length) return '';
  return `<h3>${title}</h3><div class="tags">${items.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('')}</div>`;
}

function renderList(title, items = []) {
  if (!items?.length) return '';
  return `<h3>${title}</h3><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderResumeQa(qa) {
  if (!qa) return '';
  const label = {
    strong_match: 'Strong Match',
    review_recommended: 'Review Recommended',
    needs_review: 'Needs Review',
  }[qa.status] || 'Review';
  return `
    <h3>Resume Tailoring QA</h3>
    <div class="metric-grid">
      <article class="metric-card"><span>Resume QA</span><strong>${escapeHtml(String(qa.score ?? 0))}/100</strong></article>
      <article class="metric-card"><span>Status</span><strong>${escapeHtml(label)}</strong></article>
      <article class="metric-card"><span>Digest Points</span><strong>${escapeHtml(`${qa.articleDigestBulletCount || 0}/${qa.articleDigestCandidateCount || 0}`)}</strong></article>
    </div>
    ${qa.summary ? `<p class="muted">${escapeHtml(qa.summary)}</p>` : ''}
    ${renderTags('Resume Matched JD Terms', qa.matchedTerms)}
    ${renderTags('Resume Missing JD Terms', qa.missingTerms)}
    ${renderList('article-digest.md Bullets Used', qa.usedDigestBullets)}
    ${renderTags('Suspicious Resume Phrases', qa.suspiciousPhrases)}
    ${renderTags('Repeated Resume Metrics', qa.repeatedMetrics)}
    ${renderTags('Unsupported Claim Checks', qa.unsupportedClaims)}
    ${renderList('Resume QA Checks', qa.checks)}
  `;
}

function normalizeTrackerStatus(status = '') {
  const lower = status.toLowerCase();
  if (lower.includes('applied')) return 'applied';
  if (lower.includes('apply')) return 'applied';
  if (lower.includes('interview') || lower.includes('screen')) return 'recruiter_screen';
  if (lower.includes('offer')) return 'offer';
  if (lower.includes('reject')) return 'rejected';
  if (lower.includes('resume')) return 'resume_ready';
  return 'saved';
}

function jobEffectiveStatus(job = {}) {
  const run = state.runs.find((item) => item.id === job.latestRunId);
  if (run?.status === 'failed') return 'failed';
  if (run?.status === 'completed') return run.result?.resumePdfPath ? 'resume_ready' : 'analyzed';
  if (['queued', 'running', 'fetching_job', 'analyzing', 'generating_resume'].includes(run?.status)) return 'analyzing';
  return job.status || 'saved';
}

function statusLabel(status = '') {
  return {
    queued: 'Queued',
    running: 'Running',
    fetching_job: 'Fetching Job',
    analyzing: 'Analyzing',
    generating_resume: 'Generating Resume',
    completed: 'Completed',
    analyzed: 'Analyzed',
    resume_ready: 'Resume Ready',
    needs_review: 'Needs Review',
    saved: 'Saved',
    save: 'Saved',
    interested: 'Interested',
    hide_company: 'Hidden company',
    hide_similar_title: 'Hidden similar title',
    discovered: 'Discovered',
    skipped: 'Skipped',
    rejected: 'Rejected',
    failed: 'Failed',
    applied: 'Applied',
    recruiter_screen: 'Recruiter Screen',
    technical_round: 'Technical Round',
    final_round: 'Final Round',
    offer: 'Offer',
    archived: 'Archived',
  }[status] || cleanDisplayText(status).replace(/_/g, ' ') || 'Saved';
}

function resumeQaLabel(status = '') {
  return {
    strong_match: 'Ready',
    review_recommended: 'Needs Review',
    needs_review: 'Needs Review',
  }[status] || cleanDisplayText(status).replace(/_/g, ' ') || 'Review';
}

function resumeArtifactStatus(result = {}) {
  if (result.resumePdfPath) return 'PDF Ready';
  if (result.resumeHtmlPath) return 'HTML Ready';
  if (result.resumePdfError) return 'PDF Blocked';
  return 'Pending';
}

function documentTypeLabel(type = '') {
  return {
    original_resume: 'Original Resume',
    resume_pdf: 'Tailored Resume PDF',
    resume_html: 'Tailored Resume HTML',
    resume_pdf_error: 'PDF Error Log',
    career_ops_report: 'Career-Ops Report',
    cover_letter: 'Cover Letter',
  }[type] || cleanDisplayText(type).replace(/_/g, ' ') || 'Document';
}

function groupByFolder(docs) {
  return docs.reduce((groups, doc) => {
    const parts = String(doc.filePath || '').split(/[\\/]/);
    const folder = parts.length > 1 ? parts.slice(0, -1).join('/') : 'Root';
    groups[folder] ||= [];
    groups[folder].push(doc);
    return groups;
  }, {});
}

function groupByDocumentContext(docs) {
  return docs.reduce((groups, doc) => {
    const company = cleanDisplayText(doc.company || '');
    const title = cleanDisplayText(doc.title || '');
    const run = doc.runId ? `Run ${doc.runId.slice(-6)}` : '';
    const key = company || title
      ? [company, title].filter(Boolean).join(' - ')
      : doc.type === 'original_resume' ? 'Original Resume' : (run || 'Other Documents');
    groups[key] ||= [];
    groups[key].push(doc);
    return groups;
  }, {});
}

function resumeModeLabel(mode = '') {
  if (mode === 'one_page') return '1-page ATS';
  if (mode === 'two_page') return '2-page detailed';
  return cleanDisplayText(mode).replace(/_/g, ' ');
}

function resumeSourceLabel(source = {}) {
  const label = source.label || source.fileName || '';
  if (source.source === 'uploaded') return `Uploaded resume${label ? ` - ${label}` : ''}`;
  if (source.source === 'pasted') return `Pasted resume text${source.textLength ? ` - ${Number(source.textLength).toLocaleString()} characters` : ''}`;
  if (source.source === 'cv_md') return `Career-Ops cv.md${source.textLength ? ` - ${Number(source.textLength).toLocaleString()} characters` : ''}`;
  return label || 'Career-Ops cv.md';
}

function groupBy(items, keyFn) {
  return (items || []).reduce((groups, item) => {
    const key = keyFn(item);
    groups[key] ||= [];
    groups[key].push(item);
    return groups;
  }, {});
}

function scrollKanban(direction) {
  const kanban = document.getElementById('kanban');
  kanban.scrollBy({ left: direction * Math.max(320, kanban.clientWidth * 0.8), behavior: 'smooth' });
}

function englishJobSummary(job) {
  const run = state.runs.find((item) => item.id === job.latestRunId);
  const result = run?.result || {};
  return englishSummary({
    company: job.company || result.company,
    title: job.title || result.title,
    score: job.score || result.score,
    recommendation: job.recommendation || result.recommendation,
    summary: job.summary || result.summary,
  });
}

function discoveryCardSummary(job = {}) {
  const company = cleanDisplayText(job.resolvedCompany || job.company || 'the company');
  const title = cleanDisplayText(job.resolvedTitle || job.title || 'this role');
  const score = Number(job.quickScore || job.score || 0);
  const reasons = (job.matchReasons?.length ? job.matchReasons : job.quickScoreBreakdown || [])
    .map(cleanDisplayText)
    .filter(Boolean)
    .filter((reason) => job.directApply || !/direct apply link available|company or ats apply link/i.test(reason))
    .slice(0, 3);
  const applyText = job.directApply ? 'Direct company apply link is available.' : 'Review the job link before applying.';
  const scoreText = score ? ` Match score: ${score}/100.` : '';
  return `Discovered ${title} at ${company}.${scoreText}${reasons.length ? ` Reasons: ${reasons.join('; ')}.` : ''} ${applyText}`;
}

function applicationSummary(app = {}) {
  const notes = cleanDisplayText(app.notes || '');
  if (notes && !looksLikeNonEnglishReport(notes) && !looksLikeGenericRunSummary(notes)) return notes;
  if (!app.company && !app.title && !app.score && !app.recommendation) return '';
  return englishSummary({
    company: app.company,
    title: app.title,
    score: app.score,
    recommendation: app.recommendation,
    summary: '',
  });
}

function englishRunSummary(result) {
  return englishSummary({
    company: result.company,
    title: result.title,
    score: result.score,
    recommendation: result.recommendation,
    summary: result.summary,
  });
}

function discoveryRunSummary(run) {
  const stats = run?.stats || {};
  if (!run) return 'Discovery run not available.';
  if (run.status === 'running') return 'Discovery is running in the background. Results will appear here when sources finish.';
  if (run.status === 'failed') return run.errorMessage || 'Discovery failed.';
  const imported = Number(stats.imported || 0);
  const refreshed = Number(stats.refreshed || 0);
  const duplicates = Number(stats.duplicates || run.duplicateCount || 0);
  const rawFound = Number(stats.rawFound || 0);
  const filtered = Number(stats.filtered || 0);
  const qualified = Number(stats.qualified || imported + refreshed);
  const errors = Number(stats.errors || 0);
  return `Found ${rawFound}, qualified ${qualified}, filtered ${filtered}, imported ${imported}, refreshed ${refreshed}, skipped ${duplicates} duplicates${errors ? `, ${errors} source error${errors === 1 ? '' : 's'}` : ''}.`;
}

function setDiscoveryDefaults() {
  const query = document.getElementById('discovery-query');
  const location = document.getElementById('discovery-location');
  const minScore = document.getElementById('discovery-min-score');
  const sourceScope = document.getElementById('discovery-source-scope');
  const workMode = document.getElementById('discovery-work-mode');
  const employmentType = document.getElementById('discovery-employment-type');
  const sponsorship = document.getElementById('discovery-sponsorship');
  const prefs = state.profile?.profilePreferences || {};
  if (query && !query.value) query.value = localStorage.getItem('discoveryQuery') || prefs.defaultDiscoveryQuery || inferDefaultTargetRole();
  if (location && !location.value) location.value = normalizedStoredLocation() || prefs.defaultDiscoveryLocation || 'United States';
  if (minScore && !minScore.value) minScore.value = localStorage.getItem('discoveryMinScore') || prefs.defaultDiscoveryMinScore || '80';
  if (sourceScope && !sourceScope.value) sourceScope.value = normalizedStoredSourceScope() || prefs.defaultDiscoverySourceScope || 'balanced';
  if (workMode && !workMode.value) workMode.value = localStorage.getItem('discoveryWorkMode') || '';
  if (employmentType && !employmentType.value) employmentType.value = localStorage.getItem('discoveryEmploymentType') || '';
  if (sponsorship && !sponsorship.value) sponsorship.value = localStorage.getItem('discoverySponsorship') || '';
  query?.addEventListener('change', () => localStorage.setItem('discoveryQuery', query.value));
  location?.addEventListener('change', () => localStorage.setItem('discoveryLocation', location.value));
  minScore?.addEventListener('change', () => localStorage.setItem('discoveryMinScore', minScore.value));
  sourceScope?.addEventListener('change', () => localStorage.setItem('discoverySourceScope', sourceScope.value));
  workMode?.addEventListener('change', () => localStorage.setItem('discoveryWorkMode', workMode.value));
  employmentType?.addEventListener('change', () => localStorage.setItem('discoveryEmploymentType', employmentType.value));
  sponsorship?.addEventListener('change', () => localStorage.setItem('discoverySponsorship', sponsorship.value));
}

function normalizedStoredSourceScope() {
  const stored = localStorage.getItem('discoverySourceScope') || '';
  if (!stored || stored === 'trusted' || stored === 'boards') return 'balanced';
  return stored;
}

function normalizedStoredLocation() {
  const stored = localStorage.getItem('discoveryLocation') || '';
  if (!stored) return '';
  if (stored === 'United States, Remote') return 'United States';
  return stored;
}

function inferDefaultTargetRole() {
  const analyzed = analyzedJobs().find((job) => /data engineer/i.test(job.title || ''));
  return analyzed?.title || 'Senior Data Engineer';
}

function analyzedJobs() {
  return uniqueJobsByCanonicalUrl(state.jobs.filter((job) => isAnalyzedJob(job)));
}

function discoveryJobs() {
  const enabledSourceTypes = new Set(state.jobSources.filter((source) => source.enabled).map((source) => source.type));
  if (enabledSourceTypes.has('career_ops_ats')) {
    enabledSourceTypes.add('greenhouse');
    enabledSourceTypes.add('ashby');
    enabledSourceTypes.add('lever');
  }
  if (enabledSourceTypes.has('curated_direct_ats')) {
    enabledSourceTypes.add('greenhouse');
    enabledSourceTypes.add('ashby');
    enabledSourceTypes.add('lever');
  }
  const visibleSourceTypes = discoverySourceTypesForScope(document.getElementById('discovery-source-scope')?.value || 'balanced');
  return uniqueJobsByCanonicalUrl(state.jobs.filter((job) => {
    if (isAnalyzedJob(job)) return false;
    if (job.sourceType && !enabledSourceTypes.has(job.sourceType)) return false;
    if (job.sourceType && visibleSourceTypes && !visibleSourceTypes.has(job.sourceType)) return false;
    if (!displayTitleCompatible(job)) return false;
    if (!displayLocationCompatible(job)) return false;
    if (!displayWorkModeCompatible(job)) return false;
    if (!displayEmploymentCompatible(job)) return false;
    if (!displaySponsorshipCompatible(job)) return false;
    if (Number(job.quickScore || 0) < Number(document.getElementById('discovery-min-score')?.value || 80)) return false;
    return true;
  }));
}

function displayTitleCompatible(job) {
  const query = String(document.getElementById('discovery-query')?.value || '').toLowerCase();
  const title = String(job.title || '').toLowerCase();
  if (!query || !title) return true;
  if (/data engineer|analytics engineer|business intelligence|data analyst/.test(query)) {
    if (/\b(product manager|program manager|project manager|copywriter|writer|sales|account executive|recruiter|marketing|designer|ios developer|frontend|front end|mobile engineer)\b/.test(title)) return false;
    return /\b(data|analytics|bi|business intelligence|etl|elt|warehouse)\b/.test(title)
      && /\b(engineer|analyst|developer|architect)\b/.test(title);
  }
  return title.includes(query) || query.split(/\s+/).filter((word) => word.length > 2).some((word) => title.includes(word));
}

function uniqueJobsByCanonicalUrl(jobs = []) {
  const seen = new Set();
  const result = [];
  for (const job of jobs) {
    const key = canonicalJobKey(job);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(job);
  }
  return result;
}

function canonicalJobKey(job = {}) {
  const raw = String(job.canonicalUrl || job.applyUrl || job.jobUrl || '').trim();
  if (!raw) return String(job.id || '').toLowerCase();
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|src|gh_src|lever-origin|iis|iisn|gh_jid|t)$/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, '');
  }
}

function displayLocationCompatible(job) {
  const wanted = String(document.getElementById('discovery-location')?.value || '').toLowerCase();
  const location = String(job.location || '').toLowerCase();
  if (!wanted || !location) return true;
  const wantsUs = /\b(united states|usa|u s|us|dallas|texas|tx|california|new york)\b/.test(wanted);
  if (!wantsUs) return true;
  if (/\bremote\b/.test(wanted) && /\b(remote|united states|usa|us only|u s)\b/.test(location)) return true;
  const nonUsSignals = ['canada', 'toronto', 'vancouver', 'brazil', 'sao paulo', 'são paulo', 'ukraine', 'india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai', 'delhi', 'gurgaon', 'mexico', 'europe', 'germany', 'berlin', 'france', 'paris', 'spain', 'united kingdom', 'london', 'ireland', 'dublin', 'netherlands', 'amsterdam', 'poland', 'singapore', 'australia', 'argentina', 'colombia'];
  return !nonUsSignals.some((signal) => location.includes(signal));
}

function displayWorkModeCompatible(job) {
  const wanted = String(document.getElementById('discovery-work-mode')?.value || '').toLowerCase();
  if (!wanted) return true;
  const text = `${job.remoteType || ''} ${job.location || ''} ${job.description || ''}`.toLowerCase();
  if (wanted === 'remote') return /\b(remote|work from home|wfh)\b/.test(text);
  if (wanted === 'hybrid') return /\b(hybrid|office|onsite|on-site|days in office)\b/.test(text) && !/\bfully remote\b/.test(text);
  if (wanted === 'onsite') return /\b(onsite|on-site|in office|office-based)\b/.test(text) && !/\bremote\b/.test(text);
  return true;
}

function displayEmploymentCompatible(job) {
  const wanted = String(document.getElementById('discovery-employment-type')?.value || '').toLowerCase();
  if (!wanted) return true;
  const text = `${job.employmentType || ''} ${job.title || ''} ${job.description || ''}`.toLowerCase();
  if (wanted === 'full_time') return /\b(full.time|fulltime|permanent|regular)\b/.test(text) || !/\b(contract|contractor|temporary|part.time|internship)\b/.test(text);
  if (wanted === 'contract') return /\b(contract|contractor|temporary|c2c|w2)\b/.test(text);
  return true;
}

function displaySponsorshipCompatible(job) {
  const wanted = String(document.getElementById('discovery-sponsorship')?.value || '').toLowerCase();
  if (!wanted) return true;
  const text = `${job.title || ''} ${job.company || ''} ${job.description || ''}`.toLowerCase();
  const noSponsor = /\b(no sponsorship|unable to sponsor|cannot sponsor|not sponsor|without sponsorship|must be authorized to work.*without|will not sponsor)\b/.test(text);
  const sponsorMention = /\b(sponsor|sponsorship|h-?1b|visa|work authorization|green card|uscis)\b/.test(text);
  if (wanted === 'avoid_no_sponsor') return !noSponsor;
  if (wanted === 'sponsor_only') return sponsorMention && !noSponsor;
  if (wanted === 'no_sponsorship_needed') return true;
  return true;
}

function discoverySourceTypesForScope(scope) {
  const aliases = {
    direct: ['career_ops_ats', 'career_ops_pipeline', 'greenhouse', 'ashby', 'lever'],
    balanced: ['career_ops_ats', 'career_ops_pipeline', 'curated_direct_ats', 'greenhouse', 'ashby', 'lever', 'themuse', 'arbeitnow', 'adzuna'],
    mixed_boards: ['themuse', 'arbeitnow', 'adzuna'],
    remote_boards: ['himalayas', 'remotejobs_org', 'remotive'],
    local_ai: ['scrapegraph_local', 'scrapegraph_cloud'],
    ai_local_only: ['scrapegraph_local'],
    ai_cloud_only: ['scrapegraph_cloud'],
  };
  if (scope === 'all' || scope === 'trusted' || scope === 'boards') return null;
  return new Set(aliases[scope] || aliases.balanced);
}

function isAnalyzedJob(job) {
  return Boolean(job.latestRunId)
    || ['analyzing', 'resume_ready', 'completed', 'failed'].includes(job.status)
    || Boolean(job.score || job.recommendation);
}

function jobBucket(job) {
  if (job.matchBucket) return job.matchBucket;
  if (['rejected', 'skipped'].includes(job.status)) return 'skipped';
  if (job.latestRunId || ['completed', 'resume_ready'].includes(job.status)) return 'analyzed';
  if (Number(job.quickScore) >= 80) return 'strong';
  if (Number(job.quickScore) >= 55) return 'maybe';
  return 'new';
}

function bucketLabel(bucket) {
  return {
    new: 'New',
    strong: 'Strong',
    maybe: 'Maybe',
    analyzed: 'Analyzed',
    skipped: 'Skipped',
    duplicate: 'Duplicate',
  }[bucket] || cleanDisplayText(bucket || 'New');
}

function matchFactorSummary(job) {
  const factors = job.matchScoreFactors || {};
  const labels = [
    ['role', 'Role'],
    ['skills', 'Skills'],
    ['semantic', 'Resume'],
    ['source', 'Source'],
    ['applyLink', 'Apply'],
    ['freshness', 'Fresh'],
  ];
  return labels
    .filter(([key]) => Number.isFinite(Number(factors[key])) && Number(factors[key]) !== 0)
    .map(([key, label]) => `${label} ${Number(factors[key]) > 0 ? '+' : ''}${Number(factors[key])}`)
    .slice(0, 6);
}

function applyLinkLabel(job) {
  const url = String(job.applyUrl || job.jobUrl || '');
  if (/greenhouse|lever\.co|ashbyhq|workdayjobs|jobvite|smartrecruiters|icims/i.test(url)) return 'Apply on Company Site';
  return 'Open Job Link';
}

function sourceTrustLabel(job) {
  const source = state.jobSources.find((item) => item.type === job.sourceType || item.id === job.sourceId);
  if (source?.trustLevel) return `${source.trustLevel} trust`;
  if (['greenhouse', 'lever', 'ashby', 'career_ops_ats'].includes(job.sourceType)) return 'High trust';
  if (job.sourceType === 'career_ops_pipeline') return 'Medium trust';
  return 'Review source';
}

function englishSummary({ company, title, score, recommendation, summary }) {
  const cleanSummary = cleanDisplayText(summary || '');
  if (cleanSummary && !looksLikeNonEnglishReport(cleanSummary) && !looksLikeGenericRunSummary(cleanSummary)) return cleanSummary;
  const companyText = cleanDisplayText(company || 'the company');
  const titleText = cleanDisplayText(title || 'this role');
  const recommendationText = normalizeRecommendation(recommendation);
  const scoreText = normalizedScoreText(score);
  return `Career-Ops completed the evaluation for ${titleText} at ${companyText}.${scoreText} Recommendation: ${recommendationText}. Open the run detail to review matching skills, gaps, risks, report, resume PDF, and apply link.`;
}

function normalizedScoreText(score) {
  const text = cleanDisplayText(score || '');
  if (!text) return '';
  if (/\/5$/.test(text)) return ` Score: ${text}.`;
  return ` Score: ${text}/5.`;
}

function normalizeRecommendation(value) {
  const text = cleanDisplayText(value || '');
  return /^(Apply|Review|Maybe|Skip)$/i.test(text) ? text : 'Review';
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
    || text.includes('legitimacy:')
    || text.includes('pdf: pending')
    || /date:\s*\d{8}/i.test(text);
}

function looksLikeNonEnglishReport(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('dimensi')
    || text.includes('detalle')
    || text.includes('descripcion')
    || text.includes('arquetipo')
    || text.includes('dominio')
    || text.includes('funci')
    || text.includes('remoto')
    || text.includes('hibrido')
    || text.includes('tamano')
    || text.includes('tama')
    || text.includes('construir')
    || text.includes('operar')
    || text.includes('enfasis')
    || text.includes('seccion')
    || text.includes('por que');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.hidden = false;
  setTimeout(() => { toast.hidden = true; }, 3600);
}

function initLiquidGlassPointer() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const selector = '.panel, .metric-card, .job-card, .document-card, .kanban-col, .folder-card';
  let active = null;
  let frame = 0;
  document.addEventListener('pointermove', (event) => {
    const target = event.target.closest?.(selector);
    if (!target) return;
    active = { target, x: event.clientX, y: event.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!active) return;
      const rect = active.target.getBoundingClientRect();
      active.target.style.setProperty('--mx', `${Math.round(((active.x - rect.left) / rect.width) * 100)}%`);
      active.target.style.setProperty('--my', `${Math.round(((active.y - rect.top) / rect.height) * 100)}%`);
    });
  }, { passive: true });
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString();
}

function shortDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return cleanDisplayText(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, '&quot;');
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
