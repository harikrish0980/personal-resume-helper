import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { join } from 'node:path';
import { validatePublicUrl } from './urlSafety.mjs';

const REMOTIVE_API = 'https://remotive.com/api/remote-jobs';
const HIMALAYAS_API = 'https://himalayas.app/jobs/api/search';
const REMOTEJOBS_API = 'https://remotejobs.org/api/v1/jobs';
const ARBEITNOW_API = 'https://www.arbeitnow.com/api/job-board-api';
const THE_MUSE_API = 'https://www.themuse.com/api/public/jobs';
const MATCH_STOP_WORDS = new Set([
  'and', 'the', 'for', 'with', 'from', 'that', 'this', 'into', 'using', 'used', 'use',
  'have', 'has', 'had', 'are', 'was', 'were', 'will', 'you', 'your', 'our', 'their',
  'across', 'within', 'without', 'including', 'support', 'work', 'team', 'teams',
  'business', 'technical', 'experience', 'years', 'role', 'company', 'environment',
  'present', 'current', 'senior', 'engineer', 'engineering',
]);

const DEFAULT_SOURCES = [
  {
    id: 'career_ops_ats',
    name: 'Career-Ops ATS Sources',
    type: 'career_ops_ats',
    category: 'Automated Direct',
    trustLevel: 'High',
    automation: 'Auto-imports direct ATS jobs',
    enabled: true,
    limit: 60,
    notes: 'Uses Career-Ops portals.yml to scan direct Greenhouse, Ashby, and Lever company job boards.',
  },
  {
    id: 'career_ops_pipeline',
    name: 'Career-Ops Pipeline',
    type: 'career_ops_pipeline',
    category: 'Career-Ops Inbox',
    trustLevel: 'Medium',
    automation: 'Auto-imports curated pipeline jobs',
    enabled: true,
    limit: 100,
    notes: 'Imports already discovered Career-Ops pipeline jobs and applies the web app match gate.',
  },
  {
    id: 'curated_direct_ats',
    name: 'Curated Direct ATS Catalog',
    type: 'curated_direct_ats',
    category: 'Automated Direct',
    trustLevel: 'High',
    automation: 'Scans public company ATS APIs',
    enabled: true,
    limit: 80,
    notes: 'Scans public Greenhouse and Ashby boards for high-signal target companies with current direct apply links.',
  },
  {
    id: 'remotive',
    name: 'Remotive Remote Jobs',
    type: 'remotive',
    category: 'Optional Broad Feed',
    trustLevel: 'Low',
    automation: 'Optional feed; disabled by default',
    enabled: false,
    limit: 25,
    notes: 'Optional broad remote feed. Keep off unless you intentionally want remote-only aggregator results.',
  },
  {
    id: 'himalayas',
    name: 'Himalayas Remote Jobs',
    type: 'himalayas',
    category: 'Structured Board',
    trustLevel: 'Medium',
    automation: 'Searches public remote job API',
    enabled: true,
    limit: 20,
    notes: 'Free public remote jobs API with keyword search, salary, seniority, and application links.',
  },
  {
    id: 'remotejobs_org',
    name: 'RemoteJobs.org',
    type: 'remotejobs_org',
    category: 'Structured Board',
    trustLevel: 'Medium',
    automation: 'Searches public remote job API',
    enabled: true,
    limit: 30,
    notes: 'Free public remote job API with keyword filtering. Results are filtered by match score before display.',
  },
  {
    id: 'themuse',
    name: 'The Muse Jobs',
    type: 'themuse',
    category: 'Structured Board',
    trustLevel: 'Medium',
    automation: 'Searches public job API',
    enabled: true,
    limit: 30,
    notes: 'Free public jobs API with company apply links. Filtered by role, resume match, location, and date before display.',
  },
  {
    id: 'arbeitnow',
    name: 'Arbeitnow Jobs API',
    type: 'arbeitnow',
    category: 'Structured Board',
    trustLevel: 'Medium',
    automation: 'Searches public job board API',
    enabled: true,
    limit: 40,
    notes: 'Free public jobs API backed by multiple ATS sources. Best for Europe/remote, filtered strictly by role.',
  },
  {
    id: 'adzuna',
    name: 'Adzuna Job Search',
    type: 'adzuna',
    category: 'Optional Mixed Board',
    trustLevel: 'Medium',
    automation: 'Searches broad job API when API keys are configured',
    enabled: false,
    limit: 30,
    notes: 'Optional non-remote capable source. Add ADZUNA_APP_ID and ADZUNA_APP_KEY to .env, then enable this source.',
  },
  {
    id: 'scrapegraph_local',
    name: 'Local AI Scraper',
    type: 'scrapegraph_local',
    category: 'Experimental Local Source',
    trustLevel: 'Review required',
    automation: 'Extracts jobs from approved pages',
    enabled: false,
    limit: 15,
    maxPages: 8,
    timeoutMs: 60000,
    seedUrls: '',
    notes: 'Optional local ScrapeGraphAI/Ollama source. Scans only approved company career pages and requires review before analysis.',
  },
  {
    id: 'scrapegraph_cloud',
    name: 'ScrapeGraph Cloud API',
    type: 'scrapegraph_cloud',
    category: 'Optional Cloud Source',
    trustLevel: 'Review required',
    automation: 'Cloud extraction for approved public pages',
    enabled: false,
    limit: 15,
    maxPages: 8,
    timeoutMs: 60000,
    seedUrls: '',
    notes: 'Optional ScrapeGraphAI cloud fallback. Sends only approved public job/career page URLs or job page content; never sends resume/profile data.',
  },
];

const CURATED_ATS_COMPANIES = [
  { name: 'Databricks', type: 'greenhouse', slug: 'databricks' },
  { name: 'Stripe', type: 'greenhouse', slug: 'stripe' },
  { name: 'Figma', type: 'greenhouse', slug: 'figma' },
  { name: 'Airbnb', type: 'greenhouse', slug: 'airbnb' },
  { name: 'Brex', type: 'greenhouse', slug: 'brex' },
  { name: 'Chime', type: 'greenhouse', slug: 'chime' },
  { name: 'Robinhood', type: 'greenhouse', slug: 'robinhood' },
  { name: 'Reddit', type: 'greenhouse', slug: 'reddit' },
  { name: 'Lyft', type: 'greenhouse', slug: 'lyft' },
  { name: 'Scale AI', type: 'greenhouse', slug: 'scaleai' },
  { name: 'Anthropic', type: 'greenhouse', slug: 'anthropic' },
  { name: 'OpenAI', type: 'ashby', slug: 'openai' },
  { name: 'Ramp', type: 'ashby', slug: 'ramp' },
  { name: 'Notion', type: 'ashby', slug: 'notion' },
  { name: 'Plaid', type: 'ashby', slug: 'plaid' },
  { name: 'Cursor', type: 'ashby', slug: 'cursor' },
  { name: 'Perplexity', type: 'ashby', slug: 'perplexity' },
];

export function defaultJobSources(existing = []) {
  const byId = new Map((Array.isArray(existing) ? existing : []).map((source) => [source.id, source]));
  return DEFAULT_SOURCES.map((source) => {
    const saved = byId.get(source.id) || {};
    const enabled = source.id === 'remotive'
      ? Boolean(byId.get(source.id)?.userEnabled)
      : byId.get(source.id)?.enabled ?? source.enabled;
    return {
      ...source,
      limit: saved.limit ?? source.limit,
      query: saved.query ?? source.query,
      seedUrls: saved.seedUrls ?? source.seedUrls,
      maxPages: saved.maxPages ?? source.maxPages,
      timeoutMs: saved.timeoutMs ?? source.timeoutMs,
      userEnabled: saved.userEnabled,
      updatedAt: saved.updatedAt,
      enabled: source.id === 'adzuna' && (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY)
        ? false
        : source.id === 'scrapegraph_cloud' && !process.env.SCRAPEGRAPH_API_KEY
          ? false
          : enabled,
    };
  });
}

