import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand } from '../../scripts/onecall.mjs';

// 端到端：对真实 OneCall（任务模板版）跑完整用户旅程。
// 门控：设 ONECALL_E2E=1 且 base 可达才执行（依赖本地 develop 服务、团队 Key 与已建模板）；
// 无环境时整组跳过，不阻塞常规 npm test。
const E2E_ENABLED = process.env.ONECALL_E2E === '1';
const BASE = process.env.ONECALL_BASE_URL || 'http://localhost:3002';
const CREDS = process.env.ONECALL_CREDENTIALS_FILE || `${process.env.HOME}/.onecall-creds.json`;
const deps = { env: { ...process.env, ONECALL_BASE_URL: BASE, ONECALL_CREDENTIALS_FILE: CREDS }, fetchImpl: fetch };
const opts = { skip: !E2E_ENABLED && '设 ONECALL_E2E=1 且本地 develop 服务在跑时启用' };

const run = (...args) => runCommand(args, deps);
const taskId = value => value.data?.id;

test('E2E 只读旅程：status → 市场与模板可见 → 任务列表仅呈现任务模板版（历史任务隐藏）', opts, async () => {
  assert.equal((await run('status')).state, 'done');
  const market = await run('market', 'list');
  assert.equal(market.state, 'done');
  const templates = await run('templates', 'list');
  assert.equal(templates.state, 'done');
  assert.ok(templates.data.items.length >= 1, '预置模板应可见');
  const tasks = await run('tasks', 'list', '--limit', '20');
  assert.equal(tasks.state, 'done');
  assert.equal(tasks.data.items.some(t => t.kind === 'legacy_outbound'), false, '历史任务不应出现在列表');
});

test('E2E 写旅程：模板创建（auto_start=false）→ 幂等确认 → 断言非运行 → 控制受理 → 查询回读', opts, async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'oc-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  deps.env.ONECALL_STATE_DIR = join(dir, 'state');

  const tpl = (await run('templates', 'list')).data.items[0];
  const taskFile = join(dir, 'task.json');
  await writeFile(taskFile, JSON.stringify({
    name: `E2E-${Date.now()}`, template_id: tpl.id, template_revision: tpl.revision,
    contacts: [], auto_start: false,
  }));

  const plan = await run('tasks', 'create', '--file', taskFile);
  assert.equal(plan.state, 'confirm');
  assert.equal(plan.next.confirm.target.autoStart, false);
  const opId = plan.data.operationId;

  const accepted = await run('operation', 'confirm', opId);
  assert.equal(accepted.state, 'done');
  const newId = taskId(accepted);
  assert.ok(newId, `受理回执应含任务 id: ${JSON.stringify(accepted).slice(0, 200)}`);

  // 未授权 auto_start：任务不得处于运行态（验收 4 断言）
  const afterCreate = await run('tasks', 'show', newId);
  assert.equal(afterCreate.state, 'done');
  assert.notEqual(afterCreate.data.status, 'running');

  // 幂等：同编号重放命中本地缓存，返回一致结果
  const replay = await run('operation', 'confirm', opId);
  assert.deepEqual(replay, accepted);

  // 追加联系人（清理语义已在单测/差异测试锁定，此处走真实受理）
  const leads = join(dir, 'leads.json');
  await writeFile(leads, JSON.stringify({ phones: ['1000000'] }));
  const importPlan = await run('tasks', 'import', newId, '--file', leads);
  assert.equal(importPlan.state, 'confirm');
  const appended = await run('operation', 'confirm', importPlan.data.operationId);
  assert.equal(appended.state, 'done');
  assert.ok(appended.data.accepted_numbers >= 1, '追加受理应计收联系人');

  // 控制：start 受理（乐观锁 + 幂等头由单测锁定；此处断言真实受理与状态查询）
  const startPlan = await run('tasks', 'start', newId);
  assert.equal(startPlan.state, 'confirm');
  const started = await run('operation', 'confirm', startPlan.data.operationId);
  assert.ok(['done'].includes(started.state) || started.data?.status, `start 应受理: ${JSON.stringify(started).slice(0, 200)}`);

  // 回读：进度与号码按任务维度可查
  assert.equal((await run('tasks', 'progress', newId)).state, 'done');
  assert.equal((await run('tasks', 'numbers', newId, '--limit', '5')).state, 'done');
  assert.equal((await run('tasks', 'calls', newId, '--limit', '5')).state, 'done');
});
