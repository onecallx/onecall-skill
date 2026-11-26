#!/usr/bin/env node
/** Portable OneCall Skill client. No dependencies, browser cookies or automatic writes. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, realpathSync } from 'node:fs';
import { open, mkdir, lstat, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(import.meta.url);
const VERSION = '0.1.0';
const DEFAULT_BASE_URL = 'https://api.16x.tech';
const DEFAULT_WEB_URL = 'https://app.16x.tech';
const MAX_BYTES = 1024 * 1024;
const TTL_MS = 15 * 60 * 1000;
const result = (state, data = {}, next = { action: 'done' }) => ({ protocol: 1, version: VERSION, state, data, next });
class ClientError extends Error {
  constructor(code, message, uncertain = false) { super(message); this.code = code; this.uncertain = uncertain; }
}
const invalid = message => { throw new ClientError('INVALID_INPUT', message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);
const taskIdentity = task => digest(JSON.stringify(['id', 'name', 'status', 'state_version', 'error_code'].map(key => [key, task[key] ?? null])));
const safeId = value => {
  if (typeof value !== 'string' || !/^[\p{L}\p{N}_-]{1,128}$/u.test(value)) invalid('请使用查询结果中的员工或任务编号。');
  return encodeURIComponent(value);
};
function origin(value, name) {
  let url;
  try { url = new URL(value); } catch { invalid(`请先配置 ${name} 为你的 OneCall 站点源地址。`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || local && url.protocol === 'http:')) {
    invalid(`${name} 必须是 HTTPS 源地址（本机 localhost 可用 HTTP），不能包含路径、凭据或查询参数。`);
  }
  return url.origin;
}
function parseArgs(argv) {
  const positional = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { positional.push(argv[i]); continue; }
    const key = argv[i].slice(2), value = argv[++i];
    if (!key || key in flags || value === undefined || value.startsWith('--')) invalid('选项必须提供且仅提供一个值。');
    flags[key] = value;
  }
  return { positional, flags };
}
function options(flags, allowed) {
  if (Object.keys(flags).some(key => !allowed.includes(key))) invalid(`可用选项：${allowed.map(key => `--${key}`).join('、') || '无'}。`);
  for (const key of ['limit', 'offset']) if (flags[key] !== undefined && (!/^\d+$/.test(flags[key]) || Number(flags[key]) > (key === 'limit' ? 100 : 100000) || key === 'limit' && Number(flags[key]) < 1)) invalid(`${key} 超出范围。`);
}
async function privateJson(path, limit = MAX_BYTES) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) invalid('文件必须是大小不超过 1 MB 的 JSON 文件。');
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) invalid('私密文件必须由当前用户拥有，且权限为 0600。');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
async function inputJson(path) {
  if (!path) invalid('请通过 --file 指定 JSON 文件。');
  const handle = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) invalid('文件必须是大小不超过 1 MB 的 JSON 文件。');
    const value = JSON.parse(await handle.readFile('utf8'));
    if (!isObject(value)) invalid('JSON 顶层必须是对象。');
    return value;
  } finally { await handle.close(); }
}
function validateContacts(list) {
  if (!Array.isArray(list) || list.length > 1000) invalid('每次最多 1000 个联系人。');
  for (const item of list) {
    if (!isObject(item) || Object.keys(item).some(key => !['phone', 'name', 'variables', 'client_contact_id'].includes(key)) || typeof item.phone !== 'string' || !/^\+?\d{5,20}$/.test(item.phone) || item.name !== undefined && (typeof item.name !== 'string' || item.name.length > 120) || item.client_contact_id !== undefined && (typeof item.client_contact_id !== 'string' || item.client_contact_id.length > 128)) invalid('每个联系人须有有效 phone，且仅可附带不超过 120 字的 name、variables 或 client_contact_id。');
    if (item.variables !== undefined && (!isObject(item.variables) || Object.entries(item.variables).some(([k, v]) => typeof k !== 'string' || k.length > 64 || typeof v !== 'string' || v.length > 500))) invalid('联系人 variables 须为键值均为字符串的对象（键 ≤64 字、值 ≤500 字）。');
  }
  return list;
}
function normalizeContacts(value) {
  if (Object.keys(value).some(key => !['phones', 'data', 'contacts'].includes(key))) invalid('名单仅接受 contacts、phones 或 data 中的一种。');
  const count = ['phones', 'data', 'contacts'].filter(key => value[key] !== undefined).length;
  if (count !== 1) invalid('名单仅接受 contacts、phones 或 data 中的一种。');
  if (value.contacts) return validateContacts(value.contacts);
  const data = value.data || (Array.isArray(value.phones) ? value.phones.map(phone => ({ phone })) : null);
  if (!Array.isArray(data) || !data.length) invalid('名单至少包含 1 个联系人。');
  return validateContacts(data.map(item => isObject(item) && item.variables ? { phone: item.phone, name: item.name, variables: item.variables, client_contact_id: item.client_contact_id } : { phone: item?.phone, name: item?.name }));
}
function validatePayload(action, value) {
  if (!isObject(value)) invalid('操作内容无效。');
  if (action === 'create') {
    const keys = ['name', 'template_id', 'template_revision', 'contacts', 'auto_start', 'client_task_id'];
    if (Object.keys(value).some(key => !keys.includes(key))) invalid('任务包含不支持的字段。');
    if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200) invalid('任务名称不能为空，最多 200 字。');
    if (typeof value.template_id !== 'string' || !value.template_id.trim()) invalid('template_id 必填，请从 templates list 结果中选择。');
    if (!Number.isInteger(value.template_revision) || value.template_revision < 1) invalid('template_revision 必填且为正整数，请从 templates list 结果中取当前值。');
    if (value.contacts === undefined) invalid('contacts 必填；暂无名单可用空数组，创建后通过 tasks import 追加。');
    if (value.auto_start !== undefined && typeof value.auto_start !== 'boolean') invalid('auto_start 须为布尔值。');
    if (value.client_task_id !== undefined && (typeof value.client_task_id !== 'string' || value.client_task_id.length > 128)) invalid('client_task_id 须为不超过 128 字的字符串。');
    const contacts = validateContacts(value.contacts);
    if (value.auto_start && !contacts.length) invalid('空名单任务不能自动开始，须在追加名单后手动启动。');
    return { name: value.name, template_id: value.template_id, template_revision: value.template_revision, contacts, ...(value.auto_start !== undefined ? { auto_start: value.auto_start } : {}), ...(value.client_task_id !== undefined ? { client_task_id: value.client_task_id } : {}) };
  }
  if (action === 'import') return { contacts: normalizeContacts(value) };
  if (Object.keys(value).length) invalid('启停任务不接受额外请求内容。');
  return {};
}
function operationPath(action, target) {
  if (action === 'create') return { path: '/v1/outbound/tasks', method: 'POST' };
  const task_id = safeId(target);
  if (action === 'import') return { path: '/v1/outbound/tasks/numbers', method: 'POST', query: { task_id } };
  if (action === 'start' || action === 'pause') return { path: '/v1/outbound/tasks/control', method: 'POST', query: { task_id } };
  invalid('未知操作。');
}

export async function runCommand(argv, { env = process.env, fetchImpl = fetch, now = () => Date.now() } = {}) {
  let apiKey = '';
  let submissionClaimed = false;
  try {
    const { positional: args, flags } = parseArgs(argv);
    const [group, command, id] = args;
    if (args.length > 3) invalid('命令参数过多。');
    if (!group || group === 'help') {
      options(flags, []);
      return result('done', { commands: ['status', 'auth setup', 'market list|show', 'agents list|create|edit|try', 'account open', 'calls list|show', 'tasks marketers|list|show|progress|numbers|create|import|start|pause|resume', 'operation show|confirm'], configuration: ['ONECALL_BASE_URL', 'ONECALL_WEB_URL', 'ONECALL_API_KEY or ONECALL_CREDENTIALS_FILE'] });
    }
    const base = origin(env.ONECALL_BASE_URL || DEFAULT_BASE_URL, 'ONECALL_BASE_URL');
    const web = origin(env.ONECALL_WEB_URL || (env.ONECALL_BASE_URL ? base : DEFAULT_WEB_URL), 'ONECALL_WEB_URL');
    const stateDir = resolve(env.ONECALL_STATE_DIR || join(homedir(), '.local', 'state', 'onecall-skill'));
    const key = async () => {
      if (apiKey) return apiKey;
      apiKey = env.ONECALL_API_KEY || (env.ONECALL_CREDENTIALS_FILE ? (await privateJson(env.ONECALL_CREDENTIALS_FILE, 16384)).apiKey : '');
      if (typeof apiKey !== 'string' || !/^sk_live_[A-Za-z0-9_-]{16,128}$/.test(apiKey)) throw new ClientError('AUTH_REQUIRED', '请在本地配置 OneCall 团队 API Key；公开市场无需密钥。');
      return apiKey;
    };
    const handoff = (path, say) => result('handoff', {}, { action: 'handoff', url: new URL(path, web).href, say });
    const request = async (path, { method = 'GET', body, query = {}, publicAccess = false, idempotencyKey } = {}) => {
      const url = new URL(path, base);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      const headers = { Accept: 'application/json' };
      if (!publicAccess) headers.Authorization = `Bearer ${await key()}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
      const write = method !== 'GET';
      let response, data;
      try {
        response = await fetchImpl(url.href, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000), redirect: 'error' });
        data = await response.json();
        if (!isObject(data) && !Array.isArray(data)) throw new Error('Invalid response');
      } catch { throw new ClientError('NETWORK_UNAVAILABLE', write ? '提交结果未确定，请查询业务状态，不要重复提交。' : '服务暂不可达，请核对地址或稍后重试查询。', write); }
      if (!response.ok) {
        const code = response.status === 401 ? 'UNAUTHORIZED' : response.status === 403 ? 'FORBIDDEN' : `HTTP_${response.status}`;
        const message = response.status === 401 ? '密钥无效或已过期，请在本地核对。' : response.status === 403 ? '当前团队或密钥权限不允许此操作。' : response.status === 404 ? '未找到该员工、任务或接口，请核对所选站点与编号。' : response.status >= 500 ? '服务暂不可用；写操作结果可能未确定，请先查询。' : typeof data?.error === 'string' ? data.error.slice(0, 500) : '请求未完成，请核对参数与当前业务状态。';
        throw new ClientError(code, apiKey ? message.replaceAll(apiKey, '[redacted]') : message, write && response.status >= 500);
      }
      return data;
    };
    const secureDir = async () => {
      await mkdir(stateDir, { recursive: true, mode: 0o700 });
      const stat = await lstat(stateDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid())) invalid('操作记录目录必须是当前用户私有目录（0700），不能是符号链接。');
    };
    const save = async (path, value, exclusive = false) => {
      const temp = exclusive ? path : `${path}.${randomUUID()}.tmp`;
      const handle = await open(temp, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
      if (!exclusive) await rename(temp, path);
    };
    const scope = async () => digest(`${base}\n${await key()}`);
    const readOperation = async value => {
      if (!/^[0-9a-f-]{36}$/.test(value || '')) invalid('操作编号无效。');
      await secureDir();
      const path = join(stateDir, `${value}.json`);
      const record = await privateJson(path);
      if (record.id !== value || record.scope !== await scope()) throw new ClientError('SCOPE_MISMATCH', '该操作属于其他站点或密钥，不能提交。');
      return { path, record };
    };

    if (group === 'status' && !command) {
      options(flags, []);
      return result('done', { baseUrl: base, webUrl: web, apiKeyConfigured: Boolean(env.ONECALL_API_KEY || env.ONECALL_CREDENTIALS_FILE), authenticated: false, note: '仅检查配置；执行团队查询时由服务器验证权限。' });
    }
    if (group === 'auth' && command === 'setup' && !id) { options(flags, []); return handoff('/developer', '在开发者页面创建最小权限的团队 API Key，并在本机配置。无需将密钥发送到聊天。'); }
    if (group === 'account' && command === 'open' && !id) { options(flags, []); return handoff('/account', '请在网页中登录账户页，查看当前团队与余额。'); }
    if (group === 'agents' && ['create', 'edit', 'try'].includes(command)) {
      options(flags, []);
      if (command === 'create' && !id) return handoff('/agents', '在 AI Agent 页选择「创建 Agent」，按网页引导填写业务需求并核对摘要。尚未创建任何员工。');
      if (command === 'edit') return handoff(`/agents/${safeId(id)}`, '在 AI Agent 页面选择音色或提交改进反馈。尚未更改配置或话术。');
      if (command === 'try') return handoff(`/market/${safeId(id)}`, '在员工详情选择体验，按网页要求登录、验证并确认。尚未发起通话。');
      invalid('创建员工不接受员工编号。');
    }
    if (group === 'market') {
      if (command === 'list' && !id) { options(flags, ['q', 'industry', 'scene', 'locale', 'region', 'limit', 'cursor']); return result('done', await request('/api/market/listings', { query: flags, publicAccess: true })); }
      if (command === 'show') { options(flags, []); return result('done', await request(`/api/market/listings/${safeId(id)}`, { publicAccess: true })); }
    }
    if (group === 'templates' && command === 'list' && !id) {
      options(flags, ['limit', 'cursor']);
      return result('done', await request('/v1/outbound/task-templates', { query: flags }));
    }
    if (group === 'agents' && command === 'list' && !id) invalid('团队员工查询已随旧版接口退役；员工管理请在网页完成。');
    if (group === 'calls') invalid('全局话单查询已随旧版接口退役；请使用 tasks calls <taskId> 按任务查询。');
    if (group === 'tasks') {
      if (command === 'list' && !id) {
        options(flags, ['q', 'status', 'limit', 'page', 'pageSize']);
        const { q, ...rest } = flags;
        return result('done', await request('/v1/outbound/tasks', { query: { ...(q !== undefined ? { keyword: q } : {}), ...rest } }));
      }
      if (['show', 'progress', 'numbers', 'calls'].includes(command)) {
        options(flags, ['numbers', 'calls'].includes(command) ? ['limit', 'cursor'] : []);
        const path = command === 'show' ? '/v1/outbound/tasks' : `/v1/outbound/tasks/${command}`;
        return result('done', await request(path, { query: { task_id: safeId(id), ...flags } }));
      }
      if (['create', 'import', 'start', 'pause'].includes(command)) {
        options(flags, ['create', 'import'].includes(command) ? ['file'] : []);
        if (command === 'create' && id) invalid('创建任务不接受任务编号。');
        operationPath(command, id);
        const body = validatePayload(command, ['create', 'import'].includes(command) ? await inputJson(flags.file) : {});
        const scopeId = await scope();
        const target = command === 'create' ? null : await request('/v1/outbound/tasks', { query: { task_id: safeId(id) } });
        const confirm = {
          action: { create: '创建外呼任务', import: '追加联系人', start: '开始外呼', pause: '暂停外呼' }[command],
          target: target ? { id, name: target.name, status: target.status } : { name: body.name, templateId: body.template_id, templateRevision: body.template_revision, contactsCount: body.contacts.length, autoStart: Boolean(body.auto_start) },
          ...(command === 'import' ? { count: body.contacts.length } : {}),
          consequence: command === 'create'
            ? (body.auto_start ? '创建后立即开始拨打并计费；费用以当前团队费率为准。请先核对 templates list 中该模板与 revision 的营销员、时间窗与并发。' : '仅创建任务，不开始拨打。请先核对 templates list 中该模板与 revision 的营销员、时间窗、并发及联系人 variables 要求。')
            : command === 'pause' ? '停止后续拨打；已在进行的通话可能继续。' : '可能发起真实电话并计费；费用以当前团队费率为准。向运行中的任务追加联系人可能立即拨号。',
        };
        await secureDir();
        const operationId = randomUUID();
        await save(join(stateDir, `${operationId}.json`), { id: operationId, scope: scopeId, action: command, target: id || null, targetIdentity: target ? taskIdentity(target) : null, body, confirm, state: 'prepared', createdAt: now() }, true);
        return result('confirm', { operationId, expiresAt: new Date(now() + TTL_MS).toISOString() }, { action: 'confirm', confirm, command: ['node', CLI, 'operation', 'confirm', operationId] });
      }
    }
    if (group === 'operation' && ['show', 'confirm'].includes(command)) {
      options(flags, []);
      const { path, record } = await readOperation(id);
      if (record.outcome) return record.outcome;
      const claimed = await lstat(`${path}.claim`).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      if (claimed) return result('unknown', { operationId: id }, { action: 'stop', say: '该操作已有提交记录，请查询结果，不要重复发送。' });
      if (record.state !== 'prepared') return result('unknown', { operationId: id }, { action: 'stop', say: '操作已提交或结果待核对，不会重复发送。请查询任务及进度。' });
      if (command === 'show') return result('done', { operationId: id, state: record.state, confirmation: record.confirm, expired: now() - record.createdAt > TTL_MS });
      if (now() - record.createdAt > TTL_MS) throw new ClientError('CONFIRMATION_EXPIRED', '预览已过期且尚未提交，请重新核对任务并生成预览。');
      const spec = operationPath(record.action, record.target);
      const body = record.action === 'start' || record.action === 'pause'
        ? { action: record.action }
        : validatePayload(record.action, record.body);
      if (record.target && taskIdentity(await request('/v1/outbound/tasks', { query: { task_id: safeId(record.target) } })) !== record.targetIdentity) throw new ClientError('TARGET_CHANGED', '任务状态或配置已改变，尚未提交。请重新核对并生成预览。');
      // A permanent exclusive claim survives timeouts/crashes. Never remove it to retry.
      try { await save(`${path}.claim`, { claimedAt: now() }, true); }
      catch (error) { if (error.code === 'EEXIST') return result('unknown', { operationId: id }, { action: 'stop', say: '该操作已有提交记录，请查询结果，不要重复发送。' }); throw error; }
      submissionClaimed = true;
      record.state = 'submitting';
      await save(path, record);
      let outcome;
      try { outcome = result('done', await request(spec.path, { method: 'POST', body, query: spec.query, idempotencyKey: id })); }
      catch (error) {
        outcome = result(error.uncertain ? 'unknown' : 'error', { operationId: id }, { action: 'stop', say: error.message });
        outcome.error = { code: error.code || 'REQUEST_FAILED', message: error.message };
      }
      await save(path, { ...record, state: outcome.state, outcome });
      return outcome;
    }
    invalid('未知命令，请运行 help 查看可用命令。');
  } catch (error) {
    const known = error instanceof ClientError;
    const message = submissionClaimed ? '提交结果未确定或记录写入失败，请查询业务状态，不要重复提交。' : known ? error.message : '无法读取配置或操作文件，请核对路径、JSON 格式和权限。';
    // API errors are data, never executable instructions; redact any known credential.
    const safe = apiKey ? message.replaceAll(apiKey, '[redacted]') : message;
    return { ...result(error.uncertain || submissionClaimed ? 'unknown' : 'error', {}, { action: 'stop', say: safe }), error: { code: known ? error.code : 'LOCAL_FILE_ERROR', message: safe } };
  }
}

// 经符号链接安装技能目录时,argv[1] 是链接路径而 import.meta.url 是真实路径;
// 两边都解析真实路径再比较,否则链接调用会静默零输出(违反协议承诺)。
const realPath = value => { try { return realpathSync(value); } catch { return ''; } };
if (process.argv[1] && realPath(process.argv[1]) === realPath(CLI)) {
  const output = await runCommand(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(output)}\n`);
  if (output.state === 'error' || output.state === 'unknown') process.exitCode = 1;
}
