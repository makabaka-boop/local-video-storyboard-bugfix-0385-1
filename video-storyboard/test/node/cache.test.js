import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb';
import { FrameCache } from '../../src/cache.js';

function freshIndexed() {
  globalThis.indexedDB = new IDBFactory();
}

const blob = (size, tag) => {
  const b = new Blob([new Uint8Array(size).fill(65)], { type: 'image/png' });
  b.tag = tag;
  return b;
};

test('存取命中：键 = 摘要+源时间；不同源时间不串帧', async () => {
  freshIndexed();
  const cache = new FrameCache();
  const f = blob(100, 'f1');
  await cache.put('sha256:abc/t1000', f);
  const got = await cache.get('sha256:abc/t1000');
  assert.ok(got, '命中');
  assert.equal(got.size, 100); // IndexedDB 会结构化克隆，按内容比较
  assert.equal(await cache.get('sha256:abc/t2000'), null);
  assert.equal(await cache.get('sha256:abd/t1000'), null);
});

test('有界：超出 maxEntries 时 LRU 淘汰最久未访问的帧', async () => {
  freshIndexed();
  const cache = new FrameCache({ maxEntries: 3, maxBytes: 10_000_000 });
  await cache.put('k1', blob(10, 1));
  await sleep(2);
  await cache.put('k2', blob(10, 2));
  await sleep(2);
  await cache.put('k3', blob(10, 3));
  await sleep(2);
  assert.ok(await cache.get('k1'), '访问 k1 刷新其 LRU 时间');
  await sleep(2);
  await cache.put('k4', blob(10, 4)); // 应淘汰 k2（而非 k1）

  assert.ok(await cache.get('k1'));
  assert.equal(await cache.get('k2'), null);
  assert.ok(await cache.get('k3'));
  assert.ok(await cache.get('k4'));
});

test('有界：超出 maxBytes 同样触发淘汰', async () => {
  freshIndexed();
  const cache = new FrameCache({ maxEntries: 1000, maxBytes: 250 });
  await cache.put('k1', blob(100, 1));
  await sleep(2);
  await cache.put('k2', blob(100, 2));
  await sleep(2);
  await cache.put('k3', blob(100, 3)); // 100+100+100 > 250，淘汰 k1
  assert.equal(await cache.get('k1'), null);
  assert.ok(await cache.get('k2'));
  assert.ok(await cache.get('k3'));
});

test('配额失败：put 不抛错，随后 get 从内存降级层取回', async () => {
  freshIndexed();
  const cache = new FrameCache();
  await cache.open();

  // 在“写请求”层面注入两次 QuotaExceededError，模拟浏览器配额中止：
  // 首次 put 失败 -> evict 后重试仍失败 -> 内存兜底，且全程不抛错。
  const realPut = IDBObjectStore.prototype.put;
  let failures = 0;
  IDBObjectStore.prototype.put = function (...args) {
    const req = realPut.apply(this, args);
    if (failures < 2) {
      failures += 1;
      const err = new DOMException('Quota exceeded.', 'QuotaExceededError');
      setTimeout(() => {
        // 必须 writable：fake-indexeddb 事务循环会对每个请求重新赋值 error
        Object.defineProperty(req, 'error', { value: err, configurable: true, writable: true });
        if (typeof req.onerror === 'function') req.onerror({ target: req });
        const tx = req.transaction;
        if (tx && typeof tx.onabort === 'function') tx.onabort({ target: tx });
      }, 0);
    }
    return req;
  };

  const f = blob(50, 'q');
  try {
    await assert.doesNotReject(cache.put('kq', f));
    const got = await cache.get('kq');
    assert.ok(got === f || (got && got.size === 50), '帧仍可取回（内存降级或重试成功）');

    const f2 = blob(50, 'q2');
    await assert.doesNotReject(cache.put('kq2', f2)); // 后续写入不受影响
    assert.ok(await cache.get('kq2'));
  } finally {
    IDBObjectStore.prototype.put = realPut;
  }
});

test('IndexedDB 不可用：静默降级纯内存，get/put/clear 正常', async () => {
  delete globalThis.indexedDB;
  const cache = new FrameCache();
  const f = blob(20, 'm');
  await cache.put('mk', f);
  assert.equal(await cache.get('mk'), f);
  await cache.clear();
  assert.equal(await cache.get('mk'), null);
  const u = await cache.usage();
  assert.equal(u.degraded, true);
  assert.equal(u.entries, 0);
});

test('clear 不影响使用；usage 统计条目数', async () => {
  freshIndexed();
  const cache = new FrameCache();
  await cache.put('a', blob(10));
  await cache.put('b', blob(10));
  let u = await cache.usage();
  assert.equal(u.entries, 2);
  await cache.clear();
  u = await cache.usage();
  assert.equal(u.entries, 0);
  assert.equal(u.bytes, 0);
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
