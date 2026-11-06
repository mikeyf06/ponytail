const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { boardHtml, tasksFrom, parseCsv } = require('../hooks/band/board.ts');

// Run the actual page script with only the DOM operations it uses, without a browser dependency.
class Element {
  constructor(tag = '') {
    this.tagName = tag;
    this.children = [];
    this.attrs = {};
    this.listeners = {};
    this.style = { setProperty() {} };
    this.classList = { toggle() {} };
  }
  set textContent(value) { this.children = value === '' ? [] : [String(value)]; }
  get textContent() { return this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  getBoundingClientRect() { return { left: 0, width: 900, height: 340 }; }
}

function page(tasks) {
  const html = boardHtml(tasks, new Date('2026-11-05T12:00:00').getTime());
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element()]));
  elements.get('board-data').textContent = /id="board-data">([\s\S]*?)<\/script>/.exec(html)[1];
  const metrics = ['time', 'cost', 'tokens'].map(name => { const e = new Element(); e.attrs['data-metric'] = name; return e; });
  const periods = ['7', '30', '90', '0'].map(n => { const e = new Element(); e.attrs['data-period'] = n; return e; });
  const document = {
    getElementById: id => { assert.ok(elements.has(id), id); return elements.get(id); },
    createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag), createTextNode: text => String(text),
    querySelectorAll: selector => selector === '[data-metric]' ? metrics : periods,
    documentElement: new Element(),
  };
  vm.runInNewContext(/<script>([\s\S]*?)<\/script>/.exec(html)[1], { document, window: { addEventListener() {} } });
  return { html, get: id => elements.get(id), metrics, metric: i => metrics[i].listeners.click() };
}

const task = { started: '2026-11-05 10:00', project: 'shop', name: 'Synthetic session', cost: 2.5,
  turns: 2, agentMinutes: 1, tokens: 100, reuse: null, tests: '2 passed', level: 'full', model: 'claude-opus-5-5' };

test('CSV preserves missing metrics and quoted fields without changing measured zero', () => {
  const header = 'key,started,project,name,cost_usd,turns,agent_minutes,tokens_total,reuse_pct,tests,level,model\n';
  assert.deepEqual(parseCsv('a,"b,c","d""e\nf"\r\n'), [['a', 'b,c', 'd"e\nf']]);
  const tasks = tasksFrom(header + 'codex:one,2026-11-05 10:00,shop,Generic,,,,,,,,gpt-6.1-sol\n' +
    'two,2026-11-05 10:00,shop,Zero,0,0,0,0,0,,full,claude-opus-5-5\n' +
    'three,,,,NaN,-1,Infinity,nope\n');
  assert.equal(tasks[0].cost, null);
  assert.equal(tasks[0].turns, null);
  assert.equal(tasks[0].agentMinutes, null);
  assert.equal(tasks[0].tokens, null);
  assert.equal(tasks[0].source, 'codex');
  assert.equal(tasks[1].cost, 0);
  assert.equal(tasks[1].tokens, 0);
  assert.equal(tasks[1].reuse, 0);
  assert.equal(tasks[2].cost, null);
  assert.equal(tasks[2].turns, null);
  assert.deepEqual(tasksFrom('not,a,ledger\n1,2,3'), []);
});

test('known Claude metrics still render rows, totals, averages, charts and cards', () => {
  const p = page([task]);
  assert.match(p.get('rows').textContent, /Opus 5\.5|Opus\u00a05\.5/);
  assert.match(p.get('rows').textContent, /\$2\.50/);
  assert.equal(p.get('c-cost').textContent, '$2.50');
  assert.equal(p.get('c-time').textContent, '1m 0s');
  assert.match(p.get('facts').textContent, /Average cost per session\$2\.50/);
  p.metric(1);
  assert.equal(p.get('chart-total').textContent, '$2.50');
  assert.doesNotMatch(p.get('stream').textContent, /Unavailable/);
  assert.doesNotMatch(p.html, /innerHTML|<script src=/);
  assert.equal(page([]).get('c-sessions').textContent, '0');
});

