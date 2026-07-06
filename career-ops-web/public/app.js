const pages = {
  dashboard: ['Dashboard', "Review today's jobs, runs, documents, and next actions."],
  add: ['Add Job', 'Paste a job link, optional JD text, and start a background Career-Ops run.'],
  jobs: ['Analyzed Jobs', 'Review jobs that already ran through Career-Ops analysis.'],
  scanner: ['Scanner Inbox', 'Review jobs saved by Career-Ops scan before analysis.'],
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

let state = { jobs: [], runs: [], applications: [], documents: [], tracker: [], profile: null, scanner: { rows: [], counts: {}, health: {} } };
let currentRunId = '';
let pollTimer = null;
let suppressHashRoute = false;
let editingApplicationId = '';
const openedDocumentGroups = new Set();

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
document.getElementById('generate-resume').addEventListener('change', updateResumeProfileControlState);
document.getElementById('profile-resume-select').addEventListener('change', (event) => loadProfile(event.target.value));
document.getElementById('job-search').addEventListener('input', renderJobs);
document.getElementById('score-filter').addEventListener('change', renderJobs);
document.getElementById('document-search').addEventListener('input', renderDocuments);
document.getElementById('document-type-filter').addEventListener('change', renderDocuments);
document.getElementById('scanner-search')?.addEventListener('input', renderScannerInbox);
document.getElementById('scanner-status-filter')?.addEventListener('change', renderScannerInbox);
document.getElementById('scanner-company-filter')?.addEventListener('change', renderScannerInbox);
document.getElementById('scanner-source-filter')?.addEventListener('change', renderScannerInbox);
document.getElementById('scanner-location-filter')?.addEventListener('change', renderScannerInbox);
document.getElementById('scanner-refresh')?.addEventListener('click', loadScannerInbox);
document.getElementById('scanner-run-api')?.addEventListener('click', runApiScanner);
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
  if (hash === 'discovery') {
    routeTo('dashboard');
    return;
  }
  if (hash.startsWith('run/')) {
    await showRun(hash.split('/')[1], { updateHash: false });
    return;
  }
  routeTo(hash || 'dashboard', { updateHash: false });
}

async function loadAll() {
  const [jobs, applications, documents, profile] = await Promise.all([
    api('/api/jobs'),
    api('/api/applications'),
    api('/api/documents'),
    api('/api/profile'),
  ]);
  state.jobs = jobs.jobs || [];
  state.applications = applications.applications || [];
  state.tracker = applications.tracker || [];
  state.documents = documents.documents || [];
  state.runs = jobs.runs || state.jobs.map((job) => job.latestRunId).filter(Boolean);
  state.profile = profile;
  renderResumeProfileSelectors();
  renderDashboard();
  renderJobs();
  renderApplications();
  renderDocuments();
}

async function submitJob(event) {
  event.preventDefault();
  const jobUrl = document.getElementById('job-url').value.trim();
  const jobDescription = document.getElementById('job-description').value.trim();
  const validation = document.getElementById('add-job-validation');
  if (!jobUrl && !jobDescription) {
    const message = 'Add a job link or paste the job description before analyzing.';
    if (validation) validation.textContent = message;
    showToast(message);
    return;
  }
  if (validation) validation.textContent = 'Queueing this job for Career-Ops analysis...';
  const payload = {
    jobUrl,
    jobDescription,
    notes: document.getElementById('job-notes').value,
    generateResume: document.getElementById('generate-resume').checked,
    resumeProfileId: document.getElementById('resume-profile-select')?.value || state.profile?.defaultResumeProfileId || '',
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
    document.getElementById('job-url').value = '';
    document.getElementById('job-description').value = '';
    document.getElementById('job-notes').value = '';
    if (validation) validation.textContent = 'Provide a job link, a pasted job description, or both.';
    showRun(response.runId);
  } catch (error) {
    if (validation) validation.textContent = 'The job was not queued. Review the message and try again.';
    showToast(error.message);
  }
}

