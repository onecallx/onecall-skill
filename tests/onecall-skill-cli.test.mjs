import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { symlinkSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCommand } from '../scripts/onecall.mjs';

// Generated for the mock transport only; never a server-issued credential.
const KEY = ['sk', 'live', randomBytes(16).toString('hex')].join('_');
const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
async function fixture(t, fetchImpl = async () => response({ id: 'task_1', name: '回访', status: 'paused' })) {
  const dir = await mkdtemp(join(tmpdir(), 'onecall-skill-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ONECALL_BASE_URL: 'http://localhost:3002', ONECALL_WEB_URL: 'http://localhost:5173', ONECALL_API_KEY: KEY, ONECALL_STATE_DIR: join(dir, 'state') };
  const calls = [];
  const deps = { env, fetchImpl: async (url, options) => { calls.push({ url, ...options }); return fetchImpl(url, options); } };
  const run = (...args) => runCommand(args, deps);
  const input = async (name, data) => { const path = join(dir, name); await writeFile(path, JSON.stringify(data)); return path; };
  return { dir, env, deps, calls, run, input };
}

test('公开市场不发送密钥，编码查询且禁止跟随重定向', async t => {
  const f = await fixture(t, async () => response({ items: [] }));
  const out = await f.run('market', 'list', '--q', '教育&回访');
  assert.equal(out.state, 'done');
  assert.equal(new URL(f.calls[0].url).searchParams.get('q'), '教育&回访');
  assert.equal(f.calls[0].headers.Authorization, undefined);
  assert.equal(f.calls[0].redirect, 'error');
});

test('团队查询使用 API Key；无密钥在发请求前停止', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('tasks', 'list')).state, 'done');
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${KEY}`);
  delete f.env.ONECALL_API_KEY;
  assert.equal((await f.run('tasks', 'list')).error.code, 'AUTH_REQUIRED');
  assert.equal(f.calls.length, 1);
});

test('创建、体验和账户只交接网页，不伪造业务结果', async t => {
  const f = await fixture(t);
  for (const [args, path] of [[['agents', 'create'], '/agents'], [['agents', 'try', 'education'], '/market/education'], [['agents', 'edit', 'agt_1'], '/agents/agt_1'], [['account', 'open'], '/account']]) {
    const out = await f.run(...args);
    assert.equal(out.state, 'handoff');
    assert.equal(out.next.url, `http://localhost:5173${path}`);
  }
  assert.equal(f.calls.length, 0);
});

test('非 HTTPS 外部服务、路径逃逸、未知参数均在请求前拒绝', async t => {
  const f = await fixture(t);
  for (const bad of ['http://example.com', 'https://name:secret@example.com', 'https://example.com/api', 'https://example.com?key=1']) {
    f.env.ONECALL_BASE_URL = bad;
    assert.equal((await f.run('market', 'list')).state, 'error');
  }
  f.env.ONECALL_BASE_URL = 'http://localhost:3002';
  assert.equal((await f.run('market', 'show', '../auth')).state, 'error');
  assert.equal((await f.run('tasks', 'list', '--yes', '1')).state, 'error');
  assert.equal(f.calls.length, 0);
});

test('创建先出完整预览，确认一次提交，再次确认只返回已保存结果', async t => {
  const f = await fixture(t);
  const file = await f.input('task.json', { name: '客户回访', template_id: 'tpl_1', template_revision: 3, contacts: [{ phone: '+8613800000000' }] });
  const plan = await f.run('tasks', 'create', '--file', file);
  assert.equal(plan.state, 'confirm');
  assert.equal(plan.next.confirm.target.templateId, 'tpl_1');
  assert.equal(plan.next.confirm.target.templateRevision, 3);
  assert.equal(plan.next.confirm.target.contactsCount, 1);
  assert.equal(plan.next.confirm.target.autoStart, false);
  assert.equal(f.calls.length, 0);
  const [one, two] = [await f.run('operation', 'confirm', plan.data.operationId), await f.run('operation', 'confirm', plan.data.operationId)];
  assert.deepEqual(two, one);
  assert.equal(one.state, 'done');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].method, 'POST');
  const sentBody = JSON.parse(f.calls[0].body);
  assert.equal(sentBody.name, '客户回访');
  assert.equal(sentBody.template_id, 'tpl_1');
  assert.equal(sentBody.template_revision, 3);
  const log = await readFile(join(f.env.ONECALL_STATE_DIR, `${plan.data.operationId}.json`), 'utf8');
  assert.equal(log.includes(KEY), false);
  if (process.platform !== 'win32') {
    assert.equal((await stat(f.env.ONECALL_STATE_DIR)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.env.ONECALL_STATE_DIR, `${plan.data.operationId}.json`))).mode & 0o777, 0o600);
  }
});

