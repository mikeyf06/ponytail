const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CODEX_CSV_HEADER, sessionStats, sessionTitles, projectOf, run } = require('../hooks/ponytail-codex-import');
const { CSV_HEADER } = require('../hooks/ponytail-band-import');
const { tasksFrom } = require('../hooks/band/board.ts');

const at = seconds => new Date(Date.UTC(2026, 10, 5, 12) + seconds * 1000).toISOString();
const record = (type, payload, seconds = 0) => ({ type, timestamp: at(seconds), payload });
const event = (type, payload, seconds) => record('event_msg', { type, ...payload }, seconds);
const usage = (total_tokens, output_tokens = 10) => ({ input_tokens: total_tokens - output_tokens,
  cached_input_tokens: 20, output_tokens, reasoning_output_tokens: 5, total_tokens });
const meta = (id = 'session-123456789', extra = {}) => record('session_meta', { id, cwd: 'C:\\work\\shop', timestamp: at(0), source: 'vscode', git: { repository_url: 'https://example.test/team/shop.git', branch: 'main' }, ...extra });
const snapshot = (total, seconds = 10) => event('token_count', { info: { total_token_usage: usage(total) } }, seconds);
const modern = (total, extra = {}) => record('token_usage_record', { thread_id: 'session-123456789',
  response_id: 'response-1', usage: usage(100), thread_token_usage: usage(total), ...extra }, 10);
const history = [meta(), event('task_started', { turn_id: 't1' }, 0),
  record('turn_context', { turn_id: 't1', model: 'gpt-6.1-sol' }), modern(100), snapshot(100), snapshot(100),
  event('task_complete', { turn_id: 't1' }, 60)];

test('uses lifetime usage once across both formats, resumes, and compaction', async () => {
  const s = await sessionStats([...history,
    record('compacted', { latest_token_usage_record: { thread_id: 'session-123456789', thread_token_usage: usage(100) } }, 65),
    event('task_started', { turn_id: 't2' }, 86400),
    record('turn_context', { turn_id: 't2', model: 'gpt-6.1-terra' }, 86400),
    modern(250), snapshot(250), event('task_complete', { turn_id: 't2' }, 86430)]);
  assert.equal(s.tokens, 250, 'no snapshots, cached inputs or reasoning subsets added twice');
  assert.equal(s.output, 10);
  assert.equal(s.turns, 2);
  assert.equal(s.agentMs, 90000, 'the idle day between turns is excluded');
  assert.equal(s.model, 'gpt-6.1-sol / gpt-6.1-terra');
  assert.equal((await sessionStats([meta(), modern(100)])).tokens, 100, 'modern-only logs');
  assert.equal((await sessionStats([meta(), snapshot(100)])).tokens, 100, 'legacy-only logs');
  assert.equal((await sessionStats([...history, modern(250), snapshot(100)])).tokens, 250, 'a stale legacy mirror cannot undo newer owned usage');
  assert.equal((await sessionStats([meta(), modern(100, { thread_id: 'child' })])).tokens, null, 'foreign thread usage is ignored');
});

test('missing, invalid, reset and unfinished metrics stay unavailable', async () => {
  const empty = await sessionStats([meta()]);
  assert.equal(empty.tokens, null);
  assert.equal(empty.turns, null);
  assert.equal(empty.agentMs, null);
  assert.equal((await sessionStats([...history, modern(50)])).tokens, null, 'a reset cannot safely be interpreted');
  assert.equal((await sessionStats([meta(), snapshot(100), snapshot(50)])).tokens, null, 'legacy-only counter resets are also ambiguous');
  assert.equal((await sessionStats([meta(), snapshot(-1)])).tokens, null);
  assert.equal((await sessionStats([meta(), modern(100, { thread_token_usage: usage('100') })])).tokens, null);
  const active = await sessionStats([...history, event('task_started', { turn_id: 't2' }, 100)]);
  assert.equal(active.turns, 2);
  assert.equal(active.agentMs, 60000, 'completed turn timing is retained without inventing an end for active work');
  assert.equal(active.timedTurns, 1);
  const aborted = await sessionStats([meta(), event('task_started', { turn_id: 't1' }, 10),
    record('turn_context', { turn_id: 't1' }, 11), event('turn_aborted', {}, 20)]);
  assert.equal(aborted.agentMs, 10000);
  assert.equal((await sessionStats([meta(), event('task_complete', { turn_id: 't1' }, 20)])).agentMs, null);
  assert.equal(await sessionStats([meta('child', { parent_thread_id: 'parent' }), ...history]), null);
  assert.equal(await sessionStats([meta('child', { source: { subagent: { parent_thread_id: 'parent' } } })]), null);
  assert.equal(await sessionStats([meta('fork', { parent_thread_id: 'parent', source: 'vscode' })]), null);
  assert.equal(await sessionStats([record('session_meta', { id: 'x' })]), null);
});

