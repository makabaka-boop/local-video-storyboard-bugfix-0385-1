// 导出一致性（三者同源）回归测试：
// 剪辑师在接触表导出过程中调整偏移/替换源文件时，
// 一次导出的分镜成员、画面（PNG 格子）与 JSON 清单必须仍对应
// 同一版已确认数据——覆盖连续编辑、缺帧、取消取帧与缓存命中。
import test from 'node:test';
import assert from 'node:assert/strict';
import { App } from '../../src/app.js';
import { FrameExtractor } from '../../src/extractor.js';
import { frameKeyFor } from '../../src/timeline.js';
import { buildManifest } from '../../src/exports.js';
import { makeHarness } from '../fakes.js';

globalThis.__FrameExtractor = FrameExtractor;

const microtasks = (n = 1) => {
  let p = Promise.resolve();
  for (let i = 0; i < n; i += 1) p = p.then(() => {});
  return p;
};

// 记录所有画布文字的假画布（Node 无 createImageBitmap/Image，
// 帧格会走占位分支，但表头文字照常绘制，足以校验“画进去的是哪一版”）
class RecCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.texts = [];
    RecCanvas.last = this;
  }

  getContext() {
    return {
      fillRect: () => {},
      strokeRect: () => {},
      setLineDash: () => {},
      drawImage: () => {},
      fillText: (s) => this.texts.push(String(s)),
    };
  }

  toBlob(cb) {
    queueMicrotask(() => cb(new Blob([`PNG ${this.width}x${this.height}`], { type: 'image/png' })));
  }
}

const memCache = () => {
  const m = new Map();
  return {
    get: async (k) => m.get(k) ?? null,
    put: async (k, v) => { m.set(k, v); },
    usage: async () => ({ entries: m.size, bytes: 0, degraded: true }),
    clear: async () => m.clear(),
  };
};

/** get 可手动放行的缓存：模拟“缓存命中在编辑之后才返回”的交错 */
class GateCache {
  constructor() { this.gates = []; }

  get(key) {
    return new Promise((resolve) => this.gates.push({ key, resolve }));
  }

  release(key, value) {
    const i = this.gates.findIndex((g) => g.key === key);
    assert.ok(i >= 0, `没有等待中的缓存请求: ${key}`);
    const [g] = this.gates.splice(i, 1);
    g.resolve(value);
  }

  put() { return Promise.resolve(); }
  usage() { return Promise.resolve({ entries: 0, bytes: 0, degraded: true }); }
  clear() { return Promise.resolve(); }
}

function seedApp({ cache } = {}) {
  const h = makeHarness({ auto: false, seekTimeout: 500 });
  const extractor = h.makeExtractor({ concurrency: 4 });
  const app = new App({ extractor, cache: cache ?? memCache() });
  const trA = app.timeline.addTrack({
    name: 'a.webm', digest: { algo: 'sha256', hex: 'AAAA' }, duration: 10, width: 320, height: 180,
  });
  const trB = app.timeline.addTrack({
    name: 'b.webm', digest: { algo: 'sha256', hex: 'BBBB' }, duration: 4, offset: 12, width: 320, height: 180,
  });
  app.files.set(trA.id, { url: 'blob://A', file: null, digest: { algo: 'sha256', hex: 'AAAA' } });
  app.files.set(trB.id, { url: 'blob://B', file: null, digest: { algo: 'sha256', hex: 'BBBB' } });
  return { app, h, trA, trB };
}

/** 直接把点置为“帧已就绪”的确认态（等价于取帧完成后的状态） */
function confirmFrame(point, hex) {
  point.frame = new Blob([`frame-${point.id}`], { type: 'image/png' });
  point.frameStatus = 'ok';
  point.frameKey = frameKeyFor(hex, point.sourceTime);
  point.frameFromCache = false;
}

