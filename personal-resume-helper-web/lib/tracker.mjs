import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const RESUME_WORKSPACE_ROOT = resolve(process.env.RESUME_WORKSPACE_PATH || process.env.CAREER_OPS_PATH || join(process.cwd(), '..', 'Resume-Workspace'));
const APPLICATIONS_PATH = join(RESUME_WORKSPACE_ROOT, 'data', 'applications.md');

export function parseApplicationsTracker() {
  if (!existsSync(APPLICATIONS_PATH)) return [];
  const lines = readFileSync(APPLICATIONS_PATH, 'utf-8').split(/\r?\n/);
  return lines
    .filter((line) => /^\|\s*\d+\s*\|/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      return {
        number: cells[0],
        date: cells[1],
        company: cells[2],
        role: cells[3],
        score: cells[4],
        status: cells[5],
        pdf: cells[6],
        report: cells[7],
        notes: cells[8],
      };
    });
}

export function appendTrackerEntry(result, applicationStatus = 'Resume Ready') {
  const rows = parseApplicationsTracker();
  const nextNumber = rows.reduce((max, row) => Math.max(max, Number(row.number) || 0), 0) + 1;
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = result.reportPath ? normalizeRelative(result.reportPath) : '';
  const pdfPath = result.resumePdfPath ? normalizeRelative(result.resumePdfPath) : '';
  const reportCell = reportPath ? `[${String(nextNumber).padStart(3, '0')}](${reportPath.replaceAll('\\', '/')})` : 'No';
  const pdfCell = pdfPath ? 'Yes' : 'No';
  const score = result.score ? `${normalizeScore(result.score)}/5` : 'Pending';
  const notes = escapeCell(result.summary || result.recommendation || 'Created from Personal Resume Helper Web App.');
  const line = `| ${nextNumber} | ${today} | ${escapeCell(result.company || 'Unknown')} | ${escapeCell(result.title || 'Unknown role')} | ${score} | ${applicationStatus} | ${pdfCell} | ${reportCell} | ${notes} |\n`;

  let text = existsSync(APPLICATIONS_PATH) ? readFileSync(APPLICATIONS_PATH, 'utf-8') : defaultTracker();
  if (!text.endsWith('\n')) text += '\n';
  text += line;
  writeFileSync(APPLICATIONS_PATH, text, 'utf-8');
  return { number: nextNumber, reportPath, pdfPath };
}

function defaultTracker() {
  return [
    '# Applications Tracker',
    '',
    '| # | Date | Company | Role | Score | Status | PDF | Report | Notes |',
    '|---|------|---------|------|-------|--------|-----|--------|-------|',
    '',
  ].join('\n');
}

function normalizeRelative(filePath) {
  if (!filePath) return '';
  if (!filePath.includes(':') && !filePath.startsWith('/')) return filePath;
  return relative(RESUME_WORKSPACE_ROOT, filePath);
}

function normalizeScore(score) {
  const numeric = Number(score);
  if (!Number.isFinite(numeric)) return score;
  return numeric > 5 ? (numeric / 20).toFixed(1) : numeric.toFixed(1);
}

function escapeCell(value) {
  return String(value || '').replaceAll('|', '/').replace(/\s+/g, ' ').trim();
}