test('上传只在确认后发送，预览不暴露客户原文', async t => {
  const f = await fixture(t);
  const file = await f.input('leads.json', { data: [{ phone: '+8613800000000', name: '客户甲' }] });
  const plan = await f.run('tasks', 'import', 'task_1', '--file', file);
  assert.equal(plan.next.confirm.count, 1);
  assert.equal(JSON.stringify(plan).includes('13800000000'), false);
  assert.equal(f.calls.every(item => item.method === 'GET'), true);
  assert.equal((await f.run('operation', 'confirm', plan.data.operationId)).state, 'done');
  const writes = f.calls.filter(item => item.method === 'POST');
  assert.equal(writes.length, 1);
  const sentBody = JSON.parse(writes[0].body);
  assert.equal(sentBody.contacts[0].phone, '+8613800000000');
  assert.equal(sentBody.idempotency_key, undefined);
});

test('create 校验必填字段与联系人格式', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('tasks', 'create', '--file', await f.input('a.json', { name: '回访', template_id: 'tpl_1', contacts: [{ phone: 'abc' }] }))).error.code, 'INVALID_INPUT');
  assert.equal((await f.run('tasks', 'create', '--file', await f.input('b.json', { name: '回访', template_id: 'tpl_1', template_revision: 3, contacts: [], auto_start: true }))).error.code, 'INVALID_INPUT');
  assert.equal((await f.run('tasks', 'create', '--file', await f.input('c.json', { template_id: 'tpl_1', template_revision: 3, contacts: [] }))).error.code, 'INVALID_INPUT');
  assert.equal((await f.run('tasks', 'create', '--file', await f.input('d.json', { name: '回访', template_revision: 3, contacts: [] }))).error.code, 'INVALID_INPUT');
  assert.equal((await f.run('tasks', 'create', '--file', await f.input('e.json', { name: '回访', template_id: 'tpl_1', template_revision: 0, contacts: [] }))).error.code, 'INVALID_INPUT');
  assert.equal(f.calls.length, 0);
});

test('启动和暂停走 control 端点并携带幂等键；resume 已移除', async t => {
  const f = await fixture(t);
  for (const action of ['start', 'pause']) {
    const plan = await f.run('tasks', action, 'task_1');
    const done = await f.run('operation', 'confirm', plan.data.operationId);
    assert.equal(done.state, 'done');
    const write = f.calls.find(item => item.method === 'POST' && item.headers['Idempotency-Key'] === plan.data.operationId);
    assert.equal(write.url, `http://localhost:3002/v1/outbound/tasks/control?task_id=task_1`);
    assert.deepEqual(JSON.parse(write.body), { action });
  }
  assert.equal((await f.run('tasks', 'resume', 'task_1')).error.code, 'INVALID_INPUT');
});

test('追加联系人走 numbers 端点并携带幂等键', async t => {
  const f = await fixture(t);
  const file = await f.input('leads.json', { phones: ['+8613800000000'] });
  const plan = await f.run('tasks', 'import', 'task_1', '--file', file);
  await f.run('operation', 'confirm', plan.data.operationId);
  const write = f.calls.find(item => item.method === 'POST');
  assert.equal(write.url, 'http://localhost:3002/v1/outbound/tasks/numbers?task_id=task_1');
  assert.equal(write.headers['Idempotency-Key'], plan.data.operationId);
});

test('任务预检使用查询参数式单查', async t => {
  const f = await fixture(t);
  await f.run('tasks', 'start', 'task_1');
  assert.equal(f.calls[0].url, 'http://localhost:3002/v1/outbound/tasks?task_id=task_1');
});