test('mixed sessions show recorded cost with coverage, including averages and share cards', () => {
  const codex = { ...task, cost: null, tests: '', level: 'import', source: 'codex', model: 'gpt-6.1-sol', name: '</script><script>bad()</script>' };
  const p = page([task, codex, { ...task, started: '2026-09-15 10:00' }]);
  assert.equal(p.get('c-cost').textContent, '$2.50');
  assert.equal(p.get('c-cost-label').textContent, 'Recorded cost');
  assert.match(p.get('c-coverage').textContent, /Cost: 1\/2 sessions/);
  assert.match(p.get('facts').textContent, /Average recorded cost\$2\.50/);
  assert.match(p.get('rows').textContent, /gpt-6.1-sol/);
  assert.doesNotMatch(p.get('rows').textContent, /Unavailable/);
  assert.equal(p.get('kpis').children[2].children[1].textContent, '$2.50', 'partial periods do not get percentage comparisons');
  assert.match(p.get('kpis').children[2].textContent, /recorded for 1 of 2 sessions/);
  p.metric(1);
  assert.equal(p.get('chart-total').textContent, '$2.50');
  assert.match(p.get('chart-sub').textContent, /recorded for 1 of 2 sessions/);
  p.get('stream').onmousemove({ clientX: 900 });
  assert.match(p.get('tip').textContent, /\$2\.50recorded for 1 of 2 sessions/);
  assert.ok(!p.html.includes(codex.name), 'names cannot escape the JSON block');
  assert.ok(p.html.includes('\\u003c/script>'));
  assert.equal(p.get('rows').children[1].children.at(-1).textContent, '–', 'tests are unknown rather than passed or not run');
  p.get('projects').children[1].listeners.click();
  assert.equal(p.get('c-cost').textContent, '$2.50');
});

test('missing timing and tokens use dashes without erasing session activity', () => {
  const p = page([{ ...task, cost: null, tokens: null, turns: null, agentMinutes: null }]);
  assert.equal(p.get('c-tokens').textContent, '–');
  assert.equal(p.get('c-time').textContent, '–');
  assert.equal(p.get('h-active').textContent, '1');
  assert.equal(p.get('h-streak').textContent, '1 day');
  assert.equal(p.get('facts').textContent, '');
  assert.equal(p.get('kpis').children.length, 1, 'only session count is supported');
  assert.doesNotMatch(p.get('rows').textContent, /NaN|undefined|0s/);
  p.metric(2);
  assert.equal(p.get('chart-total').textContent, '–');
  assert.match(p.get('stream').textContent, /No recorded tokens/);
  assert.equal(p.get('stream').onmousemove, null);
});

test('Codex views hide unsupported cost and tests, and explain partial timing once', () => {
  const codex = { ...task, source: 'codex', cost: null, tests: '', level: 'import', branch: 'fix/cart', workspace: 'shop-pr-branch', timePartial: true };
  const p = page([codex, { ...codex, agentMinutes: null, timePartial: false }]);
  assert.equal(p.get('kpis').children.length, 3);
  assert.equal(p.metrics[1].hidden, true);
  assert.equal(p.get('cost-col').hidden, true);
  assert.equal(p.get('tests-col').hidden, true);
  assert.equal(p.get('rows').children[0].children.length, 4);
  assert.match(p.get('rows').textContent, /Branch: fix\/cart · Folder: shop-pr-branch/);
  assert.match(p.get('rows').textContent, /1m 0s\+/);
  assert.equal(p.get('chart-total').textContent, '1m 0s');
  assert.match(p.get('chart-sub').textContent, /recorded for 1 of 2 sessions; completed turns only/);
  assert.equal(p.get('c-time-label').textContent, 'Recorded agent time');
  assert.equal(p.get('c-cost').style.display, 'none');
  assert.match(p.get('c-coverage').textContent, /Agent time: 1\/2 sessions \(partial turns\)/);
  assert.match(p.get('data-note').textContent, /does not record billing cost or test results/);
  assert.match(p.get('facts').textContent, /Average recorded time1m 0s/);
  assert.doesNotMatch(p.get('rows').textContent, /Unavailable/);
  p.get('q').listeners.input({ target: { value: 'fix/cart' } });
  assert.equal(p.get('count').textContent, '2', 'branch and workspace metadata are searchable');
});