test('refreshes archived and resumed sessions, preserves Claude data, and writes an offline board', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-codex-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const codexHome = path.join(temp, 'codex'), dir = path.join(temp, 'band');
  const active = path.join(codexHome, 'sessions', '2026', '11', '05');
  const archive = path.join(codexHome, 'archived_sessions');
  fs.mkdirSync(active, { recursive: true });
  fs.mkdirSync(archive, { recursive: true });
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(codexHome, 'session_index.jsonl'), JSON.stringify({ id: 'session-123456789', thread_name: 'Synthetic checkout investigation' }) + '\n');
  const write = (file, records) => fs.writeFileSync(file, records.map(r => JSON.stringify(r)).join('\r\n') + '\r\n');
  const file = path.join(active, 'rollout.jsonl');
  write(file, [...history, record('response_item', { type: 'message', content: 'SECRET_PROMPT_DO_NOT_COPY' })]);
  fs.appendFileSync(file, 'malformed\n{"type":');
  write(path.join(archive, 'archived.jsonl'), [meta('archived-id', { cwd: '/work/archive' }), snapshot(300)]);
  write(path.join(active, 'child.jsonl'), [meta('child-id', { parent_thread_id: 'session-123456789' }), snapshot(900)]);
  const claude = `${CSV_HEADER}\nclaude-1,2026-11-05 12:00,shop,"Fix ""cart"", totals\nand tax",2.50,1,1,100,10,,,,,,full,claude-opus-5-5\n`;
  fs.writeFileSync(path.join(dir, 'shop.csv'), claude);
  const options = { codexHome, dir, now: Date.parse(at(3600)) };
  const result = await run(options);
  assert.equal(result.sessions, 2);
  assert.equal(result.malformed, 2);
  assert.equal(fs.readFileSync(path.join(dir, 'shop.csv'), 'utf8'), claude);
  const ledger = path.join(dir, 'codex', 'sessions.csv');
  const first = fs.readFileSync(ledger, 'utf8');
  const transcript = fs.readFileSync(file, 'utf8');
  await run(options);
  assert.equal(fs.readFileSync(ledger, 'utf8'), first, 'repeat import does not duplicate rows');
  assert.equal(fs.readFileSync(file, 'utf8'), transcript, 'source history is read-only');
  write(file, [...history, event('task_started', { turn_id: 't2' }, 100), modern(450), snapshot(450, 110), event('task_complete', { turn_id: 't2' }, 120)]);
  // During an archive move both paths can exist; an older snapshot must not replace the newer one.
  write(path.join(archive, 'duplicate.jsonl'), history);
  await run(options);
  const tasks = tasksFrom(fs.readFileSync(ledger, 'utf8'));
  assert.equal(tasks.length, 2);
  const refreshed = tasks.find(s => s.project === 'shop');
  assert.equal(refreshed.tokens, 450);
  assert.equal(refreshed.turns, 2);
  assert.equal(refreshed.cost, null);
  assert.equal(refreshed.reuse, null);
  assert.equal(refreshed.tests, '');
  assert.equal(refreshed.source, 'codex');
  assert.equal(refreshed.name, 'Synthetic checkout investigation');
  assert.equal(refreshed.branch, 'main');
  assert.equal(refreshed.workspace, 'shop');
  const html = fs.readFileSync(result.board, 'utf8');
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(!html.includes('SECRET_PROMPT_DO_NOT_COPY'));
  assert.ok(!/<(?:script|link)[^>]+(?:src|href)="https?:/i.test(html));
  const data = JSON.parse(/id="board-data">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.tasks.length, 3, 'both sources appear on the same board');
  assert.equal(data.tasks.find(s => s.level === 'full').cost, 2.5);
  assert.ok(html.includes('excluding subagents and forks'));
  const cli = spawnSync(process.execPath, [path.join(__dirname, '../hooks/ponytail-codex-import.js')], {
    env: { ...process.env, CODEX_HOME: codexHome, XDG_CONFIG_HOME: path.join(temp, 'config') }, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.ok(fs.existsSync(path.join(temp, 'config', 'ponytail', 'band', 'board.html')));
  fs.unlinkSync(file);
  fs.unlinkSync(path.join(archive, 'duplicate.jsonl'));
  await run(options);
  assert.equal(tasksFrom(fs.readFileSync(ledger, 'utf8')).length, 2, 'missing source files do not erase previously imported sessions');
});

test('repository metadata groups branch checkouts and titles are read only from the local index', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-codex-projects-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'my-app'), branch = path.join(temp, 'pr-worktree');
  const gitDir = path.join(root, '.git', 'worktrees', 'pr');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(branch);
  fs.writeFileSync(path.join(branch, '.git'), `gitdir: ${gitDir}\n`);
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  assert.equal(projectOf({ cwd: branch }), 'my-app', 'linked worktrees belong to their main repository');
  assert.equal(projectOf({ cwd: path.join(root, 'src') }), 'my-app', 'subdirectories belong to their repository root');
  assert.equal(projectOf({ cwd: path.join(temp, 'deleted-branch'), repository: 'my-app' }), 'my-app', 'recorded metadata survives deleted workspaces');
  assert.equal(projectOf({ cwd: temp }), 'Other chats', 'scratch folders do not each become a project');
  const stats = await sessionStats([meta('one', { cwd: path.join(temp, 'pr-branch'), git: { repository_url: 'git@example.test:team/my-app.git', branch: 'fix/cart' } })]);
  assert.equal(stats.repository, 'my-app');
  assert.equal(stats.branch, 'fix/cart');
  assert.equal((await sessionTitles(temp)).size, 0);
  const index = JSON.stringify({ id: 'one', thread_name: '  Investigate\n cart totals  ' }) + '\n' + 'broken\n' +
    JSON.stringify({ id: 'two', text: 'DO_NOT_USE_PROMPTS_AS_TITLES' }) + '\n';
  fs.writeFileSync(path.join(temp, 'session_index.jsonl'), index);
  assert.equal((await sessionTitles(temp)).get('one'), 'Investigate cart totals');
  assert.equal((await sessionTitles(temp)).has('two'), false);
  assert.equal(fs.readFileSync(path.join(temp, 'session_index.jsonl'), 'utf8'), index);
});

