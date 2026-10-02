// 取帧器：所有“浏览器加载/seek 回调乱序、连续拖动、替换文件、取消”
// 竞争问题都在这里解决。页面与测试共用同一份逻辑：
//   - createMedia(): 返回类 HTMLVideoElement 的媒体（可监听
//     loadedmetadata / seeked / error，有 setSource/requestLoad/seek/draw）
//   - createCanvas(w,h): 返回 {getContext,toBlob}
// 每个分镜点在任意时刻只允许一个“在世”任务；令牌（token）在
// 每一次回调后、以及 toBlob 异步返回后都要重新校验，旧任务一律不提交帧。

const SEEK_TIMEOUT_MS = 12000;

export class FrameExtractor {
  constructor({
    createMedia,
    createCanvas,
    concurrency = 4,
    seekTimeout = SEEK_TIMEOUT_MS,
  } = {}) {
    if (typeof createMedia !== 'function') throw new Error('createMedia 必填');
    if (typeof createCanvas !== 'function') throw new Error('createCanvas 必填');
    this.createMedia = createMedia;
    this.createCanvas = createCanvas;
    this.concurrency = concurrency;
    this.seekTimeout = seekTimeout;

    this._current = new Map();    // pointId -> token（最新任务）
    this._trackGen = new Map();   // trackId -> 换代计数（替换/删除文件时 +1）
    this._gen = 0;                // 全局换代（cancelAll）
    this._seq = 0;
    this._queue = [];
    this._running = 0;
  }

  _trackEpoch(trackId) {
    return this._trackGen.get(trackId) ?? 0;
  }

  /** 替换文件或删除轨道：该轨所有在途任务立即失效（旧帧不得占据新分镜） */
  bumpTrack(trackId) {
    this._trackGen.set(trackId, this._trackEpoch(trackId) + 1);
    for (const [pid, token] of this._current) {
      if (token.trackId === trackId) this._current.delete(pid);
    }
    this._invalidateQueue((j) => j.token.trackId === trackId);
  }

  /** 全部取消：在途与排队任务全部失效 */
  cancelAll() {
    this._gen += 1;
    this._current.clear();
    this._invalidateQueue(() => true);
  }

  /** 取消单个分镜点的在途任务（连续拖动时旧的一帧） */
  cancelPoint(pointId) {
    this._current.delete(pointId);
    this._invalidateQueue((j) => j.token.pointId === pointId);
  }

  _invalidateQueue(pred) {
    const keep = [];
    for (const job of this._queue) {
      if (pred(job)) job.resolve({ status: 'stale' });
      else keep.push(job);
    }
    this._queue = keep;
  }

  isLive(token) {
    return !!token
      && this._current.get(token.pointId) === token
      && token.gen === this._gen
      && token.tgen === this._trackEpoch(token.trackId);
  }

  /**
   * 请求为某分镜点取帧。同一点的新请求会自动作废旧请求。
   * 兑现：{status:'ok', blob} | {status:'stale'} | {status:'error', error}
   */
  capture(pointId, { trackId, url, sourceTime, width = 320 }) {
    const token = {
      pointId, trackId, url,
      t: sourceTime,
      width,
      seq: (this._seq += 1),
      gen: this._gen,
      tgen: this._trackEpoch(trackId),
    };
    this._current.set(pointId, token);

    return new Promise((resolve) => {
      const job = { token, resolve, started: false };
      this._queue.push(job);
      this._pump();
    });
  }

  _pump() {
    while (this._running < this.concurrency && this._queue.length) {
      const job = this._queue.shift();
      if (!this.isLive(job.token)) {
        job.resolve({ status: 'stale' });
        continue; // eslint-disable-line no-continue
      }
      this._running += 1;
      this._run(job).finally(() => {
        this._running -= 1;
        this._pump();
      });
    }
  }

  /** 排队任务中已有换代任务/已取消的直接丢掉，不占媒体槽位 */
  _drainQueue() {
    const live = this._queue.filter((j) => this.isLive(j.token));
    this._queue.length = 0;
    this._queue.push(...live);
  }

  async _run(job) {
    const { token, resolve } = job;
    const media = this.createMedia();
    let timer = null;
    let settled = false;

    const arm = (msg) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        if (!this.isLive(token)) { stale(); return; }
        finish({ status: 'error', error: new Error(msg) });
      }, this.seekTimeout);
    };

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      media.removeEventListener('loadedmetadata', onMeta);
      media.removeEventListener('seeked', onSeeked);
      media.removeEventListener('error', onError);
      try { media.destroy?.(); } catch { /* ignore */ }
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const stale = () => finish({ status: 'stale' });

    const onError = () => {
      if (!this.isLive(token)) { stale(); return; }
      finish({ status: 'error', error: new Error(`媒体错误 (${media.error?.code ?? '?'})`) });
    };

    const onMeta = () => {
      // 回调可能属于已经被拖动/替换/取消作废旧的请求
      if (!this.isLive(token)) { stale(); return; }
      arm('seek 超时');
      try {
        media.seek(token.t);
      } catch (err) {
        finish({ status: 'error', error: err });
      }
    };

    const onSeeked = async () => {
      if (!this.isLive(token)) { stale(); return; }
      if (timer) clearTimeout(timer);

      // Seek 精度保护：某些容器/编码器下浏览器会落到更旧的关键帧
      // （currentTime 明显早于请求时间）。向目标方向轻推重试，至多 2 次。
      const SEEK_EPS = 0.06;
      if (media.currentTime !== undefined && token._retries === undefined) token._retries = 0;
      if (media.currentTime !== undefined
        && media.currentTime < token.t - SEEK_EPS
        && token._retries < 2
        && typeof media.seekAccurate === 'function') {
        token._retries += 1;
        arm('seek 超时');
        media.seekAccurate(token.t);
        return;
      }

      try {
        const vw = media.videoWidth || 320;
        const vh = media.videoHeight || 180;
        const h = Math.max(1, Math.round((token.width * vh) / vw));
        const canvas = this.createCanvas(token.width, h);
        const ctx = canvas.getContext('2d');
        media.draw(ctx, token.width, h);

        arm('toBlob 超时');
        const blob = await canvasToBlob(canvas);
        // 关键：toBlob 是异步的，返回时必须再次确认任务仍在世，
        // 否则这张旧帧绝不能提交给新分镜。
        if (!this.isLive(token)) { stale(); return; }
        if (!blob) { finish({ status: 'error', error: new Error('toBlob 返回空') }); return; }
        finish({ status: 'ok', blob, width: token.width, height: h });
      } catch (err) {
        if (!this.isLive(token)) { stale(); return; }
        finish({ status: 'error', error: err });
      }
    };

    media.addEventListener('loadedmetadata', onMeta);
    media.addEventListener('seeked', onSeeked);
    media.addEventListener('error', onError);

    try {
      media.setSource(token.url);
      media.requestLoad?.();
      arm('加载元数据超时');
    } catch (err) {
      finish({ status: 'error', error: err });
    }
  }
}

function canvasToBlob(canvas) {
  return new Promise((resolve) => {
    if (typeof canvas.convertToBlob === 'function') {
      canvas.convertToBlob({ type: 'image/png' }).then(resolve, () => resolve(null));
      return;
    }
    canvas.toBlob((b) => resolve(b), 'image/png');
  });
}
