// 应用主控：导入/偏移/取帧调度/播放/导出。
// 不变量：
//  1) PNG 接触表与 JSON 清单只能消费同一次 freezeSnapshot() 的
//     不可变副本（成员、顺序、源时间、缓存键、帧全部定格在同一版
//     已确认数据）；点击播放读取当前确认状态，未再编辑时与该快照一致；
//  2) 取帧的竞争安全全部由 FrameExtractor 保证（令牌+换代）；
//  3) 缓存失败只影响“帧”，Timeline 与分镜清单永远可用；
//  4) objectURL 失效时统一经 releasePointFrame 回收。

import { Timeline, frameKeyFor } from './timeline.js';
import { FrameExtractor } from './extractor.js';
import { FrameCache } from './cache.js';
import { digestFile } from './hash.js';
import { createRealMedia, createRealCanvas, probeVideo } from './media-dom.js';
import { buildContactSheet, buildManifest, downloadBlob } from './exports.js';

const OFFSET_DEBOUNCE_MS = 150;

export class App {
  constructor({ extractor, cache } = {}) {
    this.timeline = new Timeline();
    this.extractor = extractor ?? new FrameExtractor({
      createMedia: createRealMedia,
      createCanvas: createRealCanvas,
      concurrency: 3,
    });
    this.cache = cache ?? new FrameCache({ maxBytes: 200 * 1024 * 1024 });
    /** trackId -> {url,file,digest:{algo,hex}} */
    this.files = new Map();
    this.playFile = null;       // 当前播放器载入的 {trackId, url}
    this.onDirty = null;        // 数据变化后 UI 重绘回调
    this._offsetTimers = new Map();
    /** pointId -> {key, promise}：在途取帧。导出前据此等待收敛；
     *  同一点同一版本的并发请求合并为一个任务。 */
    this._inflight = new Map();
  }

  emit() { this.onDirty?.(); }

  tracks() { return this.timeline.tracks; }
  points() { return this.timeline.points; }

  // ---------- 导入 ----------

  async importFiles(fileList) {
    const files = [...fileList].filter((f) => f.type.startsWith('video/') || /\.(webm|mp4|mov|m4v|ogv|mkv)$/i.test(f.name));
    const errors = [];
    for (const file of files) {
      try {
        // eslint-disable-next no-await-in-loop
        await this._addFile(file);
      } catch (err) {
        errors.push(`${file.name}: ${err.message}`);
      }
    }
    this.emit();
    return errors;
  }

  async _addFile(file) {
    const { algo, hex, bytes } = await digestFile(file);
    const meta = await probeVideo(file);
    const track = this.timeline.addTrack({
      file, name: file.name, digest: { algo, hex },
      duration: meta.duration, width: meta.width, height: meta.height,
    });
    const url = URL.createObjectURL(file);
    this.files.set(track.id, { url, file, bytes, digest: { algo, hex } });
    return track;
  }

  /** 替换某轨的源文件：在途帧立即换代失效，旧 URL 回收 */
  async replaceFile(trackId, file) {
    const entry = this.files.get(trackId);
    const { algo, hex, bytes } = await digestFile(file);
    const meta = await probeVideo(file);
    // 先换代：任何属于旧文件的在途取帧都不允许提交
    this.extractor.bumpTrack(trackId);
    if (entry) URL.revokeObjectURL(entry.url);
    const url = URL.createObjectURL(file);
    this.files.set(trackId, { url, file, bytes, digest: { algo, hex } });
    this.timeline.replaceTrack(trackId, {
      file, name: file.name, digest: { algo, hex },
      duration: meta.duration, width: meta.width, height: meta.height,
    });
    if (this.playFile?.trackId === trackId) this.playFile = { trackId, url };
    this.emit();
    await this.refreshStaleFrames();
  }

  removeTrack(trackId) {
    const entry = this.files.get(trackId);
    this.extractor.bumpTrack(trackId);
    if (entry) URL.revokeObjectURL(entry.url);
    for (const p of this.timeline.points) {
      if (p.trackId === trackId && p.frameURL) URL.revokeObjectURL(p.frameURL);
    }
    this.files.delete(trackId);
    if (this.playFile?.trackId === trackId) this.playFile = null;
    this.timeline.removeTrack(trackId);
    this.emit();
    // 其余点可能因覆盖关系换轨而被作旧，与其他编辑操作一样立即补帧
    this.refreshStaleFrames();
  }

  // ---------- 偏移 ----------

