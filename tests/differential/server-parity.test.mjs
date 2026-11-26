import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync } from 'node:fs';

// 差异测试：CLI 内联 normalizePhone（源码镜像）vs 服务端真实现
// （/opt/www/onecall1/server/lib/outbound-guard.ts，经其 tsx 运行时加载）。
// 移植保真性的黄金标准：同一批输入（边界 + 种子随机），输出必须逐字节一致。
const CLI_NORMALIZE = raw => {
  let s = String(raw).trim().replace(/[\s\-()（）]/g, '').replace(/^\+/, '');
  if (/^0086\d{11}$/.test(s)) s = s.slice(4);
  else if (/^86\d{11}$/.test(s)) s = s.slice(2);
  if (/^0(1[3-9]\d{9})$/.test(s)) s = s.slice(1);
  return s;
};

const SERVER_REPO = '/opt/www/onecall1';
const SERVER_SRC = join(SERVER_REPO, 'server', 'lib', 'outbound-guard.ts');
const available = existsSync(SERVER_SRC) && existsSync('/opt/www/onecall1/node_modules/.bin/tsx');

// outbound-guard.ts 顶层 import db（连接 PG 的重初始化），而 normalizePhone 纯函数不使用
// db——主测试读真源码、仅剥离该 import 行后写到临时 .ts，交服务端 tsx 原样执行（函数体不动）。
// 侧车只负责加载该临时模块并跑 stdin 输入数组。
const SIDECAR = `
import fs from 'node:fs';
const m = await import(process.argv[2]);
const inputs = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(1, JSON.stringify(inputs.map(x => m.normalizePhone(x))));
`;

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const digits = (r, n) => Array.from({ length: n }, () => String(Math.floor(r() * 10))).join('');
const noise = [' ', '-', '(', ')', '（', '）', '\t'];

test('差异：CLI 归一化与服务端 outbound-guard 真实现完全一致', { timeout: 120000, skip: !available && '服务端仓库不可用（差异测试绑定本机 /opt/www/onecall1）' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'oc-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const sidecar = join(dir, 'sidecar.mjs');
  await writeFile(sidecar, SIDECAR);

  const r = rng(42);
  const inputs = [
    '', '+', ' ', '-', '+8613800000000', '008613800000000', '8613800000000',
    '013800000000', '138-0000-0001', '(0571) 8888 8888',
    '008623103550605', '8623103550605', '023103550605', '12345', '+008613800000000',
  ];
  for (let i = 0; i < 400; i++) {
    let core = digits(r, 1 + Math.floor(r() * 14));
    if (r() < 0.4) core = pick(r, ['0086', '86', '0']) + digits(r, pick(r, [10, 11, 12]));
    let decoratedInput = '';
    if (r() < 0.5) decoratedInput += pick(r, ['+', '0', '']);
    for (const ch of core) { decoratedInput += ch; if (r() < 0.25) decoratedInput += pick(r, noise); }
    inputs.push(decoratedInput);
  }

  // 读真源码，仅剥离顶层 db import，写临时 .ts 供侧车加载。
  const { readFile: readFileAsync } = await import('node:fs/promises');
  const realSrc = await readFileAsync(SERVER_SRC, 'utf8');
  const stripped = realSrc.replace(/^import db .*$/m, 'const db: any = null;');
  const strippedPath = join(dir, 'outbound-guard.stripped.ts');
  await writeFile(strippedPath, stripped);

  const proc = spawnSync('/opt/www/onecall1/node_modules/.bin/tsx', [sidecar, strippedPath], {
    input: JSON.stringify(inputs),
    encoding: 'utf8',
    timeout: 90000,
    cwd: SERVER_REPO,
  });
  assert.equal(proc.status, 0, `侧车失败: ${proc.stderr.slice(0, 300)}`);
  const serverOut = JSON.parse(proc.stdout);
  assert.equal(serverOut.length, inputs.length);
  const mismatches = [];
  inputs.forEach((input, i) => {
    const cli = CLI_NORMALIZE(input);
    if (cli !== serverOut[i]) mismatches.push(`input=${JSON.stringify(input)} cli=${JSON.stringify(cli)} server=${JSON.stringify(serverOut[i])}`);
  });
  assert.deepEqual(mismatches, [], `移植偏差 ${mismatches.length} 例（前 5 例）:\n${mismatches.slice(0, 5).join('\n')}`);
});
