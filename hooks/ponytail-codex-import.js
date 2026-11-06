#!/usr/bin/env node
// Manual, local-only history import. Codex owns the transcripts; only our ledger is refreshed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { CSV_HEADER } = require('./ponytail-band-import');
const CODEX_CSV_HEADER = `${CSV_HEADER},workspace,branch,timed_turns`;

function renderer() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 18) || major === 23) {
    throw new Error('Codex Board import requires Node 22.18+ or Node 24+.');
  }
  return require('./band/board.ts');
}

async function* readRecords(file) {
  const input = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch { yield { type: 'invalid_record' }; }
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

const count = n => Number.isSafeInteger(n) && n >= 0;
const usageOf = u => u && count(u.total_tokens) && count(u.output_tokens) && u.output_tokens <= u.total_tokens
  ? { tokens: u.total_tokens, output: u.output_tokens } : null;
const timestamp = t => typeof t === 'string' ? Date.parse(t) : NaN;

async function sessionStats(records) {
  let meta, startedMs, usage = null, modernUsage = false, malformed = 0;
  const models = new Set(), turns = new Map();
  let currentTurn;
  for await (const r of records) {
    if (!r || typeof r !== 'object') continue;
    const p = r.payload || {};
    if (r.type === 'invalid_record') malformed++;
    if (r.type === 'session_meta' && !meta) {
      // Copied fork/subagent histories can contain their parent's usage and turns.
      // shortcut: omit forks and subagents; add response ownership accounting before including them.
      if (p.parent_thread_id || (p.source && typeof p.source === 'object') || p.source === 'subagent') return null;
      if (typeof (p.id || p.session_id) !== 'string' || typeof p.cwd !== 'string') return null;
      const remote = typeof p.git?.repository_url === 'string' ? p.git.repository_url : '';
      meta = { id: p.id || p.session_id, cwd: p.cwd,
        repository: remote.replace(/[?#].*$/, '').replace(/[\\/]+$/, '').split(/[\\/:]/).pop().replace(/\.git$/i, ''),
        branch: typeof p.git?.branch === 'string' ? p.git.branch : '' };
      startedMs = timestamp(p.timestamp || r.timestamp);
    }
    if (!meta) continue;
    if (r.type === 'turn_context') {
      if (typeof p.model === 'string') models.add(p.model);
      if (typeof p.turn_id === 'string') currentTurn = p.turn_id;
    }
    let next;
    if (r.type === 'token_usage_record' && p.thread_id === meta.id) next = usageOf(p.thread_token_usage);
    if (r.type === 'event_msg' && p.type === 'token_count' && !modernUsage) next = usageOf(p.info?.total_token_usage);
    if (r.type === 'compacted') {
      const u = p.latest_token_usage_record;
      if (u?.thread_id === meta.id) next = usageOf(u.thread_token_usage);
    }
    if (next && r.type !== 'event_msg') modernUsage = true;
    // Prefer owned modern counters: legacy mirrors can lag. Never add snapshots or cache/reasoning subsets.
    // A counter reset is ambiguous; leave usage unavailable rather than guessing across epochs.
    if (next) {
      if (usage && (next.tokens < usage.tokens || next.output < usage.output)) usage = { tokens: null, output: null };
      else if (!usage || usage.tokens !== null) usage = next;
    }
    if (r.type !== 'event_msg') continue;
    const id = p.turn_id || currentTurn;
    if (typeof id !== 'string') continue;
    if (p.type === 'task_started') {
      currentTurn = id;
      if (!turns.has(id)) turns.set(id, { start: timestamp(r.timestamp), end: null });
    }
    if (p.type === 'task_complete' || p.type === 'turn_aborted') {
      const turn = turns.get(id) || { start: NaN, end: null };
      turn.end = timestamp(r.timestamp);
      turns.set(id, turn);
    }
  }
  if (!meta || !Number.isFinite(startedMs)) return null;
  const intervals = [...turns.values()];
  const timed = intervals.filter(t => Number.isFinite(t.start) && Number.isFinite(t.end) && t.end >= t.start);
  return {
    ...meta, startedMs, malformed,
    model: [...models].join(' / '),
    tokens: usage?.tokens ?? null, output: usage?.output ?? null,
    turns: intervals.length || null,
    timedTurns: timed.length,
    agentMs: timed.length ? timed.reduce((sum, t) => sum + t.end - t.start, 0) : null,
  };
}

const field = v => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const two = n => String(n).padStart(2, '0');
// Recorded repository names also join separate branch checkouts and deleted worktrees.
// shortcut: names are the group key; include remote identity if same-named repositories need separating.
function projectOf(s) {
  if (s.repository) return s.repository;
  let dir = s.cwd;
  while (dir) {
    const marker = path.join(dir, '.git');
    try {
      if (fs.statSync(marker).isDirectory()) return path.basename(dir);
      const pointer = /^gitdir:\s*(.+)\s*$/m.exec(fs.readFileSync(marker, 'utf8'));
      if (pointer) {
        const gitDir = path.resolve(dir, pointer[1].trim());
        const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
        return path.basename(path.dirname(common));
      }
    } catch (e) { if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(e.code)) throw e; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return 'Other chats';
}

async function sessionTitles(codexHome) {
  const titles = new Map();
  try {
    for await (const r of readRecords(path.join(codexHome, 'session_index.jsonl'))) {
      if (typeof r?.id === 'string' && typeof r.thread_name === 'string' && r.thread_name.trim()) {
        titles.set(r.id, r.thread_name.trim().replace(/\s+/g, ' ').slice(0, 120));
      }
    }
  } catch (e) { if (!['ENOENT', 'EACCES', 'EPERM'].includes(e.code)) throw e; }
  return titles;
}

function csvRow(s, project = projectOf(s), title = '') {
  const d = new Date(s.startedMs);
  const started = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  const workspace = s.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  return [`codex:${s.id}`, started, project, title || `Session ${started} · ${s.id.slice(-6)}`, '', s.turns,
    s.agentMs === null ? '' : (s.agentMs / 60000).toFixed(3), s.tokens, s.output, '', '', '', '', '', 'import', s.model,
    workspace, s.branch, s.timedTurns];
}

function sessionFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...sessionFiles(file));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file);
  }
  return files.sort();
}