  /** 拖动/输入时实时更新（内部做防抖合并重取帧） */
  requestOffsetChange(trackId, offset) {
    const t = this._offsetTimers.get(trackId);
    if (t) clearTimeout(t);
    try {
      this.timeline.setOffset(trackId, Number(offset) || 0);
      this.emit();
    } catch { /* 中间态非法值忽略 */ }
    this._offsetTimers.set(trackId, setTimeout(() => {
      this._offsetTimers.delete(trackId);
      this.extractor.bumpTrack(trackId);
      this.refreshStaleFrames();
    }, OFFSET_DEBOUNCE_MS));
  }

  commitOffset(trackId, offset) {
    const t = this._offsetTimers.get(trackId);
    if (t) { clearTimeout(t); this._offsetTimers.delete(trackId); }
    this.timeline.setOffset(trackId, Number(offset) || 0);
    this.extractor.bumpTrack(trackId);
    this.emit();
    this.refreshStaleFrames();
  }

  // ---------- 分镜点 ----------

  addPointAtProjectTime(t) {
    const res = this.timeline.addPoint(t);
    this.emit();
    if (res.ok) this.ensurePointFrame(res.point);
    return res;
  }

  addUniform(n) {
    const res = this.timeline.addPointsUniform(n);
    this.emit();
    if (res.ok) this.refreshStaleFrames();
    return res;
  }

  removePoint(id) {
    const p = this.timeline.points.find((x) => x.id === id);
    if (p) {
      this.extractor.cancelPoint(id);
      if (p.frameURL) URL.revokeObjectURL(p.frameURL);
    }
    this.timeline.removePoint(id);
    this.emit();
  }

  clearPoints() {
    this.extractor.cancelAll();
    for (const p of this.timeline.points) if (p.frameURL) URL.revokeObjectURL(p.frameURL);
    this.timeline.clearPoints();
    this.emit();
  }

  // ---------- 取帧 ----------

  /**
   * 为分镜点取帧。同一点同一版本（摘要+源时间）的并发调用合并为
   * 一个在途任务；版本不同（编辑已重解析）则另起新任务，旧任务
   * 的迟到结果由 _isCurrentPoint 的键比对挡下。
   */
  ensurePointFrame(point) {
    const track = this.timeline.getTrack(point.trackId);
    const entry = this.files.get(point.trackId);
    if (!track || !entry) return Promise.resolve();

    const key = frameKeyFor(entry.digest.hex, point.sourceTime);
    const existing = this._inflight.get(point.id);
    if (existing && existing.key === key) return existing.promise;

    const promise = this._capturePointFrame(point, key, entry).finally(() => {
      if (this._inflight.get(point.id)?.promise === promise) this._inflight.delete(point.id);
    });
    this._inflight.set(point.id, { key, promise });
    return promise;
  }

  async _capturePointFrame(point, key, entry) {
    // 本次取帧绑定的“已确认版本”：摘要+源时间。任何偏移/替换都会
    // 被 _recomputePoints 同步反映到 point.frameKey，据此识别过期回调。
    point.frameKey = key;
    point.frameStatus = 'loading';
    this.emit();

    // 1) 先查本地缓存：内容相同（摘要一致）+ 同一源时间才命中
    try {
      const cached = await this.cache.get(key);
      if (cached && this._isCurrentPoint(point, key)) {
        this._adoptFrame(point, cached, true);
        return;
      }
    } catch {
      /* 缓存读取失败 -> 直接走提取，绝不影响清单 */
    }

    // 等待缓存期间数据已被编辑（偏移/替换/删点）：本次请求作废，
    // 由新的属主（refreshStaleFrames / 新的 ensurePointFrame）重新取帧。
    // 不拦截的话，旧键的缓存未命中会把提取请求发到混合状态上。
    if (!this._isCurrentPoint(point, key)) return;

    // 2) 实时提取（竞争安全由 extractor 保证）
    const res = await this.extractor.capture(point.id, {
      trackId: point.trackId,
      url: entry.url,
      sourceTime: point.sourceTime,
    });

    if (res.status === 'stale' || !this._isCurrentPoint(point, key)) return;
    if (res.status === 'error') {
      point.frameStatus = 'error';
      this.emit();
      return;
    }
    this._adoptFrame(point, res.blob, false);

    // 3) 回填缓存（键与帧同属一版）；配额失败内部已吞掉
    this.cache.put(key, res.blob).catch(() => {});
  }

  /** 点仍存活、仍在取帧中、且确认版本（frameKey）与本次请求一致 */
  _isCurrentPoint(point, key = null) {
    const live = this.timeline.points.find((p) => p.id === point.id);
    return live === point
      && live.frameStatus === 'loading'
      && (key === null || live.frameKey === key);
  }

