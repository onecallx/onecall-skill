import { test } from 'node:test';
import assert from 'node:assert/strict';

// 与 scripts/onecall.mjs 内联实现保持同一份逻辑做属性验证（零依赖单文件仓库无导出面，
// 测试以源码镜像方式锁实现；差异测试 tests/differential/ 另与服务端真实现比对）。
const normalizePhone = raw => {
  let s = String(raw).trim().replace(/[\s\-()（）]/g, '').replace(/^\+/, '');
  if (/^0086\d{11}$/.test(s)) s = s.slice(4);
  else if (/^86\d{11}$/.test(s)) s = s.slice(2);
  if (/^0(1[3-9]\d{9})$/.test(s)) s = s.slice(1);
  return s;
};

// 种子随机：mulberry32，保证失败可复现（失败输出 seed 重跑即复现）。
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const SEED = Number(process.env.PBT_SEED || 20261126);
const pick = (r, arr) => arr[Math.floor(r() * arr.length)];
const digits = r => {
  const n = 1 + Math.floor(r() * 15);
  return Array.from({ length: n }, () => String(Math.floor(r() * 10))).join('');
};
const noise = [' ', '-', '(', ')', '（', '）', '\t'];
const decorated = (r, core) => {
  let out = '';
  if (r() < 0.5) out += '+';
  for (const ch of core) {
    out += ch;
    if (r() < 0.25) out += pick(r, noise);
  }
  return out;
};

test('属性：归一化是幂等的（f(f(x)) === f(x)），任意装饰数字串', { timeout: 30000 }, () => {
  const r = rng(SEED);
  for (let i = 0; i < 500; i++) {
    const input = decorated(r, digits(r));
    const once = normalizePhone(input);
    assert.equal(normalizePhone(once), once, `非幂等: input=${JSON.stringify(input)} seed=${SEED} iter=${i}`);
  }
});

test('属性：归一化只删不增——结果是纯数字，且数字顺序为原输入子序列', { timeout: 30000 }, () => {
  const r = rng(SEED + 1);
  for (let i = 0; i < 500; i++) {
    const input = decorated(r, digits(r));
    const out = normalizePhone(input);
    assert.match(out, /^\d*$/, `含非数字: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
    const inputDigits = [...input].filter(c => c >= '0' && c <= '9');
    let idx = 0;
    for (const d of out) {
      idx = inputDigits.indexOf(d, idx);
      assert.notEqual(idx, -1, `非子序列: ${JSON.stringify(input)} -> ${JSON.stringify(out)}`);
      idx++;
    }
  }
});

test('属性：前缀剥离规则与移植的服务端契约一致（0086/86 剥 11 位数字；0 仅剥手机号形态）', { timeout: 30000 }, () => {
  // 服务端 outbound-guard 注释称"仅当剩余为 11 位手机号"，但正则 ^0086\d{11}$ 只校验 11 位数字、
  // 不校验 1[3-9] 开头——实现与注释不符，CLI 按实现忠实移植。此属性锁的是实现契约。
  const r = rng(SEED + 2);
  for (let i = 0; i < 300; i++) {
    const head = pick(r, ['0086', '86', '0']);
    const tail = r() < 0.5
      ? `1${pick(r, ['3','4','5','6','7','8','9'])}${Array.from({length:9},()=>String(Math.floor(r()*10))).join('')}`
      : `2${Array.from({length:10},()=>String(Math.floor(r()*10))).join('')}`;
    const out = normalizePhone(head + tail);
    const raw = head + tail;
    if (head === '0') {
      assert.equal(out, /^1[3-9]\d{9}$/.test(tail) ? tail : raw, `0前缀: ${raw} -> ${out}`);
    } else {
      assert.equal(out, tail, `${head}前缀: ${raw} -> ${out}`);
    }
  }
});