function readOptional(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

// A failed import/render must not truncate the last usable ledger or board.
function writeAtomic(file, text) {
  const temp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(temp, text, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

async function run({ codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
  dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'ponytail', 'band'),
  now = Date.now() } = {}) {
  const { parseCsv, tasksFrom, boardHtml } = renderer();
  const roots = ['sessions', 'archived_sessions'].map(d => path.join(codexHome, d)).filter(d => fs.existsSync(d));
  if (!roots.length) throw new Error('No Codex session history found. Set CODEX_HOME to the directory containing sessions or archived_sessions.');
  const ledger = path.join(dir, 'codex', 'sessions.csv');
  const existing = readOptional(ledger);
  const [head, ...oldRows] = parseCsv(existing);
  if (existing && (![CSV_HEADER, CODEX_CSV_HEADER].includes(head?.join(',')) || oldRows.some(row => row.length !== head.length || !row[0].startsWith('codex:')))) {
    throw new Error('Unrecognized Codex ledger header or row; existing data was left untouched.');
  }
  const rows = new Map(oldRows.map(row => [row[0], [...row, ...Array(CODEX_CSV_HEADER.split(',').length - row.length).fill('')]]));
  const titles = await sessionTitles(codexHome), projects = new Map();
  const found = new Map();
  let skipped = 0, malformed = 0;
  for (const file of roots.flatMap(sessionFiles)) {
    let stats;
    try { stats = await sessionStats(readRecords(file)); }
    catch (e) { if (e.code === 'ENOENT' || e.code === 'EACCES' || e.code === 'EPERM') { skipped++; continue; } throw e; }
    if (!stats) continue;
    malformed += stats.malformed;
    const key = `codex:${stats.id}`, prior = found.get(key);
    // An archive move can briefly expose both copies. Keep the more complete snapshot once.
    if (!prior || (stats.tokens ?? -1) > (prior.tokens ?? -1) ||
      (stats.tokens === prior.tokens && ((stats.turns ?? 0) > (prior.turns ?? 0) ||
        (stats.turns === prior.turns && stats.agentMs !== null && prior.agentMs === null)))) found.set(key, stats);
  }
  for (const [key, stats] of found) {
    const identity = `${stats.cwd}\n${stats.repository}`;
    if (!projects.has(identity)) projects.set(identity, projectOf(stats));
    rows.set(key, csvRow(stats, projects.get(identity), titles.get(stats.id)));
  }
  const csv = [CODEX_CSV_HEADER, ...[...rows.values()].map(row => row.map(field).join(','))].join('\n') + '\n';
  const texts = fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.csv')).map(e => fs.readFileSync(path.join(dir, e.name), 'utf8')) : [];
  const html = boardHtml([...texts.flatMap(tasksFrom), ...tasksFrom(csv)], now);
  fs.mkdirSync(path.dirname(ledger), { recursive: true });
  writeAtomic(ledger, csv);
  const board = path.join(dir, 'board.html');
  writeAtomic(board, html);
  return { sessions: found.size, skipped, malformed, board };
}

if (require.main === module) {
  run().then(({ sessions, skipped, malformed, board }) => {
    process.stdout.write(`ponytail Codex import: ${sessions} root sessions refreshed, ${skipped} unreadable files, ${malformed} malformed records skipped.\n${board}\n`);
  }).catch(error => { process.stderr.write(`ponytail Codex import: ${error.message}\n`); process.exitCode = 1; });
}

module.exports = { CODEX_CSV_HEADER, readRecords, sessionStats, sessionTitles, projectOf, csvRow, run };