  _adoptFrame(point, blob, fromCache) {
    if (point.frameURL) URL.revokeObjectURL(point.frameURL);
    point.frame = blob;
    point.frameURL = URL.createObjectURL(blob);
    point.frameFromCache = fromCache;
    point.frameStatus = 'ok';
    this.emit();
  }

  /**
   * 让所有非 ok 的分镜点完成一次取帧尝试，并等待全部在途任务结束。
   * 等待期间被编辑再次作旧的点会补取，最多 4 轮——连续编辑不允许
   * 无限阻塞导出：超出的点以缺帧标注进入导出，仍属同一版已确认数据。
   */
  async refreshStaleFrames() {
    for (let round = 0; round < 4; round += 1) {
      const need = this.timeline.confirmedSnapshot().filter((p) => {
        if (p.frameStatus === 'ok' || p.frameStatus === 'loading') return false;
        // 首轮含 error（显式重试）；后续轮只补“等待期间被作旧”的点，
        // 持续失败的点不反复重试，保证导出能终止。
        return round === 0 || p.frameStatus !== 'error';
      });
      const started = need.map((p) => this.ensurePointFrame(p));
      const pending = [...new Set([...this._inflight.values()].map((x) => x.promise))];
      if (!started.length && !pending.length) return;
      await Promise.all([...started, ...pending]);
    }
  }

  // ---------- 播放 ----------

  /** 点击分镜定位播放：返回播放器需要的 {url, projectTime, sourceTime} */
  locatePlayback(point) {
    const snap = this.timeline.confirmedSnapshot();
    const p = snap.find((x) => x.id === point.id) ?? point;
    const entry = this.files.get(p.trackId);
    if (!entry) return null;
    this.playFile = { trackId: p.trackId, url: entry.url };
    return { url: entry.url, projectTime: p.projectTime, sourceTime: p.sourceTime, point: p };
  }

  // ---------- 导出（三者同一组已确认时间点） ----------

  /**
   * 冻结当前已确认分镜点：PNG 与 JSON 共用这次快照与同一 tracks 视图。
   * “冻结”的是成员、顺序与全部展示数据：每个点被拷贝为不可变记录
   * （帧 Blob 本身不可变，安全共享引用）。导出是异步的（逐格解码 +
   * toBlob），期间发生的偏移调整、文件替换、在途取帧完成都只作用于
   * 实时实例，绝不会再改变本次导出的任何一格/任何一行——
   * 接触表格子数/顺序/编号 = 清单 points[].index，且两者内容同版。
   */
  freezeSnapshot() {
    const snapshot = this.timeline.confirmedSnapshot().map((p) => Object.freeze({
      id: p.id,
      projectTime: p.projectTime,
      trackId: p.trackId,
      sourceTime: p.sourceTime,
      frameStatus: p.frameStatus,
      frame: p.frame ?? null,        // Blob 不可变
      frameKey: p.frameKey ?? null,
      frameFromCache: !!p.frameFromCache,
    }));
    const tracks = new Map(this.timeline.tracks.map((t) => [t.id, Object.freeze({
      ...t,
      digest: t.digest ? Object.freeze({ ...t.digest }) : t.digest,
    })]));
    return { snapshot, tracks };
  }

  async exportContactSheet(opts) {
    const { snapshot, tracks } = this.freezeSnapshot();
    const sheet = await buildContactSheet(snapshot, tracks, opts);
    const manifest = buildManifest(snapshot, tracks, sheet);
    return { sheet, manifest, count: snapshot.length };
  }

  buildManifestNow() {
    const { snapshot, tracks } = this.freezeSnapshot();
    return buildManifest(snapshot, tracks, null);
  }

  /** 一键：先收敛（补取缺帧 + 等在途任务结束），再用同一冻结快照产出 PNG+JSON */
  async exportAll(opts = {}) {
    await this.refreshStaleFrames();
    const { snapshot, tracks } = this.freezeSnapshot();
    const sheet = await buildContactSheet(snapshot, tracks, opts);
    const manifest = buildManifest(snapshot, tracks, sheet);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadBlob(sheet.blob, `contact-sheet-${stamp}.png`);
    downloadBlob(new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' }), `storyboard-${stamp}.json`);
    return { count: snapshot.length };
  }

  async cacheUsage() {
    return this.cache.usage();
  }

  async clearCache() {
    await this.cache.clear();
  }
}
