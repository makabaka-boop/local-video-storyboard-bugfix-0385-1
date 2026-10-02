// 纯逻辑：多轨统一时间轴 + 分镜点。
// 所有时间单位均为秒；分镜点以“项目时间 projectTime”为准，
// 播放/接触表/清单都从同一份有序快照取点（见 confirmedSnapshot）。

export const MAX_POINTS = 30;
const EPS = 1e-6;

let pidSeq = 0;
export function createPointId() {
  pidSeq += 1;
  return `pt_${Date.now().toString(36)}_${pidSeq}`;
}

let tidSeq = 0;
export function createTrackId() {
  tidSeq += 1;
  return `tr_${Date.now().toString(36)}_${tidSeq}`;
}

export class TimelineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export class Timeline {
  constructor() {
    /** @type {Track[]} 插入顺序即重叠时的优先级顺序 */
    this.tracks = [];
    /** @type {Point[]} 始终按 projectTime 升序 */
    this.points = [];
  }

  addTrack({ id = createTrackId(), file, name, digest, duration, width, height, offset = 0 }) {
    if (!Number.isFinite(duration) || duration <= 0) {
      throw new TimelineError('BAD_DURATION', `无效的视频时长: ${duration}`);
    }
    const track = {
      id, file: file ?? null, name: name ?? '未命名',
      digest: digest ?? null, duration,
      width: width ?? 0, height: height ?? 0,
      offset: Number(offset) || 0,
    };
    this.tracks.push(track);
    this._recomputePoints();
    return track;
  }

  replaceTrack(id, patch) {
    const track = this.tracks.find((t) => t.id === id);
    if (!track) throw new TimelineError('NO_TRACK', `轨道不存在: ${id}`);
    if (patch.duration !== undefined && (!(Number.isFinite(patch.duration)) || patch.duration <= 0)) {
      throw new TimelineError('BAD_DURATION', '替换文件的时长无效');
    }
    Object.assign(track, {
      file: patch.file ?? track.file,
      name: patch.name ?? track.name,
      digest: patch.digest ?? track.digest,
      duration: patch.duration ?? track.duration,
      width: patch.width ?? track.width,
      height: patch.height ?? track.height,
    });
    // 替换文件后，即使源时间恰好相同，该轨所有已取帧也必须作废重取
    //（旧文件的内容不得占据新分镜）。
    for (const p of this.points) {
      if (p.trackId === id) {
        p.frame = null;
        p.frameURL = null;
        p.frameFromCache = false;
        p.frameStatus = 'stale';
      }
    }
    this._recomputePoints();
    return track;
  }

  setOffset(id, offset) {
    const track = this.tracks.find((t) => t.id === id);
    if (!track) throw new TimelineError('NO_TRACK', `轨道不存在: ${id}`);
    offset = Number(offset);
    if (!Number.isFinite(offset) || offset < 0) {
      throw new TimelineError('BAD_OFFSET', `无效偏移: ${offset}`);
    }
    if (Math.abs(track.offset - offset) < EPS) return track;
    track.offset = offset;
    this._recomputePoints();
    return track;
  }

  removeTrack(id) {
    const i = this.tracks.findIndex((t) => t.id === id);
    if (i < 0) return;
    this.tracks.splice(i, 1);
    // 被删轨道的分镜点无意义，直接移除（释放配额），
    // 其余点重新解析（可能因覆盖关系换到别的轨道）。
    this.points = this.points.filter((p) => p.trackId !== id);
    this._recomputePoints();
  }

  getTrack(id) {
    return this.tracks.find((t) => t.id === id) ?? null;
  }

  /** 项目总时长：所有轨道覆盖范围的右端点 */
  projectDuration() {
    return this.tracks.reduce((m, t) => Math.max(m, t.offset + t.duration), 0);
  }

  /**
   * 项目时间 -> {track, sourceTime}；落在空隙返回 null。
   * 多轨重叠时取插入顺序最早的轨道（确定且可解释）。
   */
  resolve(projectTime) {
    for (const track of this.tracks) {
      const s = projectTime - track.offset;
      if (s >= -EPS && s <= track.duration + EPS) {
        return { track, sourceTime: Math.min(Math.max(s, 0), track.duration) };
      }
    }
    return null;
  }

  /** 空隙时间吸附到最近的被覆盖时间；完全没有轨道时返回 null */
  nearestCovered(projectTime) {
    let best = null;
    for (const track of this.tracks) {
      const start = track.offset;
      const end = track.offset + track.duration;
      const c = Math.min(Math.max(projectTime, start), end);
      if (best === null || Math.abs(c - projectTime) < Math.abs(best - projectTime)) best = c;
    }
    return best;
  }