test('导出进行中连续编辑（偏移/换轨/替换文件）：PNG 表头与 JSON 清单同为冻结版本', async () => {
  const { app, trA, trB } = seedApp();
  const p1 = app.timeline.addPoint(2).point; // A 源 2
  const p2 = app.timeline.addPoint(13).point; // B 源 1
  const p3 = app.timeline.addPoint(9.5).point; // A 源 9.5
  const p4 = app.timeline.addPoint(6).point; // A 源 6，故意缺帧（未取帧）
  confirmFrame(p1, 'AAAA');
  confirmFrame(p2, 'BBBB');
  confirmFrame(p3, 'AAAA');

  const exportP = app.exportContactSheet({ columns: 2, createCanvas: (w, hh) => new RecCanvas(w, hh) });

  // 导出尚未完成（卡在逐格解码/toBlob 的微任务里），此时连续编辑：
  app.commitOffset(trB.id, 9); // B 移到 [9,13]：p2 源时间 1 -> 4
  app.commitOffset(trA.id, 20); // A 移到 [20,30]：p3 换到 B 轨 源 0.5；p1/p4 落入空隙
  app.timeline.replaceTrack(trA.id, { digest: { algo: 'sha256', hex: 'ZZZZ' }, duration: 10 });

  const { sheet, manifest, count } = await exportP;

  // 实时数据确实已经变了（否则本测试没有意义）
  assert.equal(p2.sourceTime, 4);
  assert.equal(p3.trackId, trB.id);
  assert.equal(p3.sourceTime, 0.5);

  // 清单必须仍是冻结时版本：成员、顺序、轨道、源时间、缓存键、帧状态
  assert.equal(count, 4);
  assert.deepEqual(manifest.points.map((p) => p.id), [p1.id, p4.id, p3.id, p2.id]);
  const m3 = manifest.points.find((p) => p.id === p3.id);
  assert.equal(m3.trackId, trA.id);
  assert.equal(m3.sourceTime, 9.5);
  assert.equal(m3.frameKey, 'sha256:AAAA/t9500');
  assert.equal(m3.frameReady, true);
  const m2 = manifest.points.find((p) => p.id === p2.id);
  assert.equal(m2.trackId, trB.id);
  assert.equal(m2.sourceTime, 1);
  assert.equal(m2.frameKey, 'sha256:BBBB/t1000');
  assert.equal(m2.frameReady, true);
  // 轨道视图同样冻结：偏移与摘要都是导出那一刻的值
  assert.equal(manifest.tracks.find((t) => t.id === trA.id).offset, 0);
  assert.equal(manifest.tracks.find((t) => t.id === trA.id).digest, 'AAAA');
  assert.equal(manifest.tracks.find((t) => t.id === trB.id).offset, 12);

  // 缺帧点：清单标注 frameReady:false，PNG 保留占位格——两者同版
  const m4 = manifest.points.find((p) => p.id === p4.id);
  assert.equal(m4.frameReady, false);
  assert.equal(m4.status, 'idle');

  // PNG 表头文字也必须是冻结时版本（格子与清单逐格对应）
  const texts = RecCanvas.last.texts;
  assert.ok(texts.some((t) => t.includes('a.webm @ 00:09.50')), 'p3 表头应为冻结时的 A 轨 9.5s');
  assert.ok(texts.some((t) => t.includes('b.webm @ 00:01.00')), 'p2 表头应为冻结时的源 1s');
  assert.ok(!texts.some((t) => t.includes('@ 00:04.00')), '不得画入调整后的源 4s');
  assert.ok(!texts.some((t) => t.includes('b.webm @ 00:00.50')), '不得画入调整后的换轨结果');
  assert.ok(texts.some((t) => t.includes('缺帧')), '缺帧点保留占位格');
  assert.ok(sheet.blob.size > 0);
});

test('缓存命中迟到：旧版本（偏移前）键的命中不得进入已重解析的分镜', async () => {
  const cache = new GateCache();
  const { app, h, trA } = seedApp({ cache });
  const p = app.timeline.addPoint(2).point; // A 源 2
  const K2000 = 'sha256:AAAA/t2000';
  const K1000 = 'sha256:AAAA/t1000';

  const cap1 = app.ensurePointFrame(p); // 绑定 K2000，缓存请求待放行
  await microtasks(3);
  app.commitOffset(trA.id, 1); // 源时间 2 -> 1：重新解析并发起新一轮取帧（K1000）
  await microtasks(3);
  assert.equal(p.frameKey, K1000);

  // 旧键的缓存命中姗姗来迟：必须被挡下（版本已不属于它）
  const staleBlob = new Blob(['stale-from-cache']);
  cache.release(K2000, staleBlob);
  await cap1;
  await microtasks(3);
  assert.equal(p.frame, null, '旧键缓存命中不得入帧');
  assert.equal(p.frameStatus, 'loading', '新一轮取帧仍在进行');

  // 新键的缓存命中正常入帧
  const freshBlob = new Blob(['fresh-from-cache']);
  cache.release(K1000, freshBlob);
  await microtasks(5);
  assert.equal(p.frame, freshBlob);
  assert.equal(p.frameFromCache, true);
  assert.equal(p.frameStatus, 'ok');
  assert.equal(p.frameKey, K1000);
  assert.equal(h.created.length, 0, '两个版本都由缓存解决，不应发起实时提取');
});