test('legacy 任务预检 410 时在预览阶段如实报错，不生成操作也不落提交记录', async t => {
  const f = await fixture(t, async () => new Response(JSON.stringify({ error: { code: 'OPENAPI_ENDPOINT_RETIRED' } }), { status: 410 }));
  const plan = await f.run('tasks', 'start', 'oct_legacy');
  assert.equal(plan.state, 'error');
  assert.equal(plan.error.code, 'HTTP_410');
  assert.equal(f.calls.filter(item => item.method === 'POST').length, 0);
  const { readdir } = await import('node:fs/promises');
  const files = await readdir(f.env.ONECALL_STATE_DIR).catch(() => []);
  assert.equal(files.length, 0);
});

test('团队员工与全局话单命令已移除', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('agents', 'list')).error.code, 'INVALID_INPUT');
  assert.equal((await f.run('calls', 'list')).error.code, 'INVALID_INPUT');
  assert.equal(f.calls.length, 0);
});

test('超时及服务端错误均保留未知结果，重复确认不会重发', async t => {
  for (const failure of ['timeout', 'http500', 'badJson']) {
    const f = await fixture(t, async (_url, options) => {
      if (options.method === 'GET') return response({ id: 'task_1', status: 'paused' });
      if (failure === 'timeout') throw new Error('timeout');
      if (failure === 'badJson') return new Response('<html>proxy error</html>', { status: 200 });
      return response({ error: 'unavailable' }, 500);
    });
    const plan = await f.run('tasks', 'start', 'task_1');
    assert.equal((await f.run('operation', 'confirm', plan.data.operationId)).state, 'unknown');
    assert.equal((await f.run('operation', 'confirm', plan.data.operationId)).state, 'unknown');
    assert.equal((await f.run('operation', 'show', plan.data.operationId)).state, 'unknown');
    assert.equal(f.calls.filter(item => item.method === 'POST').length, 1);
  }
});

test('并行确认同一个编号也最多写一次', async t => {
  const f = await fixture(t);
  const plan = await f.run('tasks', 'start', 'task_1');
  await Promise.all([f.run('operation', 'confirm', plan.data.operationId), f.run('operation', 'confirm', plan.data.operationId)]);
  assert.equal(f.calls.filter(item => item.method === 'POST').length, 1);
});

test('确认绑定凭据和过期时间，任务改变要求重新核对', async t => {
  let task = { id: 'task_1', status: 'paused' };
  const f = await fixture(t, async () => response(task));
  const plan = await f.run('tasks', 'start', 'task_1');
  f.env.ONECALL_API_KEY = `${KEY}other`;
  assert.equal((await f.run('operation', 'confirm', plan.data.operationId)).error.code, 'SCOPE_MISMATCH');
  f.env.ONECALL_API_KEY = KEY;
  task = { id: 'task_1', status: 'active' };
  assert.equal((await f.run('operation', 'confirm', plan.data.operationId)).error.code, 'TARGET_CHANGED');
  const future = await runCommand(['operation', 'confirm', plan.data.operationId], { ...f.deps, now: () => Date.now() + 20 * 60 * 1000 });
  assert.equal(future.error.code, 'CONFIRMATION_EXPIRED');
  assert.equal(f.calls.filter(item => item.method === 'POST').length, 0);
});

test('进程中断遗留提交 claim 时不把操作显示为尚未提交', async t => {
  const f = await fixture(t);
  const plan = await f.run('tasks', 'start', 'task_1');
  await writeFile(join(f.env.ONECALL_STATE_DIR, `${plan.data.operationId}.json.claim`), '{}', { mode: 0o600 });
  assert.equal((await f.run('operation', 'show', plan.data.operationId)).state, 'unknown');
  assert.equal((await f.run('operation', 'confirm', plan.data.operationId)).state, 'unknown');
  assert.equal(f.calls.filter(item => item.method === 'POST').length, 0);
});

test('超过名单上限、不支持的字段均不提交', async t => {
  const f = await fixture(t);
  const leads = await f.input('leads.json', { phones: Array(1001).fill('+8613800000000') });
  assert.equal((await f.run('tasks', 'import', 'task_1', '--file', leads)).state, 'error');
  const taskFile = await f.input('task.json', { name: '回访', template_id: 'tpl_1', template_revision: 3, contacts: [], window_start_hour: '09:00' });
  assert.equal((await f.run('tasks', 'create', '--file', taskFile)).state, 'error');
  assert.equal(f.calls.length, 0);
});

