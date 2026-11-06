// The share link: a result survives the round trip, and anything else is refused (the Worker answers it with a 404)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode, sharePath, squeeze, CELLS } from '../src/share.mjs';

const R = {
  ts: 1793950000000, key: 'service', conf: 3, secs: 120, mon: false, near: 23.4, jitter: 4.1, loss: 0, mos: 4.3, game: 'good', spikes: 0,
  setup: 120, grade: 'A+', rise: 3, cc: 'CN', colo: 'HKG', ids: ['chatgpt', 'c:www.bing.com'], incidents: 2, nearAs: 'direct',
  lanes: { device: Array(30).fill('ok'), near: ['ok', 'warn', 'bad'], udp: ['none', 'ok'], svc: ['down'] },
};

test('a result survives the link', () => {
  const r = decode(encode(R));
  assert.equal(r.key, 'service');
  assert.equal(r.grade, 'A+');
  assert.equal(r.near, 23.4);
  assert.deepEqual(r.ids, ['chatgpt', 'www.bing.com']);
  assert.equal(r.nearAs, 'direct');
  assert.equal(r.lanes.device.length, CELLS);
  assert.deepEqual(r.lanes.near, ['ok', 'warn', 'bad']);
  assert.equal(r.lanes.gw, null);
  assert.equal(encode(r), encode(R));
});

test('a long run keeps its worst moments when squeezed', () => {
  const st = Array(240).fill('ok');
  st[100] = 'bad';
  assert.ok(squeeze(st).includes('bad'));
  assert.equal(squeeze(st).length, CELLS);
});

test('codes it cannot read are refused', () => {
  const c = encode(R);
  for (const bad of ['', '1~bad', c.replace('~service~', '~nope~'), c.replace(/~[ndp]$/, '~z'), '2' + c.slice(1), c + '~x', c.replace('.ooo', '.oqo')])
    assert.equal(decode(bad), null, bad);
});

test('the link path, in every language folder', () => {
  assert.deepEqual(sharePath('/r/abc'), { slug: '', code: 'abc' });
  assert.deepEqual(sharePath('/zh-cn/r/abc/'), { slug: 'zh-cn', code: 'abc' });
  assert.equal(sharePath('/zh-cn/x/abc'), null);
});