test('导出前收敛：在途取帧未结束时 refreshStaleFrames 不得返回', async () => {
  const { app, h } = seedApp();
  const p = app.timeline.addPoint(2).point;

  const cap = app.ensurePointFrame(p); // 缓存未命中 -> 实时提取（事件待派发）
  let resolved = false;
  const done = app.refreshStaleFrames().then(() => { resolved = true; });
  await microtasks(8);
  assert.equal(resolved, false, '在途取帧进行中就放行，导出会冻结到中间态');

  await h.env.drain(); // 派发媒体事件，让在途取帧完成
  await done;
  await cap;
  assert.equal(p.frameStatus, 'ok');
  assert.equal(p.frame.__mark.time, 2);
  assert.equal(p.frame.__mark.url, 'blob://A');
});

test('freezeSnapshot：冻结后对实时数据的任何改写都不影响快照与清单', async () => {
  const { app, trA, trB } = seedApp();
  const p1 = app.timeline.addPoint(2).point;
  confirmFrame(p1, 'AAAA');

  const { snapshot, tracks } = app.freezeSnapshot();
  assert.equal(snapshot.length, 1);
  assert.notEqual(snapshot[0], p1, '快照必须是拷贝而非实时引用');

  // 冻结后发生：偏移调整、替换文件、在途帧完成（直接模拟实时突变）
  app.timeline.setOffset(trA.id, 5);
  app.timeline.replaceTrack(trB.id, { digest: { algo: 'sha256', hex: 'CCCC' }, duration: 4 });
  p1.frame = null;
  p1.frameStatus = 'stale';
  p1.sourceTime = 99;

  const frozen = snapshot[0];
  assert.equal(frozen.sourceTime, 2);
  assert.equal(frozen.frameKey, 'sha256:AAAA/t2000');
  assert.equal(frozen.frameStatus, 'ok');
  assert.ok(frozen.frame instanceof Blob, '帧 Blob 随快照定格');
  assert.ok(Object.isFrozen(frozen));
  assert.equal(tracks.get(trA.id).offset, 0);
  assert.equal(tracks.get(trB.id).digest.hex, 'BBBB');
  assert.ok(Object.isFrozen(tracks.get(trA.id)));

  const m = buildManifest(snapshot, tracks, null);
  assert.equal(m.points[0].sourceTime, 2);
  assert.equal(m.points[0].frameKey, 'sha256:AAAA/t2000');
  assert.equal(m.points[0].frameReady, true);
});

test('取消取帧后导出：被取消的点以缺帧同版进入 PNG 与清单', async () => {
  const { app } = seedApp();
  const p1 = app.timeline.addPoint(2).point;
  confirmFrame(p1, 'AAAA');
  const p2 = app.timeline.addPoint(4).point;
  const cap = app.ensurePointFrame(p2); // 在途
  await microtasks(3);
  app.extractor.cancelAll(); // 用户清空/取消：在途任务作废
  await cap;
  p2.frameStatus = 'idle'; // 取消后保持未就绪（等价 UI 清空前的状态）

  const { manifest } = await app.exportContactSheet({ columns: 2, createCanvas: (w, hh) => new RecCanvas(w, hh) });
  assert.equal(manifest.points.length, 2);
  const [m1, m2] = manifest.points;
  assert.equal(m1.frameReady, true);
  assert.equal(m2.frameReady, false, '被取消的点如实标注缺帧，与 PNG 占位格同版');
  assert.equal(m2.frameKey, 'sha256:AAAA/t4000');
});