  /**
   * 新增分镜点。projectTime 落在空隙会自动吸附；
   * 同一轨道、同一毫秒桶的点视为重复。
   * 返回 {ok, point?, error?}
   */
  addPoint(projectTime) {
    if (this.points.length >= MAX_POINTS) {
      return { ok: false, error: `分镜点数量上限 ${MAX_POINTS} 个` };
    }
    if (!Number.isFinite(projectTime) || projectTime < 0) {
      return { ok: false, error: `无效的时间: ${projectTime}` };
    }
    let r = this.resolve(projectTime);
    if (!r) {
      const snapped = this.nearestCovered(projectTime);
      if (snapped === null) return { ok: false, error: '尚未导入任何视频' };
      projectTime = snapped;
      r = this.resolve(projectTime);
    }
    const ms = Math.round(projectTime * 1000);
    if (this.points.some((p) => p.trackId === r.track.id && Math.round(p.projectTime * 1000) === ms)) {
      return { ok: false, error: '该时刻已存在分镜点' };
    }
    // 存储时归一化到毫秒桶，保证 0.1004/0.1006 这类浮点抖动与显示值一致
    projectTime = ms / 1000;
    r = this.resolve(projectTime);
    const point = {
      id: createPointId(),
      projectTime,
      trackId: r.track.id,
      sourceTime: Math.round(r.sourceTime * 1000) / 1000,
      // 帧状态：idle | loading | ok | stale | error
      frameStatus: 'idle',
      frame: null,           // Blob
      frameURL: null,        // 展示用 objectURL
      frameKey: null,        // 缓存键（digest+源时间）
      frameFromCache: false,
    };
    this.points.push(point);
    this.points.sort((a, b) => a.projectTime - b.projectTime);
    return { ok: true, point };
  }

  /** 在整条项目时间轴上均匀放置 n 个点（空隙自动吸附、去重） */
  addPointsUniform(n) {
    n = Math.min(MAX_POINTS, Math.max(1, Math.floor(n)));
    const D = this.projectDuration();
    if (D <= 0) return { ok: false, error: '尚未导入任何视频', added: 0 };
    const added = [];
    for (let i = 0; i < n; i += 1) {
      if (this.points.length >= MAX_POINTS) break;
      const t = ((i + 0.5) * D) / n;
      const res = this.addPoint(t);
      if (res.ok) added.push(res.point);
    }
    return { ok: added.length > 0, added, error: added.length ? null : '所有候选时刻都重复或无覆盖' };
  }

  removePoint(id) {
    const i = this.points.findIndex((p) => p.id === id);
    if (i >= 0) this.points.splice(i, 1);
  }

  clearPoints() {
    this.points.length = 0;
  }

  /**
   * 轨道偏移/替换/删除后重新解析每个点。
   * 解析结果变化（换轨或源时间变化）的点立即丢弃旧帧并标记 stale：
   * 旧内容不允许继续占据新分镜，等待上层重新取帧。
   */
  _recomputePoints() {
    for (const p of this.points) {
      const r = this.resolve(p.projectTime);
      if (!r) {
        this._invalidate(p, null);
        continue;
      }
      const key = r.track.digest ? frameKeyFor(r.track.digest, r.sourceTime) : null;
      if (p.trackId !== r.track.id || Math.abs((p.sourceTime ?? NaN) - r.sourceTime) > EPS) {
        p.trackId = r.track.id;
        p.sourceTime = r.sourceTime;
        p.frameKey = key;
        this._invalidate(p, 'stale');
      } else {
        p.sourceTime = r.sourceTime;
        p.frameKey = key;
      }
    }
  }

  _invalidate(point, status) {
    point.frame = null;
    point.frameURL = null;
    point.frameFromCache = false;
    point.frameStatus = status ?? 'idle';
  }

  /**
   * 已确认分镜点的唯一有序快照。
   * 点击播放、PNG 接触表、JSON 清单三者只能使用本方法返回的同一组点。
   */
  confirmedSnapshot() {
    return [...this.points]
      .filter((p) => this.getTrack(p.trackId))
      .sort((a, b) => a.projectTime - b.projectTime);
  }
}

/** 缩略帧缓存键：仅取决于文件摘要与源时间（与项目偏移无关） */
export function frameKeyFor(digest, sourceTime) {
  const ms = Math.max(0, Math.round(sourceTime * 1000));
  return `sha256:${digest}/t${ms}`;
}
