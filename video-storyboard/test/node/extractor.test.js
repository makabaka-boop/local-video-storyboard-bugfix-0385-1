import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameExtractor } from '../../src/extractor.js';
import { makeHarness, FakeCanvas } from '../fakes.js';

globalThis.__FrameExtractor = FrameExtractor;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('正常取帧：load→seek→toBlob，blob 携带源时间标记', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 100 });
  const ex = h.makeExtractor();
  const p = ex.capture('p1', { trackId: 't1', url: 'blob://a', sourceTime: 3.5 });
  h.env.flush();
  const res = await p;
  assert.equal(res.status, 'ok');
  assert.equal(res.blob.__mark.time, 3.5);
  assert.equal(res.blob.__mark.url, 'blob://a');
  assert.ok(h.created[0].destroyed); // 媒体用完即销毁
});

test('乱序加载/seek：同一点连续取两次，旧请求即使回调晚到也只能 stale', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 100 });
  const ex = h.makeExtractor();

  const first = ex.capture('p1', { trackId: 't1', url: 'blob://old', sourceTime: 1 });
  const second = ex.capture('p1', { trackId: 't1', url: 'blob://new', sourceTime: 2 });

  // 故意让旧媒体的两个回调都在新媒体之前派发（乱序）
  const oldM = h.created[0];
  const newM = h.created[1];
  h.env.flush({ media: oldM });
  h.env.flush({ media: newM });

  const r1 = await first;
  const r2 = await second;
  assert.equal(r1.status, 'stale', '旧请求不得提交帧');
  assert.equal(r2.status, 'ok');
  assert.equal(r2.blob.__mark.time, 2);
  assert.equal(r2.blob.__mark.url, 'blob://new');
});

test('乱序到 toBlob 阶段：旧帧画完后晚返回，仍不得占据新分镜', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 200 });
  const ex = h.makeExtractor();
  FakeCanvas.toBlobDelay = 30;
  try {
    const first = ex.capture('p1', { trackId: 't1', url: 'blob://old', sourceTime: 1 });
    h.env.flush(); // 旧请求画完，toBlob 在 30ms 的路上
    await sleep(0);

    const second = ex.capture('p1', { trackId: 't1', url: 'blob://new', sourceTime: 2 });
    h.env.flush();
    const r2 = await second;
    assert.equal(r2.status, 'ok');
    assert.equal(r2.blob.__mark.time, 2);

    const r1 = await first;
    assert.equal(r1.status, 'stale', '晚到的旧 toBlob 必须作废');
  } finally {
    FakeCanvas.toBlobDelay = 0;
  }
});

test('替换文件：bumpTrack 后该轨全部在途请求 stale，旧帧不进新分镜', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 100 });
  const ex = h.makeExtractor();
  const p1 = ex.capture('p1', { trackId: 't1', url: 'blob://file1', sourceTime: 2 });
  const p2 = ex.capture('p2', { trackId: 't1', url: 'blob://file1', sourceTime: 5 });
  const pOther = ex.capture('p3', { trackId: 't9', url: 'blob://other', sourceTime: 1 });

  // 此时三个 loadedmetadata 都在队列里；用户替换了 t1 的文件
  ex.bumpTrack('t1');
  h.env.flush();

  const [r1, r2, r3] = await Promise.all([p1, p2, pOther]);
  assert.equal(r1.status, 'stale');
  assert.equal(r2.status, 'stale');
  assert.equal(r3.status, 'ok'); // 其他轨道不受影响
});

test('cancelAll：所有在途与排队任务 stale', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 100 });
  const ex = h.makeExtractor({ concurrency: 1 });
  const p1 = ex.capture('p1', { trackId: 't1', url: 'u', sourceTime: 1 });
  const p2 = ex.capture('p2', { trackId: 't1', url: 'u', sourceTime: 2 }); // 排队中
  assert.equal(ex._running, 1);

  ex.cancelAll();
  h.env.flush();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'stale');
  assert.equal(r2.status, 'stale');
});

test('取消单分镜点：cancelPoint 后在途请求 stale，不影响其他点', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 100 });
  const ex = h.makeExtractor();
  const p1 = ex.capture('p1', { trackId: 't1', url: 'u', sourceTime: 1 });
  const p2 = ex.capture('p2', { trackId: 't1', url: 'u', sourceTime: 2 });
  ex.cancelPoint('p1');
  h.env.flush();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'stale');
  assert.equal(r2.status, 'ok');
  assert.equal(r2.blob.__mark.time, 2);
});

test('并发上限：超出 concurrency 的任务排队，槽位释放后按序执行', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 200 });
  const ex = h.makeExtractor({ concurrency: 2 });
  const p1 = ex.capture('p1', { trackId: 't1', url: 'u1', sourceTime: 1 });
  const p2 = ex.capture('p2', { trackId: 't1', url: 'u2', sourceTime: 2 });
  const p3 = ex.capture('p3', { trackId: 't1', url: 'u3', sourceTime: 3 });
  const [m1, m2] = h.created;
  assert.equal(h.created.length, 2, '第三个任务排队，未创建媒体');

  // 完成第一个任务，腾出一个槽位 -> 第三个立即启动（创建第三个媒体）
  h.env.tick({ media: m1, type: 'loadedmetadata' });
  h.env.tick({ media: m1, type: 'seeked' });
  const r1 = await p1;
  assert.equal(r1.status, 'ok');
  assert.equal(h.created.length, 3, '槽位释放后第三个任务启动');

  await h.env.drain();
  const [r2, r3] = await Promise.all([p2, p3]);
  assert.equal(r2.status, 'ok');
  assert.equal(r2.blob.__mark.url, 'u2');
  assert.equal(r3.status, 'ok');
  assert.equal(r3.blob.__mark.url, 'u3');
});

test('seek 回调乱序（旧点后请求先 seeked）也只接受在世请求', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 100 });
  const ex = h.makeExtractor();
  const p1 = ex.capture('p1', { trackId: 't1', url: 'u', sourceTime: 1 });
  const p2 = ex.capture('p2', { trackId: 't1', url: 'u', sourceTime: 2 });
  const m1 = h.created[0];
  const m2 = h.created[1];
  // 元数据顺序到达，seeked 乱序（p2 先）
  h.env.tick({ media: m1, type: 'loadedmetadata' });
  h.env.tick({ media: m2, type: 'loadedmetadata' });
  h.env.tick({ media: m2, type: 'seeked' });
  h.env.tick({ media: m1, type: 'seeked' });
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.status, 'ok');
  assert.equal(r1.blob.__mark.time, 1);
  assert.equal(r2.status, 'ok');
  assert.equal(r2.blob.__mark.time, 2);
});

test('媒体 error：当前请求兑现 error 而不是悬空', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 100 });
  const ex = h.makeExtractor();
  const p = ex.capture('p1', { trackId: 't1', url: 'u', sourceTime: 1 });
  h.created[0].failLoad(4);
  h.env.flush();
  const r = await p;
  assert.equal(r.status, 'error');
  assert.match(r.error.message, /媒体错误/);
});

test('加载阶段超时：无任何回调时兑现 error', async () => {
  const h = makeHarness({ auto: false, seekTimeout: 20 });
  const ex = h.makeExtractor();
  const p = ex.capture('p1', { trackId: 't1', url: 'u', sourceTime: 1 });
  const r = await p;
  assert.equal(r.status, 'error');
  assert.match(r.error.message, /元数据超时/);
});