test('navigation separates other chats and makes period versus all-time counts explicit', () => {
  const p = page([{ ...task, project: 'Zebra', started: '2026-09-01 10:00' },
    { ...task, project: 'Other chats' }, { ...task, project: 'Alpha' }]);
  assert.deepEqual(p.get('projects').children.map(e => e.children.find(c => c.className === 'name').textContent),
    ['All sessions', 'Alpha', 'Zebra', 'Other chats']);
  assert.equal(p.get('subtitle').textContent, '2 sessions in the last 30 days · 3 all time');
  p.get('projects').children[1].listeners.click();
  assert.equal(p.get('title').textContent, 'Alpha');
  assert.equal(p.get('subtitle').textContent, '1 session in the last 30 days · 1 all time');
});

function svgTitles(element) {
  return element.children.flatMap(child => typeof child === 'string' ? [] :
    [...(child.tagName === 'title' ? [child.textContent] : []), ...svgTitles(child)]);
}

test('activity hover shows scoped metrics, coverage and a bounded list of session titles', () => {
  const p = page([task,
    { ...task, project: 'api', started: '2026-11-05 09:00', name: 'Investigate webhooks', agentMinutes: 2, tokens: 300, turns: 4, timePartial: true },
    { ...task, started: '2026-11-05 08:00', name: '<script>literal title</script>', agentMinutes: null, tokens: null, turns: null },
    { ...task, started: '2026-11-05 07:00', name: 'Fourth session', agentMinutes: 0, tokens: 0, turns: 0 },
    { ...task, started: '2026-11-04 10:00', name: 'Yesterday', agentMinutes: 20 }]);
  const today = svgTitles(p.get('heat')).find(text => text.startsWith('Nov 5, 2026:'));
  assert.ok(today.includes('\n'), 'the browser tooltip uses actual line breaks');
  assert.match(today, /^Nov 5, 2026: 4 sessions started\nProjects: shop, api/);
  assert.match(today, /Recorded agent time: 3m 0s \(recorded for 3 of 4 sessions; completed turns only\)/);
  assert.match(today, /Tokens: 400 \(recorded for 3 of 4 sessions\)/);
  assert.match(today, /Turns: 6 \(recorded for 3 of 4 sessions\)/);
  assert.match(today, /• Synthetic session\n• Investigate webhooks\n• <script>literal title<\/script>\n… and 1 more/);
  assert.doesNotMatch(today, /Fourth session|Yesterday|Cost:/);
  assert.match(today, /lifetime totals for sessions started on this date/);
  assert.ok(!p.html.includes('<script>literal title</script>'), 'titles remain safe text');
  p.get('projects').children[1].listeners.click();
  const api = svgTitles(p.get('heat')).find(text => text.startsWith('Nov 5, 2026:'));
  assert.match(api, /^Nov 5, 2026: 1 session started/);
  assert.match(api, /Recorded agent time: 2m 0s/);
  assert.match(api, /Tokens: 300/);
  assert.match(api, /Turns: 4/);
  assert.doesNotMatch(api, /Projects:|Synthetic session/);
});

test('activity hover does not invent metrics for empty or unmeasured days', () => {
  const p = page([{ ...task, cost: null, agentMinutes: null, tokens: null, turns: null }]);
  const titles = svgTitles(p.get('heat'));
  assert.equal(titles.find(text => text.startsWith('Nov 3, 2026:')), 'Nov 3, 2026: 0 sessions started');
  const today = titles.find(text => text.startsWith('Nov 5, 2026:'));
  assert.match(today, /1 session started/);
  assert.match(today, /• Synthetic session/);
  assert.doesNotMatch(today, /Recorded agent time:|Tokens:|Turns:|Unavailable|NaN|undefined/);
});
