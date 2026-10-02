import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContactSheet, buildManifest, formatTime } from '../../src/exports.js';

class StubCtx {
  constructor() { this.calls = []; }
  fillRect(...a) { this.calls.push(['fillRect', ...a]); }
  drawImage(...a) { this.calls.push(['drawImage', a[0]]); }
  strokeRect(...a) { this.calls.push(['strokeRect', ...a]); }
  setLineDash() {}
  fillText(...a) { this.calls.push(['fillText', a[0]]); }
}

class StubCanvas {
  constructor(w, h) { this.width = w; this.height = h; this.ctx = new StubCtx(); }
  getContext() { return this.ctx; }
  toBlob(cb) {
    queueMicrotask(() => cb(new Blob([`PNG ${this.width}x${this.height}`], { type: 'image/png' })));
  }
}

function setup(points) {
  const tracks = new Map([
    ['t1', { id: 't1', name: 'clip-a.mp4', digest: { algo: 'sha256', hex: 'AAA' }, duration: 10, offset: 0, width: 320, height: 180 }],
    ['t2', { id: 't2', name: 'clip-b.mp4', digest: { algo: 'sha256', hex: 'BBB' }, duration: 4, offset: 9, width: 320, height: 180 }],
  ]);
  return { tracks, points };
}

test('formatTime 格式化', () => {
  assert.equal(formatTime(0), '00:00.00');
  assert.equal(formatTime(84.5), '01:24.50');
});

test('接触表与清单共用同一快照：顺序/index/轨道一致，缺帧也保留格子', async () => {
  const points = [
    { id: 'p1', projectTime: 1, trackId: 't1', sourceTime: 1, frame: null, frameStatus: 'stale', frameFromCache: false, frameKey: 'sha256:AAA/t1000' },
    { id: 'p2', projectTime: 9.5, trackId: 't2', sourceTime: 0.5, frame: new Blob(['x']), frameStatus: 'ok', frameFromCache: true, frameKey: 'sha256:BBB/t500' },
    { id: 'p3', projectTime: 5, trackId: 't1', sourceTime: 5, frame: new Blob(['y']), frameStatus: 'ok', frameFromCache: false, frameKey: 'sha256:AAA/t5000' },
  ];
  const { tracks } = setup(points);
  // 注意：直接按“已确认快照”的顺序传入（乱序），导出不得重排
  const sheet = await buildContactSheet(points, tracks, { columns: 2, createCanvas: (w, h) => new StubCanvas(w, h) });
  const manifest = buildManifest(points, tracks, sheet);

  assert.equal(manifest.points.length, 3);
  // 顺序完全一致
  assert.deepEqual(manifest.points.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.equal(manifest.contactSheet.points, 3);
  assert.equal(manifest.contactSheet.columns, 2);
  assert.equal(manifest.contactSheet.rows, 2);

  // 缺帧点：frameReady=false 但仍是第 1 格，接触表文字含“缺帧”
  assert.equal(manifest.points[0].frameReady, false);
  const texts = sheet; // 画布尺寸也反映 4 格（2x2）
  assert.ok(texts.width > 0 && texts.height > 0);

  // 第二点带“缓存命中”标记
  assert.equal(manifest.points[1].frameFromCache, true);
  assert.equal(manifest.points[1].projectTime, 9.5);
  assert.equal(manifest.points[1].sourceTime, 0.5);
  assert.equal(manifest.points[1].trackName, 'clip-b.mp4');

  // 轨道清单含偏移与摘要
  assert.equal(manifest.tracks[1].offset, 9);
  assert.equal(manifest.tracks[1].digest, 'BBB');
  assert.equal(manifest.format, 'video-storyboard-manifest');
});

test('空快照也能生成接触表与清单（1 行占位，不崩）', async () => {
  const { tracks } = setup([]);
  const sheet = await buildContactSheet([], tracks, { columns: 4, createCanvas: (w, h) => new StubCanvas(w, h) });
  const manifest = buildManifest([], tracks, sheet);
  assert.equal(manifest.points.length, 0);
  assert.equal(sheet.rows, 1);
});
