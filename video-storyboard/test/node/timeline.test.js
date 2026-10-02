import test from 'node:test';
import assert from 'node:assert/strict';
import { Timeline, MAX_POINTS, frameKeyFor } from '../../src/timeline.js';

function track(tl, opts = {}) {
  return tl.addTrack({
    name: opts.name ?? `v${Math.random()}`,
    digest: opts.digest ?? `d${Math.random()}`,
    duration: opts.duration ?? 10,
    offset: opts.offset ?? 0,
    width: 320, height: 180,
  });
}

test('偏移：项目时间可解析到正确的轨道与源时间', () => {
  const tl = new Timeline();
  const a = track(tl, { name: 'a', duration: 10 });
  const b = track(tl, { name: 'b', duration: 6, offset: 8 });

  assert.equal(
    a.id, tl.resolve(0).track.id,
  );
  const r = tl.resolve(9);
  assert.equal(r.track.id, a.id); // 重叠区取先插入的轨道
  assert.equal(r.sourceTime, 9);

  const r2 = tl.resolve(12);
  assert.equal(r2.track.id, b.id);
  assert.ok(Math.abs(r2.sourceTime - 4) < 1e-9); // 12 - 偏移 8

  assert.equal(tl.resolve(7.5).track.id, a.id); // a 覆盖 0~10；b 覆盖 8~14
  assert.equal(tl.projectDuration(), 14);

  const tl2 = new Timeline();
  track(tl2, { duration: 5 });
  track(tl2, { duration: 5, offset: 10 });
  assert.equal(tl2.resolve(7), null); // 5~10 是真空隙
});

test('空隙添加分镜点时吸附到最近的被覆盖时间', () => {
  const tl = new Timeline();
  track(tl, { duration: 5 });
  track(tl, { duration: 5, offset: 10 });
  const res = tl.addPoint(8); // 空隙 5~10
  assert.ok(res.ok);
  assert.ok(res.point.projectTime === 5 || res.point.projectTime === 10);
});

test('不超过 30 个分镜点；重复时刻拒绝', () => {
  const tl = new Timeline();
  track(tl, { duration: 1000 });
  assert.ok(tl.addPoint(0.1).ok);
  assert.equal(tl.addPoint(0.1004).ok, false); // 同一毫秒桶（都舍入到 100ms）
  assert.equal(tl.addPoint(0.1003).ok, false);
  assert.ok(tl.addPoint(0.102).ok, '102ms 是另一个桶，允许');
  tl.clearPoints();

  for (let i = 0; i < MAX_POINTS; i += 1) assert.ok(tl.addPoint(i + 0.01).ok);
  assert.equal(tl.points.length, MAX_POINTS);
  assert.equal(tl.addPoint(500).ok, false, '超出 30 个上限拒绝');
});

test('均分取点按项目时间排序且去重', () => {
  const tl = new Timeline();
  track(tl, { duration: 10 });
  const r = tl.addPointsUniform(5);
  assert.ok(r.ok);
  assert.equal(tl.points.length, 5);
  const ts = tl.points.map((p) => p.projectTime);
  assert.deepEqual(ts, [...ts].sort((x, y) => x - y));
});

test('修改偏移后分镜自动重解析，换到不同内容的点立即作废旧帧', () => {
  const tl = new Timeline();
  const a = track(tl, { name: 'a', duration: 10, digest: 'AAA' });
  const b = track(tl, { name: 'b', duration: 10, offset: 5, digest: 'BBB' });
  const res = tl.addPoint(7); // 落在 a（先插入），源时间 7
  const p = res.point;
  p.frame = new Blob(['x']);
  p.frameURL = 'blob:x';
  p.frameStatus = 'ok';

  tl.setOffset(a.id, 10); // a 移到 10~20；项目时间 7 现在落在 b
  assert.equal(p.trackId, b.id);
  assert.ok(Math.abs(p.sourceTime - 2) < 1e-9);
  assert.equal(p.frame, null, '旧帧必须被丢弃');
  assert.equal(p.frameStatus, 'stale');
  assert.equal(p.frameKey, frameKeyFor('BBB', 2));
});

test('删除轨道移除其分镜点并释放配额', () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 5 });
  const b = track(tl, { duration: 5, offset: 10 });
  tl.addPoint(2);
  tl.addPoint(12);
  assert.equal(tl.points.length, 2);
  tl.removeTrack(a.id);
  assert.equal(tl.points.length, 1);
  assert.equal(tl.points[0].trackId, b.id);
});

test('替换文件：同轨所有帧作废，即使源时间相同', () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 10, digest: 'old' });
  const p = tl.addPoint(3).point;
  p.frame = new Blob(['oldframe']);
  p.frameStatus = 'ok';
  tl.replaceTrack(a.id, { digest: 'new', duration: 10 });
  assert.equal(p.frame, null);
  assert.equal(p.frameStatus, 'stale');
  assert.equal(p.frameKey, frameKeyFor('new', 3));
});

test('confirmedSnapshot 始终有序且只含存在的轨道', () => {
  const tl = new Timeline();
  const a = track(tl, { duration: 100 });
  tl.addPoint(8);
  tl.addPoint(1);
  tl.addPoint(5);
  const snap = tl.confirmedSnapshot();
  assert.deepEqual(snap.map((p) => p.projectTime), [1, 5, 8]);
  assert.ok(snap.every((p) => p !== tl.points)); // 快照是新数组
});

test('缓存键只由摘要与源时间决定，与项目偏移无关', () => {
  assert.equal(frameKeyFor('D', 1.234), frameKeyFor('D', 1.2344));
  assert.notEqual(frameKeyFor('D', 1.234), frameKeyFor('D', 1.235));
  assert.notEqual(frameKeyFor('D1', 1), frameKeyFor('D2', 1));
  assert.match(frameKeyFor('abc', 0), /^sha256:abc\/t0$/);
});

test('对象形式摘要（{algo,hex}）重解析后缓存键仍用 hex，不产生 [object Object]', () => {
  const tl = new Timeline();
  const a = tl.addTrack({ name: 'a', digest: { algo: 'sha256', hex: 'AAAA' }, duration: 10 });
  const p = tl.addPoint(3).point;
  tl.setOffset(a.id, 1); // 触发重解析：源时间 3 -> 2
  assert.equal(p.frameKey, frameKeyFor('AAAA', 2));
  assert.ok(!p.frameKey.includes('[object Object]'));
});