function routeTo(route, options = {}) {
  if (route === 'discovery') route = 'dashboard';
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
  if (route === 'scanner') loadScannerInbox();
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
    const runActions = renderRunActions(result, run, job);
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
        <button class="secondary-btn" onclick="refreshRun('${escapeAttribute(runId)}')">Refresh Run</button>
      </div>
      ${run.errorMessage ? `<p class="muted">${escapeHtml(run.errorMessage)}</p>` : ''}
      ${result.score ? `<div class="metric-grid">
        <article class="metric-card"><span>Score</span><strong>${escapeHtml(String(result.score))}/5</strong></article>
        <article class="metric-card"><span>Recommendation</span><strong>${escapeHtml(result.recommendation || 'Review')}</strong></article>
        <article class="metric-card"><span>Report</span><strong>${result.reportPath ? 'Ready' : 'Pending'}</strong></article>
        <article class="metric-card"><span>Resume</span><strong>${resumeArtifactStatus(result)}</strong></article>
      </div>` : ''}
      <div class="tags">
        <span class="tag">Profile: ${escapeHtml(result.resumeProfileLabel || run.resumeProfileLabel || 'Career-Ops cv.md')}</span>
        <span class="tag">Format: ${escapeHtml(resumeModeLabel(result.resumeMode || run.resumeMode || 'two_page'))}</span>
      </div>
      ${result.summary ? `<p>${escapeHtml(englishRunSummary(result))}</p>` : ''}
      ${result.resumePdfError ? `<div class="callout danger"><strong>Resume PDF blocked</strong><p>${escapeHtml(result.resumePdfError)}</p></div>` : ''}
      ${renderResumeQa(result.resumeQa, runActions)}
      ${!result.resumeQa ? runActions : ''}
      ${renderTags('Matching Skills', result.matchingSkills)}
      ${renderTags('Missing Skills', result.missingSkills)}
      ${renderList('Risks', result.risks)}
      ${(result.resumePdfErrorLogPath || result.coverLetterPath || result.applyUrl || job.id) ? `<div class="actions secondary-actions">
        ${result.resumePdfErrorLogPath ? `<a href="/files/${encodeURIComponent(result.resumePdfErrorLogPath)}" target="_blank">PDF Error Log</a>` : ''}
        ${result.resumeDocxErrorLogPath ? `<a href="/files/${encodeURIComponent(result.resumeDocxErrorLogPath)}" target="_blank">Word Error Log</a>` : ''}
        ${result.coverLetterPath ? `<a href="/files/${encodeURIComponent(result.coverLetterPath)}" target="_blank">Open Cover Letter</a>` : ''}
        ${result.applyUrl ? `<a href="${escapeAttribute(result.applyUrl)}" target="_blank" rel="noreferrer">Open Apply Link</a>` : ''}
        ${job.id ? `<button class="danger-action" onclick="rejectJob('${job.id}', '${run.id}')">Reject Job</button>` : ''}
      </div>` : ''}
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
        <button class="secondary-btn" onclick="refreshRun('${escapeAttribute(runId)}')">Refresh Run</button>
      </div>
      <p class="muted">${escapeHtml(error.message || 'Could not load this run. Return to Analyzed Jobs and open the latest run again.')}</p>
    `;
  }
}

function renderDashboard() {
  document.getElementById('metric-runs').textContent = state.runs.filter((run) => !run.hidden).length;
  document.getElementById('metric-resume-ready').textContent = analyzedJobs().filter((job) => jobEffectiveStatus(job) === 'resume_ready').length;
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
  `).join('') || '<p class="muted">You are clear for now. Add a job when ready.</p>';

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
  const needsReview = state.runs.find((run) => run.result?.resumeQa?.status && !/strong|ready/i.test(run.result.resumeQa.status));
  const due = followupsDue()[0];
  const failed = state.runs.find((run) => run.status === 'failed' && !run.hidden && !isPdfWorkerBlockedRun(run));
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

async function loadScannerInbox() {
  try {
    state.scanner = await api('/api/scanner/inbox');
    renderScannerInbox();
  } catch (error) {
    document.getElementById('scanner-list').innerHTML = `<div class="panel"><h2>Scanner Inbox unavailable</h2><p class="muted">${escapeHtml(error.message || 'Could not load Career-Ops pipeline rows.')}</p></div>`;
  }
}

