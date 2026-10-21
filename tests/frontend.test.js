const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { SaveQueue } = require('../static/save-queue.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('saves serialize and carry the acknowledged revision, retaining newest edit', async () => {
  const first = deferred();
  const sent = [];
  const queue = new SaveQueue(async body => {
    sent.push(body);
    return sent.length === 1 ? first.promise : { revision: 'r2' };
  });
  queue.reset('r0');
  const saving = queue.enqueue({ title: 'A' });
  queue.enqueue({ title: 'B' });
  queue.enqueue({ title: 'C' });
  assert.equal(sent.length, 1);
  first.resolve({ revision: 'r1' });
  await saving;
  assert.deepEqual(sent, [{ title: 'A', revision: 'r0' }, { title: 'C', revision: 'r1' }]);
  assert.equal(queue.dirty, false);
});

test('conflicts preserve edits and cannot be blindly retried', async () => {
  let calls = 0;
  const queue = new SaveQueue(async () => {
    calls++;
    throw Object.assign(new Error('conflict'), { status: 409 });
  });
  queue.reset('old');
  await queue.enqueue({ title: 'local' });
  await queue.enqueue({ title: 'newer local' });
  await queue.retry();
  assert.equal(calls, 1);
  assert.equal(queue.pending.title, 'newer local');
  assert.equal(queue.dirty, true);
  queue.reset('latest');
  assert.equal(queue.dirty, false);
});

test('network failure keeps the latest draft and retry saves it', async () => {
  const first = deferred();
  const sent = [];
  const queue = new SaveQueue(async body => {
    sent.push(body);
    return sent.length === 1 ? first.promise : { revision: 'r1' };
  });
  queue.reset('r0');
  const saving = queue.enqueue({ title: 'A' });
  queue.enqueue({ title: 'B' });
  first.reject(new Error('offline'));
  await saving;
  assert.equal(queue.pending.title, 'B');
  assert.equal(queue.dirty, true);
  await queue.retry();
  assert.equal(sent[1].title, 'B');
  assert.equal(queue.dirty, false);
});

function roadmapContext() {
  const context = vm.createContext({
    SaveQueue,
    localStorage: { getItem: () => null },
    document: { getElementById: () => ({}), querySelector: () => ({}) },
  });
  vm.runInContext(fs.readFileSync('static/roadmap.js', 'utf8').split('// ---------- Events ----------')[0], context);
  return context;
}

test('inclusive end dates overlap; next-day starts can reuse a track', () => {
  const context = roadmapContext();
  const result = vm.runInContext(`assignTracks([
    {start:'2026-09-01', end:'2026-09-03'},
    {start:'2026-09-03', end:'2026-09-05'},
    {start:'2026-09-04', end:'2026-09-06'}])`, context);
  assert.deepEqual(Array.from(result.assignments), [0, 1, 0]);
  assert.equal(result.trackCount, 2);
});

test('calendar-day differences do not advance in the afternoon or across DST', () => {
  const context = roadmapContext();
  assert.equal(vm.runInContext("daysDiff(parseDate('2026-09-16'), new Date(2026,8,16,18))", context), 0);
  assert.equal(vm.runInContext("daysDiff(parseDate('2026-03-07'), parseDate('2026-03-09'))", context), 2);
  assert.equal(vm.runInContext("parseDate('2026-02-30')", context), null);
  assert.equal(vm.runInContext("toISODate(parseDate('2024-02-29'))", context), '2024-02-29');
});

test('task HTML escapes imported attribute values and fallback dates', () => {
  const context = vm.createContext({ document: { getElementById: () => ({}) } });
  vm.runInContext(fs.readFileSync('static/app.js', 'utf8').split("els.btnNew.addEventListener")[0], context);
  context.task = { id: '"><img src=x onerror=alert(1)>', title: '<b>task</b>',
    createdAt: '<img src=x>', priority: 'high', done: false };
  const html = vm.runInContext('taskHtml(task)', context);
  assert.equal(html.includes('<img'), false);
  assert.equal(html.includes('<b>'), false);
  assert.ok(html.includes('&quot;&gt;&lt;img'));
});