test('服务端回显凭据不会进入错误输出', async t => {
  const f = await fixture(t, async (_url, options) => response(options.method === 'GET' ? { id: 'task_1', status: 'paused' } : { error: KEY }, options.method === 'GET' ? 200 : 400));
  const plan = await f.run('tasks', 'pause', 'task_1');
  const failed = await f.run('operation', 'confirm', plan.data.operationId);
  assert.equal(failed.state, 'error');
  assert.equal(JSON.stringify(failed).includes(KEY), false);
});

test('templates list 调用任务模板列表端点并携带密钥', async t => {
  const f = await fixture(t, async () => response({ items: [], has_more: false, next_cursor: null }));
  const out = await f.run('templates', 'list');
  assert.equal(out.state, 'done');
  assert.equal(f.calls[0].url, 'http://localhost:3002/v1/outbound/task-templates');
  assert.equal(f.calls[0].method, 'GET');
  assert.equal(f.calls[0].headers.Authorization, `Bearer ${KEY}`);
});

test('templates list 仅接受 limit 与 cursor，拒绝关键词选项', async t => {
  const f = await fixture(t);
  assert.equal((await f.run('templates', 'list', '--q', '回访')).error.code, 'INVALID_INPUT');
  assert.equal((await f.run('templates', 'list', '--limit', '20')).state, 'done');
  assert.match(f.calls[0].url, /limit=20/);
  assert.equal(f.calls.length, 1);
});

test('任务读命令使用查询参数式端点', async t => {
  const f = await fixture(t, async () => response({ items: [] }));
  await f.run('tasks', 'show', 'oct123');
  await f.run('tasks', 'progress', 'oct123');
  await f.run('tasks', 'numbers', 'oct123', '--limit', '20');
  await f.run('tasks', 'calls', 'oct123');
  assert.equal(f.calls[0].url, 'http://localhost:3002/v1/outbound/tasks?task_id=oct123');
  assert.equal(f.calls[1].url, 'http://localhost:3002/v1/outbound/tasks/progress?task_id=oct123');
  assert.equal(f.calls[2].url, 'http://localhost:3002/v1/outbound/tasks/numbers?task_id=oct123&limit=20');
  assert.equal(f.calls[3].url, 'http://localhost:3002/v1/outbound/tasks/calls?task_id=oct123');
});

test('tasks list 映射 q 到 keyword 并支持状态过滤', async t => {
  const f = await fixture(t, async () => response({ items: [], total: 0, page: 1, pageSize: 20 }));
  await f.run('tasks', 'list', '--q', '回访', '--status', 'running');
  const url = new URL(f.calls[0].url);
  assert.equal(url.pathname, '/v1/outbound/tasks');
  assert.equal(url.searchParams.get('keyword'), '回访');
  assert.equal(url.searchParams.get('status'), 'running');
  assert.equal(url.searchParams.has('q'), false);
});

test('help 列出新命令面且不含已移除命令', async t => {
  const f = await fixture(t);
  const out = await f.run('help');
  const text = JSON.stringify(out.data.commands);
  assert.match(text, /templates list/);
  assert.match(text, /numbers\|calls/);
  assert.doesNotMatch(text, /marketers|resume|calls list/);
});

test('输出协议版本号为 0.2.0', async t => {
  const f = await fixture(t);
  const out = await f.run('status');
  assert.equal(out.version, '0.2.0');
});

test('经符号链接调用仍然输出协议 JSON（主模块判断需解析真实路径）', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'onecall-skill-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = realpathSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'onecall.mjs'));
  const link = join(dir, 'onecall.mjs');
  symlinkSync(script, link);
  const r = spawnSync(process.execPath, [link, 'status'], {
    encoding: 'utf8',
    env: { ...process.env, ONECALL_BASE_URL: 'http://localhost:3002', ONECALL_API_KEY: '', ONECALL_CREDENTIALS_FILE: '', ONECALL_STATE_DIR: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.protocol, 1);
  assert.equal(out.state, 'done');
});