function renderScannerInbox() {
  const rows = state.scanner?.rows || [];
  const counts = state.scanner?.counts || {};
  const search = document.getElementById('scanner-search')?.value?.toLowerCase() || '';
  const status = document.getElementById('scanner-status-filter')?.value || 'ready';
  const companyFilter = document.getElementById('scanner-company-filter')?.value || '';
  const sourceFilter = document.getElementById('scanner-source-filter')?.value || '';
  const locationFilter = document.getElementById('scanner-location-filter')?.value || '';
  renderScannerFilterOptions(rows, { companyFilter, sourceFilter, locationFilter });
  const visible = rows.filter((row) => {
    const text = `${row.title || ''} ${row.company || ''} ${row.source || ''} ${row.location || ''} ${row.url || ''}`.toLowerCase();
    const matchesStatus = !status || row.qualityStatus === status || row.status === status;
    const matchesCompany = !companyFilter || row.company === companyFilter;
    const matchesSource = !sourceFilter || row.source === sourceFilter;
    const matchesLocation = !locationFilter || row.location === locationFilter;
    return text.includes(search) && matchesStatus && matchesCompany && matchesSource && matchesLocation;
  }).sort(compareScannerRows);

  document.getElementById('scanner-summary').innerHTML = `
    <article class="metric-card"><span>Fresh Ready Jobs</span><strong>${escapeHtml(String(counts.ready || 0))}</strong></article>
    <article class="metric-card"><span>Stale Pending</span><strong>${escapeHtml(String(counts.stale || 0))}</strong></article>
    <article class="metric-card"><span>Review/Search Pages</span><strong>${escapeHtml(String(counts.review || 0))}</strong></article>
    <article class="metric-card"><span>Old Processed History</span><strong>${escapeHtml(String(counts.processed || 0))}</strong></article>
    <article class="metric-card"><span>Hidden</span><strong>${escapeHtml(String(counts.hidden || 0))}</strong></article>
  `;

  const emptyText = status === 'ready'
    ? 'No fresh analyzable scanner jobs right now. Click Run API Scanner to check direct Greenhouse/Ashby/Lever APIs, or use Add Job for a known posting.'
    : 'No scanner rows match this filter.';

  document.getElementById('scanner-list').innerHTML = visible.map((row) => `
    <article class="scanner-row ${row.qualityStatus ? `scanner-${escapeAttribute(row.qualityStatus)}` : ''}">
      <div class="scanner-main">
        <div class="scanner-title-line">
          <strong>${escapeHtml(cleanDisplayText(row.title || 'Job opportunity'))}</strong>
          <span class="status ${['review_source', 'expired', 'stale'].includes(row.qualityStatus) ? 'failed' : ''}">${escapeHtml(scannerStatusLabel(row.qualityStatus || row.status))}</span>
        </div>
        <div class="muted">${escapeHtml(cleanDisplayText(row.company || 'Unknown company'))} ${row.source ? `- ${escapeHtml(cleanDisplayText(row.source))}` : ''}</div>
        ${row.note ? `<p class="muted">${escapeHtml(cleanDisplayText(row.note))}</p>` : ''}
        <div class="tags compact-tags">
          ${row.sourceStatus ? `<span class="tag">${escapeHtml(row.sourceStatus)}</span>` : ''}
          ${row.location ? `<span class="tag">${escapeHtml(cleanDisplayText(row.location))}</span>` : ''}
          ${row.firstSeen ? `<span class="tag">Seen ${escapeHtml(row.firstSeen)}</span>` : ''}
          ${row.freshness ? `<span class="tag">${escapeHtml(row.freshness)}</span>` : ''}
          ${row.qualityStatus === 'ready' ? '<span class="tag">Fresh direct job</span>' : row.qualityStatus === 'stale' ? '<span class="tag">Stale - recheck before analyze</span>' : '<span class="tag">History/review only</span>'}
        </div>
      </div>
      <div class="actions scanner-actions">
        ${row.isAnalyzable && row.qualityStatus !== 'stale' ? `<button onclick="analyzeScannerRow('${escapeAttribute(row.id)}')">Analyze</button>` : ''}
        ${row.isAnalyzable && row.qualityStatus === 'stale' ? `<button class="secondary-btn" onclick="analyzeScannerRow('${escapeAttribute(row.id)}')">Analyze Stale</button>` : ''}
        ${row.url ? `<a href="${escapeAttribute(row.url)}" target="_blank" rel="noreferrer">Open Link</a>` : ''}
        <button class="danger-action" onclick="hideScannerRow('${escapeAttribute(row.id)}')">Hide</button>
      </div>
    </article>
  `).join('') || `<div class="panel empty-state"><h2>No fresh scanner jobs</h2><p class="muted">${escapeHtml(emptyText)}</p></div>`;
}

function compareScannerRows(a = {}, b = {}) {
  const rank = { ready: 0, stale: 1, review_source: 2, processed: 3, expired: 4 };
  const statusDelta = (rank[a.qualityStatus] ?? 9) - (rank[b.qualityStatus] ?? 9);
  if (statusDelta) return statusDelta;
  return String(b.lastSeen || b.firstSeen || '').localeCompare(String(a.lastSeen || a.firstSeen || ''));
}
function renderScannerFilterOptions(rows = [], selected = {}) {
  setScannerSelectOptions('scanner-company-filter', 'All companies', uniqueScannerValues(rows, 'company'), selected.companyFilter);
  setScannerSelectOptions('scanner-source-filter', 'All sources', uniqueScannerValues(rows, 'source'), selected.sourceFilter);
  setScannerSelectOptions('scanner-location-filter', 'All locations', uniqueScannerValues(rows, 'location'), selected.locationFilter);
}