export function guidedSearchSources(careerOpsRoot = '') {
  const file = join(careerOpsRoot || '', 'portals.yml');
  if (!careerOpsRoot || !existsSync(file)) return [];
  const text = readFileSync(file, 'utf-8');
  const section = (text.split(/\nsearch_queries:\s*\n/)[1] || '').split(/\ntracked_companies:\s*\n/)[0] || '';
  const blocks = section.split(/\n\s*-\s+name:\s+/).slice(1);
  return blocks.map((block, index) => {
    const lines = block.split(/\r?\n/);
    const name = cleanText(lines[0] || `Search ${index + 1}`);
    const queryLine = lines.find((line) => /^\s*query:\s*/.test(line)) || '';
    const enabledLine = lines.find((line) => /^\s*enabled:\s*/.test(line)) || '';
    const query = cleanText(queryLine.replace(/^\s*query:\s*/, '')).replace(/^['"]|['"]$/g, '');
    const provider = inferGuidedProvider(name, query);
    return {
      id: `guided_${slugify(name)}`,
      name,
      provider,
      category: guidedCategory(provider),
      trustLevel: guidedTrustLevel(provider),
      mode: 'Guided Search',
      enabled: !/false/i.test(enabledLine),
      query,
      searchUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      notes: guidedNotes(provider),
    };
  }).filter((source) => source.query);
}

export async function runDiscovery({ sources, profilePreferences, existingJobs = [], fetchImpl = fetch, careerOpsRoot = '', options = {} }) {
  const enabledSources = filterSourcesByScope(defaultJobSources(sources).filter((source) => source.enabled), options.sourceScope || 'balanced');
  const sourceResults = [];
  const discoveredJobs = [];
  const criteria = normalizeCriteria(options, profilePreferences);

  for (const source of enabledSources) {
    const startedAt = new Date().toISOString();
    try {
      const fetched = await fetchSource(source, profilePreferences, fetchImpl, criteria, careerOpsRoot);
      const jobs = Array.isArray(fetched) ? fetched : (fetched.jobs || []);
      const normalized = jobs.map((job) => normalizeJob(job, source, profilePreferences, criteria));
      const qualified = normalized.filter((job) => isQualifiedDiscoveryJob(job, criteria));
      sourceResults.push({
        sourceId: source.id,
        sourceName: source.name,
        status: 'completed',
        count: qualified.length,
        rawCount: normalized.length,
        filteredCount: normalized.length - qualified.length,
        providerTrace: Array.isArray(fetched?.providerTrace) ? fetched.providerTrace.slice(0, 8) : [],
        diagnostics: fetched?.diagnostics || null,
        startedAt,
        completedAt: new Date().toISOString(),
      });
      discoveredJobs.push(...qualified);
    } catch (error) {
      sourceResults.push({
        sourceId: source.id,
        sourceName: source.name,
        status: 'failed',
        count: 0,
        rawCount: 0,
        filteredCount: 0,
        errorMessage: publicSourceError(error),
        startedAt,
        completedAt: new Date().toISOString(),
      });
    }
  }

  const existing = Array.isArray(existingJobs) ? existingJobs : [];
  return {
    discoveredJobs: dedupeIncoming(discoveredJobs),
    sourceResults,
    stats: summarizeDiscovery(sourceResults),
    criteria,
  };
}

export function mergeDiscoveredJobs(state, discoveredJobs, discoveryRunId, makeId) {
  const now = new Date().toISOString();
  const jobs = Array.isArray(state.jobs) ? state.jobs : [];
  const imported = [];
  const updated = [];
  const duplicates = [];

  for (const incoming of discoveredJobs) {
    const duplicate = findDuplicate(incoming, jobs);
    if (duplicate) {
      duplicate.lastSeenAt = now;
      duplicate.discoveryRunId ||= discoveryRunId;
      duplicate.quickScore = incoming.quickScore;
      duplicate.quickScoreBreakdown = incoming.quickScoreBreakdown;
      duplicate.matchBucket = duplicate.matchBucket === 'skipped' ? 'skipped' : incoming.matchBucket;
      duplicate.company = incoming.company || duplicate.company;
      duplicate.location = incoming.location || duplicate.location;
      duplicate.postedAt = incoming.postedAt || duplicate.postedAt;
      duplicate.salary = incoming.salary || duplicate.salary;
      duplicate.jobUrl = incoming.jobUrl || duplicate.jobUrl;
      duplicate.applyUrl = incoming.applyUrl || duplicate.applyUrl;
      duplicate.description = incoming.description || duplicate.description;
      duplicate.skills = incoming.skills?.length ? incoming.skills : duplicate.skills;
      duplicate.updatedAt = now;
      updated.push(duplicate.id);
      duplicates.push({ incoming: incoming.canonicalUrl || incoming.applyUrl, duplicateOf: duplicate.id });
      continue;
    }

    const job = {
      id: makeId('job'),
      ...incoming,
      status: incoming.status || 'discovered',
      discoveredAt: incoming.discoveredAt || now,
      lastSeenAt: now,
      discoveryRunId,
      createdAt: now,
      updatedAt: now,
    };
    jobs.unshift(job);
    imported.push(job.id);
  }

  state.jobs = jobs;
  return { imported, updated, duplicates };
}

export function canonicalizeUrl(rawUrl) {
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

export function findDuplicate(job, existingJobs = []) {
  const canonical = canonicalizeUrl(job.canonicalUrl || job.applyUrl || job.jobUrl);
  const external = job.sourceType && job.externalId ? `${job.sourceType}:${job.externalId}` : '';
  const atsJob = job.atsJobId ? `${sourceProviderForJob(job)}:${normalizedText(job.atsJobId)}` : '';
  const titleCompany = normalizedText([job.company, job.title, job.location].filter(Boolean).join('|'));
  const descriptionKey = discoveryDescriptionKey(job);
  return existingJobs.find((existing) => {
    const existingCanonical = canonicalizeUrl(existing.canonicalUrl || existing.applyUrl || existing.jobUrl);
    if (canonical && existingCanonical && canonical === existingCanonical) return true;
    if (external && existing.sourceType && existing.externalId && `${existing.sourceType}:${existing.externalId}` === external) return true;
    const existingAts = existing.atsJobId ? `${sourceProviderForJob(existing)}:${normalizedText(existing.atsJobId)}` : '';
    if (atsJob && existingAts && atsJob === existingAts) return true;
    const existingTitleCompany = normalizedText([existing.company, existing.title, existing.location].filter(Boolean).join('|'));
    if (titleCompany && existingTitleCompany && titleCompany === existingTitleCompany) return true;
    const existingDescriptionKey = discoveryDescriptionKey(existing);
    return Boolean(descriptionKey && existingDescriptionKey && descriptionKey === existingDescriptionKey);
  });
}

function dedupeIncoming(discoveredJobs) {
  const seen = [];
  const result = [];
  for (const job of discoveredJobs) {
    if (findDuplicate(job, seen)) continue;
    seen.push(job);
    result.push(job);
  }
  return result;
}

function discoveryDescriptionKey(job = {}) {
  const title = normalizedText(job.title || job.resolvedTitle);
  const company = normalizedText(job.company || job.resolvedCompany);
  const body = normalizedText(job.description || '').replace(/[^a-z0-9]+/g, ' ').slice(0, 220);
  if (!title || !company || body.length < 80) return '';
  return `${company}|${title}|${body}`;
}

async function fetchSource(source, profilePreferences, fetchImpl, criteria, careerOpsRoot) {
  if (source.type === 'career_ops_ats') return fetchCareerOpsAts(source, criteria, fetchImpl, careerOpsRoot);
  if (source.type === 'career_ops_pipeline') return fetchCareerOpsPipeline(source, criteria, careerOpsRoot);
  if (source.type === 'curated_direct_ats') return fetchCuratedDirectAts(source, criteria, fetchImpl);
  if (source.type === 'himalayas') return fetchHimalayas(source, criteria, fetchImpl);
  if (source.type === 'remotejobs_org') return fetchRemoteJobsOrg(source, criteria, fetchImpl);
  if (source.type === 'themuse') return fetchTheMuse(source, criteria, fetchImpl);
  if (source.type === 'arbeitnow') return fetchArbeitnow(source, criteria, fetchImpl);
  if (source.type === 'adzuna') return fetchAdzuna(source, criteria, fetchImpl);
  if (source.type === 'remotive') return fetchRemotive(source, profilePreferences, fetchImpl, criteria);
  if (source.type === 'scrapegraph_local') return fetchScrapeGraphLocal(source, criteria, careerOpsRoot);
  if (source.type === 'scrapegraph_cloud') return fetchScrapeGraphCloud(source, criteria, careerOpsRoot, fetchImpl);
  return [];
}

async function fetchCuratedDirectAts(source, criteria, fetchImpl) {
  const jobs = [];
  for (const company of CURATED_ATS_COMPANIES) {
    if (jobs.length >= Number(source.limit || 80)) break;
    try {
      const url = company.type === 'greenhouse'
        ? `https://boards-api.greenhouse.io/v1/boards/${company.slug}/jobs?content=true`
        : `https://api.ashbyhq.com/posting-api/job-board/${company.slug}?includeCompensation=true`;
      const data = await fetchJsonWithTimeout(url, fetchImpl);
      const parsed = parseAtsJobs(data, company, company.type);
      jobs.push(...parsed.filter((job) => titleMatchesCriteria(job.title, criteria)));
    } catch {
      // Keep the catalog resilient; one company board failure should not stop discovery.
    }
  }
  return jobs.slice(0, Number(source.limit || 80));
}

async function fetchCareerOpsAts(source, criteria, fetchImpl, careerOpsRoot) {
  const companies = loadCareerOpsCompanies(careerOpsRoot).filter((company) => company.enabled !== false);
  const targets = companies
    .map((company) => ({ ...company, api: detectAtsApi(company) }))
    .filter((company) => company.api)
    .slice(0, Number(source.limit || 60));
  const jobs = [];
  for (const company of targets) {
    try {
      const data = await fetchJsonWithTimeout(company.api.url, fetchImpl);
      const parsed = parseAtsJobs(data, company, company.api.type);
      jobs.push(...parsed.filter((job) => titleMatchesCriteria(job.title, criteria)));
    } catch {
      // Individual company failures should not poison the whole discovery run.
    }
  }
  return jobs;
}

function fetchCareerOpsPipeline(source, criteria, careerOpsRoot) {
  const file = join(careerOpsRoot || '', 'data', 'pipeline.md');
  if (!careerOpsRoot || !existsSync(file)) return [];
  const lines = readFileSync(file, 'utf-8').split(/\r?\n/);
  const jobs = [];
  for (const line of lines) {
    const match = line.match(/^- \[[ x]\]\s+(https?:\/\/\S+)\s+\|\s+([^|]+)\s+\|\s+(.+)$/);
    if (!match) continue;
    const job = {
      sourceType: 'career_ops_pipeline',
      sourceName: source.name,
      externalId: canonicalizeUrl(match[1]),
      title: cleanText(match[3]),
      company: cleanText(match[2]),
      location: '',
      jobUrl: match[1],
      applyUrl: match[1],
      description: '',
      skills: [],
    };
    if (titleMatchesCriteria(job.title, criteria)) jobs.push(job);
  }
  return jobs.slice(0, Number(source.limit || 100));
}

async function fetchRemotive(source, profilePreferences, fetchImpl, criteria) {
  const terms = discoveryTerms(profilePreferences, criteria).slice(0, 2);
  const jobs = [];
  for (const term of terms) {
    const url = new URL(REMOTIVE_API);
    url.searchParams.set('search', term);
    const data = await fetchJsonWithTimeout(url, fetchImpl);
    for (const job of data.jobs || []) jobs.push(remotiveToJob(job, source));
    if (jobs.length >= Number(source.limit || 25)) break;
  }
  return jobs.slice(0, Number(source.limit || 25));
}

async function fetchHimalayas(source, criteria, fetchImpl) {
  const url = new URL(HIMALAYAS_API);
  url.searchParams.set('q', criteria.query);
  url.searchParams.set('sort', 'recent');
  if (/united states|usa|us|remote/i.test(criteria.location)) url.searchParams.set('country', 'US');
  const data = await fetchJsonWithTimeout(url, fetchImpl);
  return (data.jobs || []).slice(0, Number(source.limit || 20)).map((job) => ({
    sourceType: source.type,
    sourceName: source.name,
    externalId: String(job.guid || ''),
    title: job.title || '',
    company: job.companyName || '',
    location: formatHimalayasLocation(job),
    remoteType: 'Remote',
    employmentType: job.employmentType || '',
    experienceLevel: Array.isArray(job.seniority) ? job.seniority.join(', ') : String(job.seniority || ''),
    postedAt: normalizeDate(job.pubDate),
    jobUrl: job.applicationLink || '',
    applyUrl: job.applicationLink || '',
    description: stripHtml(`${job.excerpt || ''} ${job.description || ''}`),
    salary: formatSalary(job.minSalary, job.maxSalary, job.currency),
    skills: [...(job.categories || []), ...(job.parentCategories || [])].map(cleanText).filter(Boolean),
  }));
}

async function fetchRemoteJobsOrg(source, criteria, fetchImpl) {
  const url = new URL(REMOTEJOBS_API);
  url.searchParams.set('keyword', criteria.query);
  url.searchParams.set('limit', String(Math.min(50, Number(source.limit || 30))));
  const data = await fetchJsonWithTimeout(url, fetchImpl);
  const jobs = Array.isArray(data) ? data : (data.jobs || data.data || []);
  return jobs.map((job) => ({
    sourceType: source.type,
    sourceName: source.name,
    externalId: String(job.id || job.guid || job.slug || job.url || ''),
    title: job.title || job.position || '',
    company: readableText(job.company || job.company_name || job.companyName),
    location: readableText(job.location || job.region) || 'Remote',
    remoteType: 'Remote',
    employmentType: job.job_type || job.type || '',
    postedAt: normalizeDate(job.date || job.published_at || job.created_at),
    jobUrl: job.url || job.apply_url || job.application_url || '',
    applyUrl: job.url || job.apply_url || job.application_url || '',
    description: stripHtml(job.description || job.excerpt || ''),
    salary: readableText(job.salary),
    skills: Array.isArray(job.tags) ? job.tags.map(readableText).filter(Boolean) : [],
  }));
}

async function fetchTheMuse(source, criteria, fetchImpl) {
  const url = new URL(THE_MUSE_API);
  url.searchParams.set('page', '1');
  url.searchParams.set('descending', 'true');
  url.searchParams.set('category', /software|frontend|backend|full stack/i.test(criteria.query)
    ? 'Software Engineering'
    : 'Data and Analytics');
  if (criteria.location && !/remote/i.test(criteria.location)) url.searchParams.set('location', criteria.location);
  if (/senior|lead|staff|principal/i.test(criteria.query)) url.searchParams.set('level', 'Senior Level');
  const data = await fetchJsonWithTimeout(url, fetchImpl);
  const jobs = data.results || data.jobs || [];
  return jobs.slice(0, Number(source.limit || 30)).map((job) => ({
    sourceType: source.type,
    sourceName: source.name,
    externalId: String(job.id || job.refs?.landing_page || ''),
    title: job.name || job.title || '',
    company: readableText(job.company),
    location: formatTheMuseLocations(job.locations),
    remoteType: /remote|flexible/i.test(formatTheMuseLocations(job.locations)) ? 'Remote/Flexible' : '',
    employmentType: readableText(job.type || job.levels?.map(readableText).join(', ')),
    experienceLevel: Array.isArray(job.levels) ? job.levels.map(readableText).filter(Boolean).join(', ') : '',
    postedAt: normalizeDate(job.publication_date || job.publicationDate),
    jobUrl: job.refs?.landing_page || job.refs?.preview_page || '',
    applyUrl: job.refs?.landing_page || job.refs?.preview_page || '',
    description: stripHtml(`${job.contents || ''} ${Array.isArray(job.categories) ? job.categories.map(readableText).join(' ') : ''}`),
    salary: '',
    skills: Array.isArray(job.categories) ? job.categories.map(readableText).filter(Boolean) : [],
  }));
}

async function fetchArbeitnow(source, criteria, fetchImpl) {
  const url = new URL(ARBEITNOW_API);
  const data = await fetchJsonWithTimeout(url, fetchImpl);
  const jobs = data.data || data.jobs || [];
  return jobs.slice(0, Number(source.limit || 40)).map((job) => ({
    sourceType: source.type,
    sourceName: source.name,
    externalId: String(job.slug || job.id || job.url || ''),
    title: job.title || '',
    company: job.company_name || job.company || '',
    location: job.location || (job.remote ? 'Remote' : ''),
    remoteType: job.remote ? 'Remote' : '',
    employmentType: '',
    postedAt: normalizeDate(job.created_at),
    jobUrl: job.url || '',
    applyUrl: job.url || '',
    description: stripHtml(job.description || ''),
    salary: '',
    skills: Array.isArray(job.tags) ? job.tags.map(cleanText).filter(Boolean) : [],
  }));
}

async function fetchAdzuna(source, criteria, fetchImpl) {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) throw new Error('Adzuna API keys are not configured.');
  const url = new URL('https://api.adzuna.com/v1/api/jobs/us/search/1');
  url.searchParams.set('app_id', appId);
  url.searchParams.set('app_key', appKey);
  url.searchParams.set('results_per_page', String(Math.min(50, Number(source.limit || 30))));
  url.searchParams.set('what', criteria.query || 'data engineer');
  if (criteria.location && !/remote/i.test(criteria.location)) url.searchParams.set('where', criteria.location);
  url.searchParams.set('sort_by', 'date');
  const data = await fetchJsonWithTimeout(url, fetchImpl);
  return (data.results || []).map((job) => ({
    sourceType: source.type,
    sourceName: source.name,
    externalId: String(job.id || job.redirect_url || ''),
    title: job.title || '',
    company: readableText(job.company),
    location: readableText(job.location?.display_name || job.location),
    remoteType: /remote/i.test(`${job.title} ${job.description} ${job.location?.display_name || ''}`) ? 'Remote' : '',
    employmentType: job.contract_type || job.contract_time || '',
    postedAt: normalizeDate(job.created),
    jobUrl: job.redirect_url || '',
    applyUrl: job.redirect_url || '',
    description: stripHtml(job.description || ''),
    salary: formatSalary(job.salary_min, job.salary_max, job.salary_is_predicted ? 'USD estimated' : 'USD'),
    skills: [],
  }));
}

async function fetchScrapeGraphLocal(source, criteria, careerOpsRoot) {
  const scriptPath = join(process.cwd(), 'tools', 'scrapegraph_discovery.py');
  if (!existsSync(scriptPath)) throw new Error('Local AI Scraper worker is missing.');
  const seedUrls = await scrapeGraphSeedUrls(source, careerOpsRoot);
  if (!seedUrls.length) {
    throw new Error('Local AI Scraper has no approved seed URLs. Add company careers URLs in Settings or Career-Ops portals.yml.');
  }
  const payload = {
    query: criteria.query || 'data engineer',
    location: criteria.location || '',
    seedUrls: seedUrls.slice(0, Number(source.maxPages || 8)),
    maxPages: Number(source.maxPages || 8),
    maxJobs: Number(source.limit || 15),
    timeoutMs: Number(source.timeoutMs || process.env.SCRAPEGRAPH_TIMEOUT_MS || 60000),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434',
    llmModel: process.env.SCRAPEGRAPH_LLM || process.env.OLLAMA_MODEL || 'ollama/llama3.2:1b',
    mock: process.env.SCRAPEGRAPH_MOCK === '1',
  };
  const result = await runScrapeGraphSidecar(scriptPath, payload);
  const jobs = (result.jobs || []).map((job) => ({
    sourceType: source.type,
    sourceName: source.name,
    externalId: String(job.externalId || canonicalizeUrl(job.applyUrl || job.jobUrl || '')),
    title: job.title || '',
    company: job.company || '',
    location: job.location || '',
    remoteType: job.remoteType || '',
    employmentType: job.employmentType || '',
    postedAt: job.postedAt || '',
    jobUrl: job.jobUrl || '',
    applyUrl: job.applyUrl || job.jobUrl || '',
    description: job.description || '',
    salary: job.salary || '',
    skills: Array.isArray(job.skills) ? job.skills : [],
    extractionConfidence: Number(job.extractionConfidence || job.confidence || 0),
    extractionWarnings: Array.isArray(job.extractionWarnings) ? job.extractionWarnings : [],
    sourcePayload: {
      extractedBy: 'scrapegraph_local',
      seedUrl: job.seedUrl || '',
      sourceEvidence: job.sourceEvidence || '',
    },
  }));
  return {
    jobs,
    providerTrace: result.providerTrace || [{ step: 'scrapegraph_local', status: 'completed', count: jobs.length }],
    diagnostics: result.diagnostics || null,
  };
}

async function fetchScrapeGraphCloud(source, criteria, careerOpsRoot, fetchImpl) {
  const apiKey = process.env.SCRAPEGRAPH_API_KEY;
  if (!apiKey) throw new Error('Add SCRAPEGRAPH_API_KEY to .env before enabling ScrapeGraph Cloud API.');
  const seedUrls = await scrapeGraphSeedUrls(source, careerOpsRoot);
  if (!seedUrls.length) {
    throw new Error('ScrapeGraph Cloud API has no approved seed URLs. Add company careers URLs in Settings or Career-Ops portals.yml.');
  }
  const jobs = [];
  const providerTrace = [];
  const timeoutMs = Number(source.timeoutMs || process.env.SCRAPEGRAPH_TIMEOUT_MS || 60000);
  for (const seedUrl of seedUrls.slice(0, Number(source.maxPages || 8))) {
    if (jobs.length >= Number(source.limit || 15)) break;
    try {
      const extracted = await scrapeGraphCloudExtract({
        apiKey,
        seedUrl,
        query: criteria.query || 'data engineer',
        location: criteria.location || '',
        timeoutMs,
        fetchImpl,
      });
      providerTrace.push({ step: 'scrapegraph_cloud', status: 'completed', url: seedUrl, count: extracted.length });
      jobs.push(...extracted.slice(0, Number(source.limit || 15) - jobs.length));
    } catch (error) {
      providerTrace.push({ step: 'scrapegraph_cloud', status: 'failed', url: seedUrl, error: publicScrapeGraphError(error.message || error) });
    }
  }
  return {
    jobs: jobs.map((job) => ({
      sourceType: source.type,
      sourceName: source.name,
      externalId: String(job.externalId || canonicalizeUrl(job.applyUrl || job.jobUrl || '')),
      title: job.title || '',
      company: job.company || '',
      location: job.location || '',
      remoteType: job.remoteType || '',
      employmentType: job.employmentType || '',
      postedAt: job.postedAt || '',
      jobUrl: job.jobUrl || '',
      applyUrl: job.applyUrl || job.jobUrl || '',
      description: job.description || '',
      salary: job.salary || '',
      skills: Array.isArray(job.skills) ? job.skills : [],
      extractionConfidence: Number(job.extractionConfidence || job.confidence || 0),
      extractionWarnings: Array.isArray(job.extractionWarnings) ? job.extractionWarnings : [],
      sourcePayload: {
        extractedBy: 'scrapegraph_cloud',
        seedUrl: job.seedUrl || '',
        sourceEvidence: job.sourceEvidence || '',
      },
    })),
    providerTrace,
    diagnostics: { provider: 'scrapegraph_cloud', cloudUsed: true, seedCount: seedUrls.length },
  };
}

async function scrapeGraphCloudExtract({ apiKey, seedUrl, query, location, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(5000, timeoutMs));
  try {
    const schema = {
      type: 'object',
      properties: {
        jobs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              company: { type: 'string' },
              location: { type: 'string' },
              remoteType: { type: 'string' },
              employmentType: { type: 'string' },
              postedAt: { type: 'string' },
              jobUrl: { type: 'string' },
              applyUrl: { type: 'string' },
              description: { type: 'string' },
              salary: { type: 'string' },
              skills: { type: 'array', items: { type: 'string' } },
              extractionConfidence: { type: 'number' },
              extractionWarnings: { type: 'array', items: { type: 'string' } },
              sourceEvidence: { type: 'string' },
            },
          },
        },
      },
    };
    const response = await fetchImpl('https://api.scrapegraphai.com/v1/extract', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'sgai-apikey': apiKey,
      },
      body: JSON.stringify({
        url: seedUrl,
        prompt: `Extract current public job postings related to ${query}${location ? ` in or compatible with ${location}` : ''}. Return null/empty values instead of guessing. Do not extract personal data.`,
        schema,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`ScrapeGraph Cloud returned HTTP ${response.status}`);
    const data = await response.json();
    return normalizeScrapeGraphCloudJobs(data, seedUrl);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeScrapeGraphCloudJobs(data, seedUrl) {
  const payload = data?.result || data?.data || data?.answer || data;
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : Array.isArray(payload) ? payload : [];
  return jobs
    .filter((job) => job && typeof job === 'object')
    .map((job) => ({
      ...job,
      seedUrl,
      jobUrl: isAllowedExtractedPublicUrl(job.jobUrl || job.applyUrl) ? (job.jobUrl || job.applyUrl) : seedUrl,
      applyUrl: isAllowedExtractedPublicUrl(job.applyUrl || job.jobUrl) ? (job.applyUrl || job.jobUrl) : seedUrl,
      extractionWarnings: Array.isArray(job.extractionWarnings) ? job.extractionWarnings : [],
    }))
    .filter((job) => cleanText(job.title));
}

function isAllowedExtractedPublicUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') return false;
    return !/(^|\.)linkedin\.com$|(^|\.)indeed\.com$|(^|\.)glassdoor\.com$|(^|\.)ziprecruiter\.com$|(^|\.)monster\.com$|(^|\.)dice\.com$/.test(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function runScrapeGraphSidecar(scriptPath, payload) {
  return new Promise((resolve, reject) => {
    const python = process.env.SCRAPEGRAPH_PYTHON || 'python';
    const child = spawn(python, [scriptPath], {
      cwd: process.cwd(),
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        OLLAMA_BASE_URL: payload.ollamaBaseUrl,
        SCRAPEGRAPH_LLM: payload.llmModel,
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Local AI Scraper timed out after ${Math.round(payload.timeoutMs / 1000)} seconds.`));
    }, Math.max(5000, Number(payload.timeoutMs || 60000)));

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 5_000_000) {
        child.kill();
        reject(new Error('Local AI Scraper returned too much data.'));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Local AI Scraper could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(publicScrapeGraphError(stderr || stdout || `worker exited ${code}`)));
        return;
      }
      try {
        const parsed = JSON.parse(stdout || '{}');
        if (parsed.ok === false) throw new Error(parsed.error || 'Local AI Scraper failed.');
        resolve(parsed);
      } catch (error) {
        reject(new Error(publicScrapeGraphError(error.message || stdout || stderr)));
      }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function scrapeGraphSeedUrls(source = {}, careerOpsRoot = '') {
  const configured = String(source.seedUrls || source.query || '')
    .split(/[\r\n,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const careerOps = loadCareerOpsCompanies(careerOpsRoot)
    .filter((company) => company.enabled !== false && company.careers_url && !detectAtsApi(company))
    .map((company) => company.careers_url);
  const candidates = [...configured, ...careerOps]
    .filter((url, index, arr) => arr.indexOf(url) === index)
    .slice(0, Number(source.maxPages || 8));
  const allowed = [];
  for (const url of candidates) {
    if (await isAllowedScrapeGraphSeed(url)) allowed.push(url);
  }
  return allowed;
}

async function isAllowedScrapeGraphSeed(rawUrl) {
  const check = await validatePublicUrl(rawUrl);
  if (!check.ok || !check.url) return false;
  try {
    const host = new URL(check.url).hostname.toLowerCase();
    if (/(^|\.)linkedin\.com$|(^|\.)indeed\.com$|(^|\.)glassdoor\.com$|(^|\.)ziprecruiter\.com$|(^|\.)monster\.com$|(^|\.)dice\.com$/.test(host)) return false;
    const literalType = net.isIP(host);
    if (literalType && isBlockedNetworkAddress(host)) return false;
    const addresses = await lookup(host, { all: true, verbatim: false }).catch(() => []);
    return addresses.length > 0 && addresses.every((address) => !isBlockedNetworkAddress(address.address));
  } catch {
    return false;
  }
}

function isBlockedNetworkAddress(address) {
  const normalized = String(address || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized) return true;
  if (normalized === '169.254.169.254') return true;
  if (normalized.includes(':')) {
    return normalized === '::1'
      || normalized === '0:0:0:0:0:0:0:1'
      || normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || normalized.startsWith('fe80:')
      || normalized.startsWith('::ffff:127.')
      || normalized.startsWith('::ffff:10.')
      || normalized.startsWith('::ffff:192.168.')
      || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(normalized);
  }
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

async function fetchJsonWithTimeout(url, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json', 'user-agent': 'career-ops-web/0.1' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function remotiveToJob(job, source) {
  return {
    sourceType: source.type,
    sourceName: source.name,
    externalId: String(job.id || ''),
    title: cleanText(job.title),
    company: cleanText(job.company_name),
    location: cleanText(job.candidate_required_location || 'Remote'),
    remoteType: 'Remote',
    employmentType: cleanText(job.job_type),
    postedAt: job.publication_date || '',
    jobUrl: job.url || '',
    applyUrl: job.url || '',
    description: stripHtml(job.description || ''),
    salary: cleanText(job.salary || ''),
    skills: Array.isArray(job.tags) ? job.tags.map(cleanText).filter(Boolean).slice(0, 12) : [],
    sourcePayload: { category: job.category, source: 'remotive' },
  };
}

function normalizeJob(raw, source, profilePreferences, criteria) {
  const now = new Date().toISOString();
  const applyUrl = raw.applyUrl || raw.jobUrl || '';
  const job = {
    sourceType: raw.sourceType || source.type,
    sourceName: raw.sourceName || source.name,
    source: raw.sourceName || source.name,
    externalId: raw.externalId || '',
    title: readableText(raw.title) || 'Unknown role',
    company: readableText(raw.company) || 'Unknown company',
    location: readableText(raw.location),
    remoteType: readableText(raw.remoteType),
    employmentType: readableText(raw.employmentType),
    postedAt: normalizeDate(raw.postedAt),
    discoveredAt: raw.discoveredAt || now,
    lastSeenAt: now,
    jobUrl: raw.jobUrl || raw.applyUrl || '',
    applyUrl,
    description: cleanText(raw.description || ''),
    salary: cleanText(raw.salary || ''),
    skills: Array.isArray(raw.skills) ? raw.skills.map(cleanText).filter(Boolean) : [],
    extractionConfidence: Number.isFinite(Number(raw.extractionConfidence)) ? Number(raw.extractionConfidence) : null,
    extractionWarnings: Array.isArray(raw.extractionWarnings) ? raw.extractionWarnings.map(cleanText).filter(Boolean).slice(0, 6) : [],
    sourcePayload: raw.sourcePayload || null,
    isActive: true,
  };
  job.canonicalUrl = canonicalizeUrl(job.applyUrl || job.jobUrl);
  job.sourceProvider = sourceProviderForJob(job);
  job.atsJobId = raw.atsJobId || inferAtsJobId(job.applyUrl || job.jobUrl);
  job.sourceTrust = sourceTrustForJob(job, source);
  job.directApply = isDirectApplyUrl(job.applyUrl || job.jobUrl);
  job.freshness = freshnessLabel(job.postedAt);
  const score = scoreJob(job, profilePreferences, criteria);
  job.quickScore = score.score;
  job.quickScoreBreakdown = score.breakdown;
  job.matchReasons = score.matchReasons;
  job.matchedSkills = score.matchedSkills;
  job.missingSkills = score.missingSkills;
  job.matchScoreFactors = score.factors;
  job.semanticScore = score.semanticScore;
  job.discoveryScoreVersion = 'phase2-hybrid-v3';
  job.scoreVersion = job.discoveryScoreVersion;
  if (['scrapegraph_local', 'scrapegraph_cloud'].includes(job.sourceType)) {
    job.discoveryScoreVersion = 'phase2-hybrid-ai-v3';
    job.scoreVersion = job.discoveryScoreVersion;
    job.matchReasons = uniqueTerms(['AI extracted; review original page', ...job.matchReasons]).slice(0, 6);
  }
  job.matchBucket = bucketForScore(score.score);
  job.summary = buildDiscoverySummary(job);
  return job;
}

function scoreJob(job, profilePreferences = {}, criteria = {}) {
  const titleTerms = expandedTitleTerms(criteria.query || profilePreferences.targetRoles || profilePreferences.currentRole);
  const resumeProfile = buildResumeMatchProfile(criteria.resumeText, profilePreferences);
  const skillTerms = resumeProfile.skills;
  const locationTerms = splitTerms(criteria.location || profilePreferences.targetLocations);
  const excludedTerms = splitTerms(profilePreferences.excludedKeywords);
  const watchCompanies = splitTerms(profilePreferences.companiesToWatch);
  const avoidCompanies = splitTerms(profilePreferences.companiesToAvoid);
  const text = normalizedText(`${job.title} ${job.company} ${job.location} ${job.description} ${job.skills?.join(' ')}`);
  const companyText = normalizedText(job.company);
  const titleText = normalizedText(job.title);
  const locationText = normalizedText(job.location);
  const breakdown = [];
  const matchReasons = [];
  const factors = {};
  let score = 0;

  const roleHits = titleTerms.filter((term) => titleMatchesTerm(titleText, term));
  if (hasDisallowedTitleForQuery(titleText, criteria.query)) {
    score -= 55;
    factors.role = -55;
    breakdown.push('Rejected title family');
  } else if (roleHits.length) {
    factors.role = titleExactMatch(titleText, criteria.query) ? 32 : 28;
    score += factors.role;
    breakdown.push(`Role match: ${roleHits.slice(0, 3).join(', ')}`);
    matchReasons.push(`Role/title matches ${roleHits.slice(0, 3).join(', ')}`);
  } else if (jobFamilyMatches(titleText, criteria.query)) {
    factors.role = 20;
    score += factors.role;
    breakdown.push('Related role family');
    matchReasons.push('Related role family');
  } else {
    factors.role = -30;
    score += factors.role;
    breakdown.push('Weak title match');
  }

  if (['career_ops_ats', 'career_ops_pipeline', 'curated_direct_ats', 'greenhouse', 'lever', 'ashby'].includes(job.sourceType)) {
    factors.source = 12;
    score += factors.source;
    breakdown.push('Direct company or Career-Ops source');
    matchReasons.push('Direct company or ATS source');
  } else if (isRemoteOnlySource(job.sourceType)) {
    factors.source = criteria.sourceScope === 'remote_boards' ? 0 : -16;
    score += factors.source;
    breakdown.push('Remote board source; verify fit');
  } else {
    factors.source = 5;
    score += factors.source;
  }

  if (job.applyUrl || job.jobUrl) {
    const direct = isDirectApplyUrl(job.applyUrl || job.jobUrl);
    factors.applyLink = direct ? 9 : 2;
    score += factors.applyLink;
    breakdown.push(direct ? 'Company or ATS apply link' : 'Job link available');
    if (direct) matchReasons.push('Direct company apply link');
  }

  const skillHits = skillTerms.filter((term) => text.includes(normalizedText(term))).slice(0, 10);
  const missingSkills = skillTerms.filter((term) => !skillHits.includes(term)).slice(0, 8);
  if (skillHits.length) {
    const coverage = skillHits.length / Math.max(4, Math.min(10, skillTerms.length || 4));
    factors.skills = Math.min(28, Math.round((skillHits.length * 4) + (coverage * 12)));
    score += factors.skills;
    breakdown.push(`Skill match: ${skillHits.join(', ')}`);
    matchReasons.push(`Resume skill match: ${skillHits.slice(0, 5).join(', ')}`);
  } else if (criteria.resumeText) {
    factors.skills = -18;
    score += factors.skills;
    breakdown.push('Resume skills not visible in posting');
  } else {
    factors.skills = 0;
  }

  const semantic = semanticJobResumeScore(job, resumeProfile);
  factors.semantic = semantic.score;
  score += factors.semantic;
  if (semantic.label) {
    breakdown.push(semantic.label);
    if (semantic.score >= 8) matchReasons.push(semantic.label);
  }

  if (/remote/i.test(profilePreferences.remotePreference || '') && /remote/i.test(`${job.remoteType} ${job.location}`)) {
    const remoteBoost = criteria.workMode && criteria.workMode !== 'remote' ? 0 : 3;
    factors.remotePreference = remoteBoost;
    score += remoteBoost;
    breakdown.push('Remote preference matched');
  }

  const locationHits = locationTerms.filter((term) => locationText.includes(normalizedText(term)) || normalizedText(term).includes('remote') && /remote/i.test(locationText));
  if (locationHits.length) {
    factors.location = 10;
    score += factors.location;
    breakdown.push(`Location match: ${locationHits.slice(0, 2).join(', ')}`);
    matchReasons.push(`Location match: ${locationHits.slice(0, 2).join(', ')}`);
  }

  const filterScore = scoreFilterCompatibility(job, criteria);
  factors.filters = filterScore.score;
  score += filterScore.score;
  breakdown.push(...filterScore.breakdown);

  const watchHits = watchCompanies.filter((term) => companyText.includes(normalizedText(term)));
  if (watchHits.length) {
    factors.watchCompany = 10;
    score += factors.watchCompany;
    breakdown.push(`Watch company: ${watchHits.slice(0, 2).join(', ')}`);
  }

  const avoidHits = avoidCompanies.filter((term) => companyText.includes(normalizedText(term)));
  if (avoidHits.length) {
    factors.avoidCompany = -45;
    score += factors.avoidCompany;
    breakdown.push(`Avoid company: ${avoidHits.slice(0, 2).join(', ')}`);
  }

  const excludedHits = excludedTerms.filter((term) => text.includes(normalizedText(term)));
  if (excludedHits.length) {
    factors.excludedKeywords = -Math.min(35, excludedHits.length * 12);
    score += factors.excludedKeywords;
    breakdown.push(`Excluded keyword: ${excludedHits.slice(0, 3).join(', ')}`);
  }

  const freshnessScore = scoreFreshness(job.postedAt);
  factors.freshness = freshnessScore.score;
  score += freshnessScore.score;
  if (freshnessScore.label) breakdown.push(freshnessScore.label);

  if (criteria.resumeText && score >= Number(criteria.minScore || 80) && skillHits.length < 2 && semantic.score < 10) {
    score = Math.min(score, 69);
    breakdown.push('Needs review: weak resume-to-job evidence');
  }

  if (!breakdown.length) breakdown.push('Basic discovery match; needs Career-Ops analysis.');
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    breakdown,
    matchReasons: uniqueTerms(matchReasons.length ? matchReasons : breakdown).slice(0, 6),
    matchedSkills: skillHits,
    missingSkills,
    factors,
    semanticScore: semantic.score,
  };
}

function bucketForScore(score) {
  if (score >= 80) return 'strong';
  if (score >= 55) return 'maybe';
  if (score < 35) return 'skipped';
  return 'new';
}

function buildDiscoverySummary(job) {
  const scoreText = Number.isFinite(Number(job.quickScore)) ? ` Quick score: ${job.quickScore}/100.` : '';
  const reasons = job.matchReasons?.length ? ` Reasons: ${job.matchReasons.slice(0, 3).join('; ')}.` : '';
  const confidence = ['scrapegraph_local', 'scrapegraph_cloud'].includes(job.sourceType) && Number.isFinite(Number(job.extractionConfidence))
    ? ` Extraction confidence: ${Math.round(Number(job.extractionConfidence))}%.`
    : '';
  const apply = job.directApply ? ' Direct company apply link found.' : ' Review the job link before applying.';
  return `Discovered ${job.title} at ${job.company}.${scoreText}${reasons}${confidence}${apply}`;
}

function discoveryTerms(profilePreferences = {}, criteria = {}) {
  const roles = expandedTitleTerms(criteria.query || profilePreferences.targetRoles || profilePreferences.currentRole);
  const skills = splitTerms(profilePreferences.preferredSkills);
  const preferred = [...roles, ...skills].filter(Boolean);
  return preferred.length ? preferred : ['data engineer'];
}

function filterSourcesByScope(sources, sourceScope) {
  if (sourceScope === 'all') return sources;
  if (sourceScope === 'direct') return sources.filter((source) => ['career_ops_ats', 'career_ops_pipeline', 'curated_direct_ats'].includes(source.type));
  if (sourceScope === 'balanced') return sources.filter((source) => ['career_ops_ats', 'career_ops_pipeline', 'curated_direct_ats', 'themuse', 'arbeitnow', 'adzuna'].includes(source.type));
  if (sourceScope === 'mixed_boards') return sources.filter((source) => ['themuse', 'arbeitnow', 'adzuna'].includes(source.type));
  if (sourceScope === 'remote_boards') return sources.filter((source) => ['himalayas', 'remotejobs_org', 'remotive'].includes(source.type));
  if (sourceScope === 'local_ai') return sources.filter((source) => ['scrapegraph_local', 'scrapegraph_cloud'].includes(source.type));
  if (sourceScope === 'ai_local_only') return sources.filter((source) => source.type === 'scrapegraph_local');
  if (sourceScope === 'ai_cloud_only') return sources.filter((source) => source.type === 'scrapegraph_cloud');
  if (sourceScope === 'boards') return sources.filter((source) => ['himalayas', 'remotejobs_org', 'themuse', 'arbeitnow', 'adzuna'].includes(source.type));
  return sources.filter((source) => source.trustLevel !== 'Low' && !['scrapegraph_local', 'scrapegraph_cloud'].includes(source.type));
}

function summarizeDiscovery(sourceResults) {
  return {
    sources: sourceResults.length,
    rawFound: sourceResults.reduce((sum, source) => sum + Number(source.rawCount || source.count || 0), 0),
    qualified: sourceResults.reduce((sum, source) => sum + Number(source.count || 0), 0),
    filtered: sourceResults.reduce((sum, source) => sum + Number(source.filteredCount || 0), 0),
    errors: sourceResults.filter((source) => source.status === 'failed').length,
  };
}

function normalizeCriteria(options = {}, profilePreferences = {}) {
  const resumeText = cleanText(options.resumeText || '');
  const query = cleanText(options.query || options.searchQuery || inferTargetQueryFromResume(resumeText) || profilePreferences.targetRoles || profilePreferences.currentRole);
  return {
    query,
    location: cleanText(options.location || options.locationQuery || profilePreferences.targetLocations),
    minScore: Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : 80,
    includeLowerMatches: Boolean(options.includeLowerMatches),
    sourceScope: cleanText(options.sourceScope || 'balanced'),
    workMode: normalizeChoice(options.workMode, ['', 'remote', 'hybrid', 'onsite']),
    employmentType: normalizeChoice(options.employmentType, ['', 'full_time', 'contract']),
    sponsorship: normalizeChoice(options.sponsorship, ['', 'avoid_no_sponsor', 'sponsor_only', 'no_sponsorship_needed']),
    resumeText,
  };
}

function inferTargetQueryFromResume(resumeText) {
  const text = normalizedText(resumeText);
  if (!text) return '';
  const roleSignals = [
    ['data engineer', ['data engineer', 'data engineering', 'etl', 'elt', 'spark', 'databricks', 'snowflake', 'data pipeline']],
    ['analytics engineer', ['analytics engineer', 'dbt', 'semantic layer', 'looker']],
    ['data analyst', ['data analyst', 'power bi', 'tableau', 'dashboard', 'reporting analyst']],
    ['software engineer', ['software engineer', 'full stack', 'frontend', 'backend', 'react', 'node.js']],
    ['cloud engineer', ['cloud engineer', 'devops', 'terraform', 'kubernetes', 'aws', 'azure']],
    ['business intelligence engineer', ['business intelligence', 'bi engineer', 'power bi', 'looker']],
  ];
  const ranked = roleSignals
    .map(([role, signals]) => ({ role, score: signals.reduce((sum, signal) => sum + (text.includes(signal) ? 1 : 0), 0) }))
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score ? ranked[0].role : '';
}

function isQualifiedDiscoveryJob(job, criteria) {
  if (!job.applyUrl && !job.jobUrl) return false;
  if (!hasUsefulTitleMatch(job, criteria)) return false;
  if (!isLocationCompatible(job, criteria)) return false;
  if (!isWorkModeCompatible(job, criteria)) return false;
  if (!isEmploymentCompatible(job, criteria)) return false;
  if (!isSponsorshipCompatible(job, criteria)) return false;
  if (!criteria.includeLowerMatches && Number(job.quickScore || 0) < Number(criteria.minScore || 80)) return false;
  return true;
}

function isLocationCompatible(job, criteria) {
  const wanted = normalizedText(criteria.location);
  if (!wanted) return true;
  const location = normalizedText(job.location);
  if (!location) return true;
  const wantsUs = /\b(united states|usa|u s|us|dallas|texas|tx|california|ca|new york|ny)\b/.test(wanted);
  if (!wantsUs) return true;
  const allowsRemote = /\bremote\b/.test(wanted);
  if (allowsRemote && /\b(remote|united states|usa|us only|u s)\b/.test(location)) return true;
  const nonUsSignals = [
    'canada', 'toronto', 'vancouver', 'brazil', 'sao paulo', 'são paulo', 'ukraine',
    'india', 'bengaluru', 'bangalore', 'hyderabad', 'pune', 'mumbai', 'delhi', 'gurgaon',
    'mexico', 'europe', 'germany', 'berlin', 'france', 'paris', 'spain',
    'united kingdom', 'london', 'ireland', 'dublin', 'netherlands', 'amsterdam',
    'poland', 'singapore', 'australia', 'argentina', 'colombia',
  ];
  return !nonUsSignals.some((signal) => location.includes(signal));
}

function hasUsefulTitleMatch(job, criteria) {
  const query = criteria.query || '';
  const title = job.title || '';
  if (!query) return true;
  if (hasDisallowedTitleForQuery(title, query)) return false;
  if (expandedTitleTerms(query).some((term) => titleMatchesTerm(title, term))) return true;
  const skillHits = extractResumeSkills(criteria.resumeText).filter((skill) => normalizedText(`${job.description || ''} ${job.skills?.join(' ')}`).includes(normalizedText(skill)));
  return jobFamilyMatches(title, query) && skillHits.length >= 2;
}

function isWorkModeCompatible(job, criteria) {
  const wanted = criteria.workMode;
  if (!wanted) return true;
  const text = normalizedText(`${job.remoteType || ''} ${job.location || ''} ${job.description || ''}`);
  if (wanted === 'remote') return /\b(remote|work from home|wfh)\b/.test(text);
  if (wanted === 'hybrid') return /\b(hybrid|office|onsite|on site|on-site|days in office)\b/.test(text) && !/\bfully remote\b/.test(text);
  if (wanted === 'onsite') return /\b(onsite|on site|on-site|in office|office based|office-based)\b/.test(text) && !/\bremote\b/.test(text);
  return true;
}

function isEmploymentCompatible(job, criteria) {
  const wanted = criteria.employmentType;
  if (!wanted) return true;
  const text = normalizedText(`${job.employmentType || ''} ${job.title || ''} ${job.description || ''}`);
  if (wanted === 'full_time') return /\b(full time|full-time|fulltime|permanent|regular)\b/.test(text) || !/\b(contract|contractor|temporary|part time|part-time|internship)\b/.test(text);
  if (wanted === 'contract') return /\b(contract|contractor|temporary|c2c|w2)\b/.test(text);
  return true;
}

function isSponsorshipCompatible(job, criteria) {
  const wanted = criteria.sponsorship;
  if (!wanted || wanted === 'no_sponsorship_needed') return true;
  const text = normalizedText(`${job.title || ''} ${job.company || ''} ${job.description || ''}`);
  const noSponsor = /\b(no sponsorship|unable to sponsor|cannot sponsor|not sponsor|without sponsorship|will not sponsor)\b/.test(text)
    || /must be authorized to work.{0,80}without/.test(text);
  const sponsorMention = /\b(sponsor|sponsorship|h-?1b|visa|work authorization|green card|uscis)\b/.test(text);
  if (wanted === 'avoid_no_sponsor') return !noSponsor;
  if (wanted === 'sponsor_only') return sponsorMention && !noSponsor;
  return true;
}

function loadCareerOpsCompanies(careerOpsRoot) {
  const file = join(careerOpsRoot || '', 'portals.yml');
  if (!careerOpsRoot || !existsSync(file)) return [];
  const text = readFileSync(file, 'utf-8');
  const companiesText = text.split(/\ntracked_companies:\s*\n/)[1] || '';
  const blocks = companiesText.split(/\n\s*-\s+name:\s+/).slice(1);
  return blocks.map((block) => {
    const lines = block.split(/\r?\n/);
    const company = { name: cleanText(lines[0] || '') };
    for (const line of lines) {
      const match = line.match(/^\s*([a-zA-Z_]+):\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      const value = cleanText(match[2]).replace(/^["']|["']$/g, '');
      if (key === 'enabled') company.enabled = value.toLowerCase() !== 'false';
      else company[key] = value;
    }
    return company;
  }).filter((company) => company.name);
}

function detectAtsApi(company) {
  if (company.api && company.api.includes('greenhouse')) return { type: 'greenhouse', url: company.api };
  const url = company.careers_url || '';
  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) return { type: 'ashby', url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true` };
  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) return { type: 'lever', url: `https://api.lever.co/v0/postings/${leverMatch[1]}` };
  const greenhouseMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)|boards\.greenhouse\.io\/([^/?#]+)/);
  const greenhouseBoard = greenhouseMatch?.[1] || greenhouseMatch?.[2];
  if (greenhouseBoard) return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${greenhouseBoard}/jobs` };
  return null;
}

function parseAtsJobs(data, company, type) {
  if (type === 'greenhouse') {
    return (data.jobs || []).map((job) => ({
      sourceType: 'greenhouse',
      sourceName: `${company.name} Greenhouse`,
      externalId: String(job.id || ''),
      title: job.title || '',
      company: company.name,
      location: job.location?.name || '',
      postedAt: job.updated_at || '',
      jobUrl: job.absolute_url || '',
      applyUrl: job.absolute_url || '',
      description: stripHtml(job.content || ''),
      skills: [],
    }));
  }
  if (type === 'ashby') {
    return (data.jobs || []).map((job) => ({
      sourceType: 'ashby',
      sourceName: `${company.name} Ashby`,
      externalId: String(job.id || ''),
      title: job.title || '',
      company: company.name,
      location: job.location || '',
      postedAt: job.publishedDate || '',
      jobUrl: job.jobUrl || '',
      applyUrl: job.jobUrl || '',
      description: stripHtml(job.descriptionPlain || job.descriptionHtml || ''),
      salary: formatCompensation(job.compensation),
      skills: [],
    }));
  }
  if (type === 'lever' && Array.isArray(data)) {
    return data.map((job) => ({
      sourceType: 'lever',
      sourceName: `${company.name} Lever`,
      externalId: String(job.id || ''),
      title: job.text || '',
      company: company.name,
      location: job.categories?.location || '',
      postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : '',
      jobUrl: job.hostedUrl || '',
      applyUrl: job.hostedUrl || '',
      description: stripHtml([job.descriptionPlain, job.lists?.map((list) => `${list.text} ${list.content}`).join(' ')].filter(Boolean).join(' ')),
      employmentType: job.categories?.commitment || '',
      skills: [],
    }));
  }
  return [];
}

function titleMatchesCriteria(title, criteria) {
  const terms = expandedTitleTerms(criteria.query);
  if (!terms.length) return true;
  return terms.some((term) => titleMatchesTerm(title, term));
}

function expandedTitleTerms(value) {
  const base = splitTerms(value);
  const expanded = [];
  for (const term of base) {
    const text = normalizedText(term);
    expanded.push(term);
    if (text.includes('senior data engineer')) expanded.push('data engineer', 'analytics engineer', 'etl engineer');
    else if (text.includes('data engineer')) expanded.push('analytics engineer', 'etl engineer', 'data engineering');
    else if (text.includes('analytics engineer')) expanded.push('data engineer', 'bi engineer');
    else if (text.includes('business intelligence')) expanded.push('bi engineer', 'data analyst', 'analytics engineer');
    else if (text.includes('cloud engineer')) expanded.push('devops engineer', 'platform engineer');
  }
  return uniqueTerms(expanded);
}

function titleMatchesTerm(title, term) {
  const titleText = normalizedText(title);
  const termText = normalizedText(term);
  if (!termText) return false;
  if (titleText.includes(termText)) return true;
  if (termText === 'data engineer') {
    return titleText.includes('data engineering')
      || titleText.includes('analytics engineer')
      || titleText.includes('bi engineer')
      || titleText.includes('business intelligence engineer')
      || titleText.includes('etl engineer')
      || titleText.includes('elt engineer');
  }
  if (termText === 'senior data engineer') {
    return titleText.includes('senior data engineer')
      || titleText.includes('staff data engineer')
      || titleText.includes('lead data engineer')
      || titleText.includes('principal data engineer')
      || titleText.includes('senior data engineering');
  }
  return false;
}

function titleExactMatch(titleText, query) {
  const queryText = normalizedText(query);
  if (!queryText) return false;
  return titleText.includes(queryText);
}

function jobFamilyMatches(title, query) {
  const titleText = normalizedText(title);
  const queryText = normalizedText(query);
  if (!queryText) return true;
  if (/data engineer|analytics engineer|business intelligence|data analyst/.test(queryText)) {
    return /\b(data|analytics|bi|business intelligence|etl|elt|warehouse)\b/.test(titleText)
      && /\b(engineer|analyst|developer|architect)\b/.test(titleText);
  }
  if (/software|frontend|backend|full stack/.test(queryText)) {
    return /\b(software|frontend|backend|full stack|fullstack|web)\b/.test(titleText)
      && /\b(engineer|developer)\b/.test(titleText);
  }
  if (/cloud|devops|platform/.test(queryText)) {
    return /\b(cloud|devops|platform|infrastructure|site reliability|sre)\b/.test(titleText);
  }
  return false;
}

function hasDisallowedTitleForQuery(title, query) {
  const titleText = normalizedText(title);
  const queryText = normalizedText(query);
  if (/data engineer|analytics engineer|business intelligence|data analyst/.test(queryText)) {
    return /\b(product manager|program manager|project manager|copywriter|writer|sales|account executive|recruiter|marketing|designer|ios developer|frontend|front end|mobile engineer)\b/.test(titleText);
  }
  return false;
}

function scoreFilterCompatibility(job, criteria) {
  const breakdown = [];
  let score = 0;
  if (criteria.workMode && isWorkModeCompatible(job, criteria)) {
    score += 7;
    breakdown.push(`Work mode match: ${criteria.workMode}`);
  } else if (criteria.workMode) {
    score -= 30;
    breakdown.push(`Work mode mismatch: ${criteria.workMode}`);
  }
  if (criteria.employmentType && isEmploymentCompatible(job, criteria)) {
    score += 5;
    breakdown.push(`Job type match: ${criteria.employmentType.replace('_', ' ')}`);
  } else if (criteria.employmentType) {
    score -= 25;
    breakdown.push(`Job type mismatch: ${criteria.employmentType.replace('_', ' ')}`);
  }
  if (criteria.sponsorship && criteria.sponsorship !== 'no_sponsorship_needed') {
    if (isSponsorshipCompatible(job, criteria)) {
      score += criteria.sponsorship === 'sponsor_only' ? 8 : 3;
      breakdown.push('Sponsorship filter passed');
    } else {
      score -= 40;
      breakdown.push('Sponsorship conflict');
    }
  }
  return { score, breakdown };
}

function isRemoteOnlySource(sourceType) {
  return ['himalayas', 'remotejobs_org', 'remotive'].includes(sourceType);
}

function isDirectApplyUrl(rawUrl) {
  return /greenhouse|lever\.co|ashbyhq|myworkdayjobs|workdayjobs|jobvite|smartrecruiters|icims|applytojob|jazzhr/i.test(String(rawUrl || ''));
}

function sourceProviderForJob(job = {}) {
  const text = `${job.sourceType || ''} ${job.sourceName || ''} ${job.applyUrl || ''} ${job.jobUrl || ''}`.toLowerCase();
  if (text.includes('greenhouse')) return 'Greenhouse';
  if (text.includes('lever')) return 'Lever';
  if (text.includes('ashby')) return 'Ashby';
  if (text.includes('workday')) return 'Workday';
  if (text.includes('smartrecruiters')) return 'SmartRecruiters';
  if (text.includes('icims')) return 'iCIMS';
  if (text.includes('adzuna')) return 'Adzuna';
  if (text.includes('themuse') || text.includes('the muse')) return 'The Muse';
  if (text.includes('arbeitnow')) return 'Arbeitnow';
  if (text.includes('himalayas')) return 'Himalayas';
  if (text.includes('remotejobs')) return 'RemoteJobs.org';
  return cleanText(job.sourceName || job.sourceType || '');
}

function sourceTrustForJob(job = {}, source = {}) {
  if (source.trustLevel) return source.trustLevel;
  if (['career_ops_ats', 'curated_direct_ats', 'greenhouse', 'lever', 'ashby'].includes(job.sourceType)) return 'High';
  if (['career_ops_pipeline', 'themuse', 'arbeitnow', 'adzuna'].includes(job.sourceType)) return 'Medium';
  return 'Low';
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

function scoreFreshness(postedAt) {
  if (!postedAt) return { score: 0, label: '' };
  const ageDays = Math.floor((Date.now() - Date.parse(postedAt)) / 86400000);
  if (!Number.isFinite(ageDays)) return { score: 0, label: '' };
  if (ageDays <= 7) return { score: 6, label: 'Fresh posting: last 7 days' };
  if (ageDays <= 21) return { score: 3, label: 'Recent posting: last 21 days' };
  if (ageDays > 60) return { score: -8, label: 'Older posting; verify still active' };
  return { score: 0, label: '' };
}

function freshnessLabel(postedAt) {
  if (!postedAt) return 'Unknown freshness';
  const ageDays = Math.floor((Date.now() - Date.parse(postedAt)) / 86400000);
  if (!Number.isFinite(ageDays)) return 'Unknown freshness';
  if (ageDays <= 7) return 'Fresh';
  if (ageDays <= 21) return 'Recent';
  if (ageDays <= 60) return 'Older';
  return 'Stale';
}

function formatCompensation(compensation) {
  if (!compensation) return '';
  if (typeof compensation === 'string') return cleanText(compensation);
  const parts = [compensation.compensationTierSummary, compensation.summary, compensation.currencyCode].filter(Boolean);
  return cleanText(parts.join(' '));
}

function formatHimalayasLocation(job) {
  const restrictions = Array.isArray(job.locationRestrictions) ? job.locationRestrictions.map((item) => item.name).filter(Boolean) : [];
  return restrictions.length ? restrictions.join(', ') : 'Worldwide Remote';
}

function formatTheMuseLocations(locations) {
  if (!Array.isArray(locations)) return '';
  return cleanText(locations.map(readableText).filter(Boolean).join(', '));
}

function formatSalary(minSalary, maxSalary, currency) {
  if (!minSalary && !maxSalary) return '';
  const cur = currency || 'USD';
  if (minSalary && maxSalary) return `${cur} ${Number(minSalary).toLocaleString()} - ${Number(maxSalary).toLocaleString()}`;
  if (minSalary) return `${cur} ${Number(minSalary).toLocaleString()}+`;
  return `${cur} up to ${Number(maxSalary).toLocaleString()}`;
}

function inferGuidedProvider(name, query) {
  const text = normalizedText(`${name} ${query}`);
  if (text.includes('ashby')) return 'Ashby';
  if (text.includes('greenhouse')) return 'Greenhouse';
  if (text.includes('lever')) return 'Lever';
  if (text.includes('workable')) return 'Workable';
  if (text.includes('linkedin')) return 'LinkedIn Indexed';
  if (text.includes('indeed')) return 'Indeed Indexed';
  if (text.includes('dice')) return 'Dice';
  if (text.includes('built in') || text.includes('builtin')) return 'Built In';
  if (text.includes('ziprecruiter')) return 'ZipRecruiter';
  if (text.includes('wellfound')) return 'Wellfound';
  if (text.includes('otta') || text.includes('welcome to the jungle')) return 'Otta / Welcome to the Jungle';
  if (text.includes('usajobs')) return 'USAJobs';
  if (text.includes('careerbuilder')) return 'CareerBuilder';
  if (text.includes('simplyhired')) return 'SimplyHired';
  if (text.includes('talent.com')) return 'Talent.com';
  if (text.includes('applytojob') || text.includes('jazzhr')) return 'JazzHR / ApplyToJob';
  if (text.includes('jobvite')) return 'Jobvite';
  if (text.includes('smartrecruiters')) return 'SmartRecruiters';
  if (text.includes('icims')) return 'iCIMS';
  if (text.includes('workday')) return 'Workday';
  return 'Search';
}

function guidedCategory(provider) {
  if (['Ashby', 'Greenhouse', 'Lever', 'Workable', 'Jobvite', 'SmartRecruiters', 'iCIMS', 'Workday', 'JazzHR / ApplyToJob'].includes(provider)) {
    return 'ATS Search';
  }
  if (['Dice', 'Built In', 'Wellfound', 'Otta / Welcome to the Jungle', 'USAJobs'].includes(provider)) return 'Curated Board';
  if (['LinkedIn Indexed', 'Indeed Indexed', 'ZipRecruiter', 'CareerBuilder', 'SimplyHired', 'Talent.com'].includes(provider)) return 'Aggregator Search';
  return 'Guided Search';
}

function guidedTrustLevel(provider) {
  if (['Ashby', 'Greenhouse', 'Lever', 'Workable', 'Jobvite', 'SmartRecruiters', 'iCIMS', 'Workday', 'JazzHR / ApplyToJob'].includes(provider)) return 'High';
  if (['Dice', 'Built In', 'Wellfound', 'Otta / Welcome to the Jungle', 'USAJobs'].includes(provider)) return 'Medium';
  return 'Low';
}

function guidedNotes(provider) {
  if (guidedTrustLevel(provider) === 'High') return 'Use this to find direct ATS jobs. Open a result, then analyze the specific job URL.';
  if (guidedTrustLevel(provider) === 'Medium') return 'Useful board for targeted discovery. Prefer direct company apply links when available.';
  return 'Broad search source. Use only for research; do not bulk-import results without reviewing the job detail.';
}

function slugify(value) {
  return cleanText(value).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
}

function splitTerms(value) {
  return String(value || '')
    .split(/[,;\n|]/)
    .map((item) => cleanText(item))
    .filter(Boolean)
    .slice(0, 30);
}

function normalizeChoice(value, allowed) {
  const text = cleanText(value);
  return allowed.includes(text) ? text : '';
}

function uniqueTerms(items) {
  return [...new Set((items || []).map(cleanText).filter(Boolean))].slice(0, 60);
}

function buildResumeMatchProfile(resumeText, profilePreferences = {}) {
  const preferredSkills = splitTerms(profilePreferences.preferredSkills);
  const skills = uniqueTerms([...preferredSkills, ...extractResumeSkills(resumeText)]).slice(0, 18);
  const text = normalizedText(resumeText);
  const roleTerms = expandedTitleTerms(profilePreferences.targetRoles || profilePreferences.currentRole || inferTargetQueryFromResume(resumeText));
  const domainTerms = [
    'data pipeline', 'etl', 'elt', 'warehouse', 'lakehouse', 'analytics', 'reporting', 'databricks',
    'snowflake', 'spark', 'azure', 'power bi', 'data modeling', 'production support', 'ci cd',
    'orchestration', 'batch', 'cdc', 'quality', 'validation', 'telecom', 'banking', 'retail',
  ].filter((term) => text.includes(term));
  return {
    text,
    skills,
    roleTerms: uniqueTerms(roleTerms),
    domainTerms: uniqueTerms(domainTerms),
    weightedTerms: extractWeightedResumeTerms(resumeText, skills, domainTerms),
  };
}

function semanticJobResumeScore(job, profile) {
  if (!profile?.text) return { score: 0, label: '' };
  const jobText = normalizedText(`${job.title || ''} ${job.company || ''} ${job.location || ''} ${job.description || ''} ${(job.skills || []).join(' ')}`);
  if (!jobText) return { score: 0, label: '' };
  const weightedTerms = profile.weightedTerms || [];
  const hits = weightedTerms.filter((term) => jobText.includes(normalizedText(term))).slice(0, 10);
  const roleHits = (profile.roleTerms || []).filter((term) => jobText.includes(normalizedText(term))).slice(0, 4);
  const domainHits = (profile.domainTerms || []).filter((term) => jobText.includes(normalizedText(term))).slice(0, 5);
  const coverage = hits.length / Math.max(6, Math.min(14, weightedTerms.length || 6));
  let score = Math.round(Math.min(18, (coverage * 14) + roleHits.length * 2 + domainHits.length));
  if (hits.length < 2 && !roleHits.length) score = Math.min(score, 4);
  const labelParts = uniqueTerms([...roleHits, ...domainHits, ...hits]).slice(0, 5);
  return {
    score,
    label: labelParts.length ? `Semantic resume overlap: ${labelParts.join(', ')}` : '',
  };
}

function extractWeightedResumeTerms(resumeText, skills = [], domainTerms = []) {
  const text = normalizedText(resumeText);
  if (!text) return [];
  const phrases = [
    ...skills,
    ...domainTerms,
    'senior data engineer', 'data engineer', 'analytics engineer', 'azure data factory',
    'data pipeline', 'data pipelines', 'spark workloads', 'databricks notebooks',
    'snowflake transformation', 'etl workflows', 'elt workflows', 'delta lake',
    'bronze silver gold', 'control m', 'power bi', 'production support',
  ].filter((term) => text.includes(normalizedText(term)));
  const tokens = text
    .replace(/[^a-z0-9+#.\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !MATCH_STOP_WORDS.has(word))
    .filter((word) => !/^\d+$/.test(word));
  const counts = new Map();
  for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
  const topTokens = [...counts.entries()]
    .filter(([word]) => /^(azure|data|spark|pyspark|sql|python|snowflake|databricks|pipeline|etl|elt|analytics|reporting|warehouse|modeling|quality|production|cicd|git|airflow|dbt|tableau|power|bi|control|delta|lake)$/.test(word))
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word)
    .slice(0, 18);
  return uniqueTerms([...phrases, ...topTokens]).slice(0, 28);
}

function extractResumeSkills(resumeText) {
  const text = normalizedText(resumeText);
  if (!text) return [];
  const known = [
    'Python', 'SQL', 'Spark', 'PySpark', 'Databricks', 'Snowflake', 'Azure Data Factory', 'ADF',
    'Azure', 'AWS', 'GCP', 'ETL', 'ELT', 'Airflow', 'Control-M', 'Power BI', 'Tableau',
    'Data Modeling', 'Dimensional Modeling', 'Star Schema', 'Delta Lake', 'Kafka',
    'dbt', 'CI/CD', 'Git', 'Jenkins', 'Azure DevOps', 'SSIS', 'PL/SQL', 'CDC',
    'Data Warehousing', 'Lakehouse', 'Bronze', 'Silver', 'Gold', 'RAG',
  ];
  return known.filter((skill) => text.includes(normalizedText(skill)));
}

function stripHtml(value) {
  return cleanText(String(value || '').replace(/<[^>]+>/g, ' '));
}

function readableText(value) {
  if (value === null || value === undefined) return '';
  if (['string', 'number', 'boolean'].includes(typeof value)) return cleanText(value);
  if (typeof value === 'object') {
    return cleanText(value.name || value.companyName || value.displayName || value.title || value.label || value.text || value.url || '');
  }
  return cleanText(value);
}

function normalizeDate(value) {
  if (!value) return '';
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const millis = numeric < 100000000000 ? numeric * 1000 : numeric;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizedText(value) {
  return cleanText(value).toLowerCase();
}

function publicSourceError(error) {
  const message = String(error?.message || error || 'Source failed.');
  if (/spawn\s+eperm|access is denied/i.test(message)) {
    return 'Local worker was blocked by Windows permissions. Restart the app normally with start-web.bat, then retry this source.';
  }
  if (message.toLowerCase().includes('abort')) return 'Discovery source timed out.';
  return message.length > 260 ? `${message.slice(0, 260)}...` : message;
}

function publicScrapeGraphError(error) {
  const message = String(error || 'Local AI Scraper failed.');
  const lower = message.toLowerCase();
  if (lower.includes('no module named') || lower.includes('scrapegraphai')) {
    return 'Local AI Scraper is not installed. Install scrapegraphai and Playwright for Python, or keep this source off.';
  }
  if (lower.includes('ollama') || lower.includes('connection refused')) {
    return 'Ollama is not reachable. Start Ollama and pull the configured model, or keep Local AI Scraper off.';
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return 'Local AI Scraper timed out. Try fewer seed URLs or a narrower company careers page.';
  }
  return message.replace(/[A-Z]:\\[^ "'\n\r]+/g, '<local path>').slice(0, 360);
}
