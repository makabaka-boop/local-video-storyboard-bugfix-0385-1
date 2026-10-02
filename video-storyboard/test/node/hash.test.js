import test from 'node:test';
import assert from 'node:assert/strict';
import { digestFile, fcs32 } from '../../src/hash.js';
import { FrameCache } from '../../src/cache.js';

test('digestFile：相同内容同摘要，不同内容不同摘要（Node WebCrypto）', async () => {
  const f1 = new File([new Uint8Array([1, 2, 3, 4])], 'a.mp4');
  const f2 = new File([new Uint8Array([1, 2, 3, 4])], 'b-renamed.mp4'); // 内容相同、名字不同
  const f3 = new File([new Uint8Array([1, 2, 3, 5])], 'c.mp4');
  const d1 = await digestFile(f1);
  const d2 = await digestFile(f2);
  const d3 = await digestFile(f3);
  assert.equal(d1.algo, 'sha256');
  assert.equal(d1.hex, d2.hex, '摘要只看内容，不看文件名');
  assert.notEqual(d1.hex, d3.hex);
  assert.equal(d1.hex.length, 64);
});

test('fcs32 回退哈希确定且雪崩', () => {
  const a = new Uint8Array([9, 9, 9]);
  const b = new Uint8Array([9, 9, 8]);
  assert.equal(fcs32(a), fcs32(new Uint8Array([9, 9, 9])));
  assert.notEqual(fcs32(a), fcs32(b));
});

test('真实缓存路径：同一摘要+源时间跨“会话”（新建 Cache 实例）命中', async () => {
  const { IDBFactory } = await import('fake-indexeddb');
  const factory = new IDBFactory(); // 同一源的 IndexedDB（库持久）
  globalThis.indexedDB = factory;
  const c1 = new FrameCache();
  const f = new Blob([new Uint8Array(10)]);
  await c1.put('sha256:deadbeef/t2500', f);

  // “重开页面”：应用层的 FrameCache 实例全部重建，但不重新选文件、
  // 只凭摘要键不会自动命中——必须重新选中内容相同的视频得到同一摘要。
  globalThis.indexedDB = factory;
  const c2 = new FrameCache();
  const got = await c2.get('sha256:deadbeef/t2500');
  assert.ok(got, '内容相同（摘要相同）+ 同源时间 -> 复用缓存帧');
  assert.equal(got.size, 10);
  assert.equal(await c2.get('sha256:deadbeef/t2501'), null, '不同源时间不命中');

  // 选中了内容不同的视频（摘要不同）：同样源时间也不得命中旧缓存
  assert.equal(await c2.get('sha256:cafef00d/t2500'), null, '不同摘要不命中');
});