function uniqueScannerValues(rows = [], key = '') {
  return [...new Set(rows.map((row) => cleanDisplayText(row[key] || '')).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
}

function setScannerSelectOptions(id, allLabel, values = [], selectedValue = '') {
  const select = document.getElementById(id);
  if (!select) return;
  const next = [`<option value="">${escapeHtml(allLabel)}</option>`, ...values.map((value) => `<option value="${escapeAttribute(value)}" ${value === selectedValue ? 'selected' : ''}>${escapeHtml(value)}</option>`)];
  const html = next.join('');
  if (select.innerHTML !== html) select.innerHTML = html;
  select.value = values.includes(selectedValue) ? selectedValue : '';
}
function scannerStatusLabel(status = '') {
  if (status === 'ready') return 'Fresh';
  if (status === 'pending') return 'Pending';
  if (status === 'stale') return 'Stale';
  if (status === 'expired') return 'Expired';
  if (status === 'processed') return 'Processed';
  if (status === 'review_source') return 'Review Source';
  return status || 'Pipeline';
}

async function runApiScanner() {
  const button = document.getElementById('scanner-run-api');
  const previous = button?.textContent || 'Run API Scanner';
  if (button) {
    button.disabled = true;
    button.textContent = 'Scanning...';
  }
  try {
    const response = await api('/api/scanner/run-api', { method: 'POST', body: JSON.stringify({ dryRun: false }) });
    const added = response.summary?.newOffersAdded || '0';
    showToast(`Scanner finished. New offers added: ${added}`);
    await loadScannerInbox();
  } catch (error) {
    showToast(error.message || 'Career-Ops scanner failed.');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = previous;
    }
  }
}

window.analyzeScannerRow = async (rowId) => {
  const row = (state.scanner?.rows || []).find((item) => item.id === rowId);
  if (!row) return showToast('Scanner row not found.');
  if (!row.isAnalyzable) return showToast('This scanner row is not a single analyzable job link. Open it and review first.');
  try {
    const response = await api('/api/jobs/analyze', {
      method: 'POST',
      body: JSON.stringify({
        jobUrl: row.url,
        notes: `Imported from Scanner Inbox: ${row.source || 'Career-Ops pipeline'}`,
        generateResume: true,
        resumeProfileId: document.getElementById('resume-profile-select')?.value || state.profile?.defaultResumeProfileId || '',
        resumeMode: document.querySelector('input[name="resume-mode"]:checked')?.value || 'two_page',
        generateCoverLetter: false,
        saveToTracker: true,
      }),
    });
    showToast('Scanner job queued for Career-Ops analysis.');
    showRun(response.runId);
  } catch (error) {
    showToast(error.message);
  }
};

window.hideScannerRow = async (rowId) => {
  const row = (state.scanner?.rows || []).find((item) => item.id === rowId);
  if (!row) return showToast('Scanner row not found.');
  if (!confirm(`Hide ${row.company || 'this company'} - ${row.title || 'this scanner row'} from Scanner Inbox? Career-Ops files stay untouched.`)) return;
  try {
    await api('/api/scanner/archive', { method: 'POST', body: JSON.stringify({ id: row.id, url: row.url, company: row.company, title: row.title }) });
    await loadScannerInbox();
    showToast('Scanner row hidden.');
  } catch (error) {
    showToast(error.message);
  }
};
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
    applyUrl: row.url || row.applyUrl || '',
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
            ${app.resumeProfileLabel ? `<span class="tag">${escapeHtml(app.resumeProfileLabel)}</span>` : ''}
            ${isFollowUpDue(app) ? '<span class="status failed">Follow-up due</span>' : ''}
          </div>
          <div class="mini-meta">
            ${app.appliedAt ? `<span>Applied: ${escapeHtml(shortDate(app.appliedAt))}</span>` : ''}
            ${app.interviewStage ? `<span>Stage: ${escapeHtml(app.interviewStage)}</span>` : ''}
            ${app.recruiterName || app.recruiterEmail ? `<span>Contact: ${escapeHtml([app.recruiterName, app.recruiterEmail].filter(Boolean).join(' - '))}</span>` : ''}
            ${app.nextFollowUpAt ? `<span>Follow-up: ${escapeHtml(shortDate(app.nextFollowUpAt))}</span>` : ''}
          </div>
          ${applicationSummary(app) ? `<p>${escapeHtml(applicationSummary(app))}</p>` : ''}
          <div class="actions">
            ${canMarkApplied(app.status) ? `<button onclick="quickMoveApplication('${app.id}', 'applied')">Mark Applied</button>` : ''}
            ${app.applyUrl ? `<a href="${escapeAttribute(app.applyUrl)}" target="_blank" rel="noreferrer">Apply</a>` : ''}
            ${app.resumePdfPath && app.resumePdfPath !== 'tracker' ? `<a href="/files/${encodeURIComponent(app.resumePdfPath)}" target="_blank">Resume</a>` : ''}
            ${app.reportPath ? `<a href="/files/${encodeURIComponent(app.reportPath)}" target="_blank">Report</a>` : ''}
            ${app.runId ? `<button onclick="showRun('${app.runId}')">Run</button>` : ''}
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
  const hasActiveFilter = Boolean(search || type);
  const docs = state.documents.filter((doc) => {
    const text = `${doc.displayName || ''} ${doc.fileName} ${doc.filePath} ${doc.type} ${doc.company || ''} ${doc.title || ''} ${doc.resumeProfileLabel || ''}`.toLowerCase();
    return (!type || doc.type === type) && (!search || text.includes(search));
  });
  const groups = groupByDocumentContext(docs);
  document.getElementById('documents-list').innerHTML = Object.entries(groups).map(([folder, files]) => {
    const encodedFolder = encodeURIComponent(folder);
    const isOpen = hasActiveFilter || openedDocumentGroups.has(folder);
    const summary = documentGroupSummary(files);
    return `
    <section class="folder-card ${isOpen ? 'folder-open' : 'folder-closed'}">
      <button class="folder-head folder-toggle" type="button" onclick="toggleDocumentGroup('${encodedFolder}')" aria-expanded="${isOpen ? 'true' : 'false'}">
        <span class="folder-arrow">${isOpen ? 'v' : '>'}</span>
        <span class="folder-icon">EZ</span>
        <span class="folder-title-block">
          <strong>${escapeHtml(folder)}</strong>
          <span class="muted">${files.length} file${files.length === 1 ? '' : 's'}${summary ? ` - ${escapeHtml(summary)}` : ''}</span>
        </span>
        ${documentGroupQa(files) ? `<span class="status">${escapeHtml(documentGroupQa(files))}</span>` : ''}
      </button>
      <div class="file-list" ${isOpen ? '' : 'hidden'}>
        ${files.map((doc) => `
          <div class="file-row">
            <div>
              <strong>${escapeHtml(doc.displayName || doc.fileName || 'Document')}</strong>
              <span>${escapeHtml(documentTypeLabel(doc.type))}${doc.resumeMode ? ` - ${escapeHtml(resumeModeLabel(doc.resumeMode))}` : ''} - ${formatDate(doc.createdAt)}</span>
              ${['resume_pdf', 'resume_docx', 'resume_html'].includes(doc.type) && doc.qaStatus ? `<span>QA: ${escapeHtml(resumeQaLabel(doc.qaStatus))}${doc.qaScore ? ` (${escapeHtml(String(doc.qaScore))}/100)` : ''}</span>` : ''}
              ${doc.resumeProfileLabel ? `<span>Profile: ${escapeHtml(doc.resumeProfileLabel)}</span>` : ''}
              ${(doc.company || doc.title) ? `<span>${escapeHtml(cleanDisplayText([doc.company, doc.title].filter(Boolean).join(' - ')))}</span>` : ''}
            </div>
            <div class="file-actions">
              <a href="/files/${encodeURIComponent(doc.filePath)}" target="_blank">${doc.type === 'resume_pdf' ? 'Preview PDF' : doc.type === 'resume_docx' ? 'Open Word' : doc.type === 'resume_html' ? 'Preview HTML' : 'Open'}</a>
              <a href="/files/${encodeURIComponent(doc.filePath)}" download>Download</a>
              ${doc.runId ? `<button onclick="showRun('${doc.runId}')">Run</button>` : ''}
              <button onclick="editDocumentLabel('${encodeURIComponent(doc.filePath)}')">Edit Label</button>
              ${doc.type === 'original_resume' ? '' : `<button onclick="hideDocument('${encodeURIComponent(doc.filePath)}')">Hide</button>`}
            </div>
          </div>
        `).join('')}
      </div>
    </section>`;
  }).join('') || '<p class="muted">No documents found. Analyze a job with resume generation enabled to create tailored documents.</p>';
}