test('upgrades the existing Codex ledger without duplicating sessions or losing absent history', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-codex-upgrade-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const codexHome = path.join(temp, 'codex'), dir = path.join(temp, 'band');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'codex'), { recursive: true });
  const ledger = path.join(dir, 'codex', 'sessions.csv');
  fs.writeFileSync(ledger, `${CSV_HEADER}\ncodex:missing,2026-11-05 12:00,old-project,Old session,,2,1.000,100,10,,,,,,import,gpt-6.1-sol\n`);
  await run({ codexHome, dir });
  const csv = fs.readFileSync(ledger, 'utf8');
  assert.equal(csv.split('\n')[0], CODEX_CSV_HEADER);
  assert.equal(tasksFrom(csv).length, 1);
  assert.equal(tasksFrom(csv)[0].name, 'Old session');
  await run({ codexHome, dir });
  assert.equal(fs.readFileSync(ledger, 'utf8'), csv);
});

test('invalid ledger or missing history fails without overwriting prior output', async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ponytail-codex-errors-'));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const dir = path.join(temp, 'band'), codexHome = path.join(temp, 'codex');
  await assert.rejects(run({ dir, codexHome }), /No Codex session history/);
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'codex'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'codex', 'sessions.csv'), 'not,the,header\n');
  fs.writeFileSync(path.join(dir, 'board.html'), 'previous board');
  await assert.rejects(run({ dir, codexHome }), /Unrecognized Codex ledger/);
  assert.equal(fs.readFileSync(path.join(dir, 'board.html'), 'utf8'), 'previous board');
  assert.equal(fs.readFileSync(path.join(dir, 'codex', 'sessions.csv'), 'utf8'), 'not,the,header\n');
});