window.toggleDocumentGroup = (encodedFolder) => {
  const folder = decodeURIComponent(encodedFolder || '');
  if (!folder) return;
  if (openedDocumentGroups.has(folder)) openedDocumentGroups.delete(folder);
  else openedDocumentGroups.add(folder);
  renderDocuments();
};
async function loadProfile() {
  const selectedId = typeof arguments[0] === 'string' ? arguments[0] : (document.getElementById('profile-resume-select')?.value || '');
  const profile = await api(`/api/profile${selectedId ? `?resumeProfileId=${encodeURIComponent(selectedId)}` : ''}`);
  state.profile = profile;
  renderResumeProfileSelectors(selectedId || profile.activeResumeProfile?.id || profile.defaultResumeProfileId);
  setProfileForm(profile.profilePreferences || {});
  document.getElementById('profile-text').textContent = profile.profileText || 'config/profile.yml not found';
  document.getElementById('cv-preview').textContent = profile.cvText || profile.cvPreview || 'cv.md not found';
  renderProfileSourceSummary(profile);
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
  const health = profile.sourceHealth || {};
  const digestText = profile.articleDigestText || profile.articleDigestPreview || '';
  const activeProfile = profile.activeResumeProfile || {};
  const profiles = profile.resumeProfiles || [];
  document.getElementById('profile-source-summary').innerHTML = `
    <div class="list-row"><strong>Active profile</strong><span>${escapeHtml(activeProfile.label || 'Career-Ops cv.md')}</span></div>
    <div class="list-row"><strong>Profile status</strong><span>${escapeHtml(sourceStatusLabel(activeProfile.sourceStatus || (activeProfile.isEnabled ? 'ready' : 'disabled')))}</span></div>
    <div class="list-row"><strong>Primary resume</strong><span>${escapeHtml(profile.cvPath || 'cv.md')}</span></div>
    <div class="list-row"><strong>article-digest.md</strong><span>${profile.articleDigestExists ? `Loaded for resume tailoring - ${Number(profile.articleDigestLength || 0).toLocaleString()} chars, ${Number(profile.articleDigestBulletCount || 0).toLocaleString()} bullets` : 'Not found'}</span></div>
    <div class="list-row"><strong>Profile config</strong><span>${escapeHtml(profile.profilePath || 'config/profile.yml')}</span></div>
    <h3>Resume Profiles</h3>
    <div class="compact-list">
      ${profiles.map((item) => `<div class="list-row"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(sourceStatusLabel(item.sourceStatus))}</span></div>`).join('')}
    </div>
    <h3>Digest Source Health</h3>
    <div class="compact-list">
      <div class="list-row"><strong>cv.md loaded</strong><span>${health.cvLoaded ? 'Yes' : 'No'}</span></div>
      <div class="list-row"><strong>article-digest.md loaded</strong><span>${health.articleDigestLoaded ? 'Yes' : 'No'}</span></div>
      <div class="list-row"><strong>profile.yml loaded</strong><span>${health.profileLoaded ? 'Yes' : 'No'}</span></div>
      <div class="list-row"><strong>story-bank.md loaded</strong><span>${health.storyBankLoaded ? 'Yes' : 'No'}</span></div>
    </div>
    ${digestText ? `<details class="digest-preview" open>
      <summary>article-digest.md Full Preview (${Number(profile.articleDigestPreviewLength || digestText.length).toLocaleString()}/${Number(profile.articleDigestLength || digestText.length).toLocaleString()} chars shown)</summary>
      <p class="hint">This is only the UI display. Resume generation reads the selected profile source files from disk.</p>
      <pre class="code-block small-code">${escapeHtml(digestText)}</pre>
    </details>` : ''}
  `;
}

function renderResumeProfileSelectors(selectedId = '') {
  const profiles = state.profile?.resumeProfiles || [];
  const defaultId = selectedId || state.profile?.activeResumeProfile?.id || state.profile?.defaultResumeProfileId || profiles.find((profile) => profile.isDefault)?.id || profiles[0]?.id || '';
  const options = profiles.map((profile) => {
    const disabled = !profile.isEnabled;
    const label = `${profile.label}${disabled ? ` (${sourceStatusLabel(profile.sourceStatus)})` : ''}`;
    return `<option value="${escapeAttribute(profile.id)}"${profile.id === defaultId ? ' selected' : ''}${disabled ? ' disabled' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
  const addSelect = document.getElementById('resume-profile-select');
  const profileSelect = document.getElementById('profile-resume-select');
  if (addSelect) addSelect.innerHTML = options;
  if (profileSelect) profileSelect.innerHTML = profiles.map((profile) => `<option value="${escapeAttribute(profile.id)}"${profile.id === defaultId ? ' selected' : ''}>${escapeHtml(`${profile.label} - ${sourceStatusLabel(profile.sourceStatus)}`)}</option>`).join('');
  updateResumeProfileControlState();
}

function updateResumeProfileControlState() {
  const enabled = document.getElementById('generate-resume')?.checked !== false;
  const select = document.getElementById('resume-profile-select');
  if (select) select.disabled = !enabled;
}

function sourceStatusLabel(status = '') {
  return {
    ready: 'Ready',
    missing_cv: 'Source missing - add cv.md to enable',
    disabled: 'Disabled until resume is provided',
  }[status] || cleanDisplayText(status).replace(/_/g, ' ') || 'Unknown';
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
  };
}

async function loadHealth() {
  const health = await api('/api/health');
  document.getElementById('health').innerHTML = `
    <div class="list-row"><strong>Web App Root</strong><span>${escapeHtml(health.appRoot)}</span></div>
    <div class="list-row"><strong>Career-Ops Root</strong><span>${escapeHtml(health.careerOpsRoot)}</span></div>
    <div class="list-row"><strong>Node</strong><span>${escapeHtml(health.node)}</span></div>
    <div class="list-row"><strong>State Schema</strong><span>v${escapeHtml(String(health.schemaVersion || 2))}</span></div>
    <div class="list-row"><strong>Resume Snapshots</strong><span>${escapeHtml(String(health.resumeSnapshots || 0))}</span></div>
    <div class="list-row"><strong>Enabled Resume Profiles</strong><span>${escapeHtml(String(health.resumeProfiles || 0))}</span></div>
    <div class="list-row"><strong>Gemini API</strong><span>${health.geminiConfigured ? 'Configured' : 'Not configured; fallback analysis enabled'}</span></div>
    <div class="list-row"><strong>Gemini Model</strong><span>${escapeHtml(health.geminiModel || 'not set')}</span></div>
    <div class="list-row"><strong>Local Cache</strong><span>${escapeHtml(`${health.localCaches?.jobDescriptions || 0} JDs, ${health.localCaches?.geminiEvaluations || 0} Gemini evaluations`)}</span></div>
    <div class="list-row"><strong>Discovery</strong><span>Disabled from active app</span></div>
    <div class="list-row"><strong>Scanner Inbox</strong><span>${health.scanner?.pipelineFound ? 'Pipeline ready' : 'Pipeline file missing'}</span></div>
    <div class="list-row"><strong>Scanner Config</strong><span>${health.scanner?.portalsFound ? 'portals.yml ready' : 'portals.yml missing'}</span></div>
    <div class="list-row"><strong>Scanner History</strong><span>${health.scanner?.scanHistoryFound ? 'scan-history.tsv ready' : 'No scan history yet'}</span></div>
    <div class="list-row"><strong>Scanner Sources</strong><span>${escapeHtml(`${health.scanner?.enabledCompanies || 0} companies, ${health.scanner?.apiDetectableCompanies || 0} API-ready, ${health.scanner?.websearchCompanies || 0} WebSearch, ${health.scanner?.enabledSearchQueries || 0} queries`)}</span></div>
    ${(health.required || []).map((item) => `<div class="list-row"><strong>${escapeHtml(item.file)}</strong><span>${item.exists ? 'Ready' : 'Missing'}</span></div>`).join('')}
  `;
}

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

window.analyzeExistingJob = async (jobId) => {
  const job = state.jobs.find((item) => item.id === jobId);
  if (!job) return showToast('Job not found.');
  try {
    const currentMode = document.querySelector('input[name="resume-mode"]:checked')?.value || 'two_page';
    const choice = prompt('Resume type for this rerun: enter 1 for one-page or 2 for two-page.', currentMode === 'one_page' ? '1' : '2');
    if (choice === null) return;
    const resumeMode = String(choice).trim() === '1' ? 'one_page' : 'two_page';
    const resumeProfileId = document.getElementById('resume-profile-select')?.value || state.profile?.defaultResumeProfileId || '';
    const response = await api(`/api/jobs/${jobId}/analyze`, {
      method: 'POST',
      body: JSON.stringify({ generateResume: true, resumeProfileId, resumeMode, generateCoverLetter: false, saveToTracker: true }),
    });
    showToast('Career-Ops analysis queued.');
    showRun(response.runId);
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
  if (!confirm(`Hide ${filePath} from the active documents list? The file will stay on disk.`)) return;
  try {
    await api(`/api/documents/${encodeURIComponent(filePath)}`, { method: 'DELETE' });
    await loadAll();
    showToast('Document hidden from list.');
  } catch (error) {
    showToast(error.message);
  }
};

window.editDocumentLabel = async (encodedPath) => {
  const filePath = decodeURIComponent(encodedPath);
  const current = state.documents.find((doc) => doc.filePath === filePath);
  const label = prompt('Document label', current?.displayName || current?.fileName || '');
  if (label === null) return;
  try {
    await api(`/api/documents/${encodeURIComponent(filePath)}`, {
      method: 'PATCH',
      body: JSON.stringify({ label: label.trim() }),
    });
    await loadAll();
    showToast('Document label updated.');
  } catch (error) {
    showToast(error.message);
  }
};

window.refreshRun = async (runId) => {
  if (!runId) return;
  await renderRun(runId);
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

function renderResumeMissingTerms(items = []) {
  const terms = items?.length ? items : ['No major missing JD terms found'];
  return `<h3>Resume Missing JD Terms</h3><div class="tags">${terms.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('')}</div>`;
}

function renderList(title, items = []) {
  if (!items?.length) return '';
  return `<h3>${title}</h3><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderResumeQa(qa, actionsHtml = '') {
  if (!qa) return actionsHtml || '';
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
    ${renderResumeMissingTerms(qa.missingTerms)}
    ${actionsHtml}
    ${renderList('article-digest.md Bullets Selected', qa.selectedDigestBullets || qa.usedDigestBullets)}
    ${renderList('Final Resume Bullet Sources', (qa.finalBullets || []).map((item) => `${item.source || 'source'} - ${item.company || 'Experience'}: ${item.bullet || item}`))}
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
  if (isPdfWorkerBlockedRun(run)) return 'needs_review';
  if (run?.status === 'failed') return 'failed';
  if (run?.status === 'completed') return run.result?.resumePdfPath ? 'resume_ready' : 'analyzed';
  if (['queued', 'running', 'fetching_job', 'analyzing', 'generating_resume'].includes(run?.status)) return 'analyzing';
  return job.status || 'saved';
}

function renderRunActions(result = {}, run = {}, job = {}) {
  const actions = [
    result.reportPath ? `<a href="/files/${encodeURIComponent(result.reportPath)}" target="_blank">Open Report</a>` : '',
    result.resumePdfPath ? `<a href="/files/${encodeURIComponent(result.resumePdfPath)}" target="_blank">Open Resume PDF</a>` : '',
    result.resumePdfPath ? `<a href="/files/${encodeURIComponent(result.resumePdfPath)}" download>Download Resume</a>` : '',
    result.resumeDocxPath ? `<a href="/files/${encodeURIComponent(result.resumeDocxPath)}" target="_blank">Open Resume Word</a>` : '',
    result.resumeDocxPath ? `<a href="/files/${encodeURIComponent(result.resumeDocxPath)}" download>Download Word</a>` : '',
    result.resumeHtmlPath ? `<a href="/files/${encodeURIComponent(result.resumeHtmlPath)}" target="_blank">Open Resume HTML</a>` : '',
    result.logPath ? `<a href="/files/${encodeURIComponent(result.logPath)}" target="_blank">Open Log</a>` : '',
    run.status === 'completed' ? `<button onclick="saveApplication('${run.id}')">Save to Applications</button>` : '',
  ].filter(Boolean);
  return actions.length ? `<div class="actions primary-run-actions">${actions.join('')}</div>` : '';
}

function isPdfWorkerBlockedRun(run = {}) {
  const text = `${run.errorMessage || ''} ${run.result?.resumePdfError || ''}`.toLowerCase();
  return text.includes('pdf/browser worker') || text.includes('pdf browser') || text.includes('uv_handle_closing') || text.includes('spawn eperm');
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
  if (result.resumePdfPath && result.resumeDocxPath) return 'PDF + Word Ready';
  if (result.resumePdfPath) return 'PDF Ready';
  if (result.resumeDocxPath) return 'Word Ready';
  if (result.resumeHtmlPath) return 'HTML Ready';
  if (result.resumePdfError) return 'PDF Blocked';
  return 'Pending';
}

function documentTypeLabel(type = '') {
  return {
    original_resume: 'Original Resume',
    resume_pdf: 'Tailored Resume PDF',
    resume_docx: 'Tailored Resume Word',
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

function documentGroupSummary(files = []) {
  const modes = [...new Set(files.map((doc) => doc.resumeMode ? resumeModeLabel(doc.resumeMode) : '').filter(Boolean))];
  const profiles = [...new Set(files.map((doc) => doc.resumeProfileLabel || '').filter(Boolean))];
  const newest = files
    .map((doc) => doc.createdAt || '')
    .filter(Boolean)
    .sort()
    .pop();
  return [profiles[0], modes.slice(0, 2).join(' + '), newest ? `newest ${formatDate(newest)}` : '']
    .filter(Boolean)
    .join(' - ');
}

function documentGroupQa(files = []) {
  const qaDocs = files.filter((doc) => ['resume_pdf', 'resume_docx', 'resume_html'].includes(doc.type) && (doc.qaStatus || doc.qaScore));
  if (!qaDocs.length) return '';
  const best = qaDocs
    .slice()
    .sort((a, b) => Number(b.qaScore || 0) - Number(a.qaScore || 0))[0];
  const label = best.qaStatus ? resumeQaLabel(best.qaStatus) : 'QA';
  return `${label}${best.qaScore ? ` (${best.qaScore}/100)` : ''}`;
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

function isFollowUpDue(app = {}) {
  const due = Date.parse(app.nextFollowUpAt || '');
  return Number.isFinite(due) && due <= Date.now() && !['offer', 'rejected', 'archived'].includes(app.status || '');
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

function canMarkApplied(status = '') {
  const order = applicationStatuses.map(([key]) => key);
  const current = order.indexOf(status);
  const applied = order.indexOf('applied');
  return current === -1 || current < applied;
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

function analyzedJobs() {
  return uniqueJobsByCanonicalUrl(state.jobs.filter((job) => isAnalyzedJob(job)));
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



