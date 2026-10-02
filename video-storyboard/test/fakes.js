// 可控媒体假件：精确控制 loadedmetadata / seeked / error 回调的时机与次序。
// 两种模式：
//   auto（默认）：事件按 delay 排序后在微任务批次中派发，
//                 不同媒体的 delay 不同即可制造乱序；
//   manual：事件进 pending 队列，由测试逐个 tick/flush，可任意交错。
// 页面中的“竞争测试”标签页与 Node 单元测试共用本文件（纯 ESM，无 DOM 依赖）。

let mediaSeq = 0;
let blobSeq = 0;

const microtasks = (n = 1) => {
  let p = Promise.resolve();
  for (let i = 0; i < n; i += 1) p = p.then(() => {});
  return p;
};

export class FakeMedia {
  constructor(env, opts = {}) {
    this.env = env;
    this.id = `m${(mediaSeq += 1)}`;
    this.listeners = new Map();
    this.url = null;
    this.videoWidth = opts.videoWidth ?? 160;
    this.videoHeight = opts.videoHeight ?? 90;
    this.currentTime = 0;
    this.error = null;
    this.destroyed = false;
    this.loadDelay = opts.loadDelay ?? 1;
    this.seekDelay = opts.seekDelay ?? 1;
    this.drawn = []; // {time,w,h}
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(fn);
  }

  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  /** 由 env 在受控时机调用 */
  fire(type, payload) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) {
      fn(payload ?? { target: this, type });
    }
  }

  setSource(url) { this.url = url; }

  requestLoad() {
    this.env.push(this, 'loadedmetadata', this.loadDelay, { media: this });
  }

  seek(t) {
    this.currentTime = t;
    this.env.push(this, 'seeked', this.seekDelay, { media: this, time: t });
  }

  failLoad(code = 4) {
    this.error = { code };
    this.env.push(this, 'error', this.loadDelay, { media: this });
  }

  draw(ctx, w, h) {
    this.drawn.push({ time: this.currentTime, w, h });
    // 在画布上写“身份标记”，测试可据此判定提交的是哪一次/哪个时间的帧
    ctx.drawFake(this.id, this.currentTime, this.url, w, h);
  }

  destroy() { this.destroyed = true; }
}

export class FakeEnv {
  constructor({ auto = true } = {}) {
    this.auto = auto;
    /** @type {{media?,type?,delay,payload,seq,at,_run?}[]} */
    this.pending = [];
    this.now = 0;
    this.seq = 0;
    this._kicking = false;
  }

  asMicrotask(fn) {
    if (typeof queueMicrotask === 'function') queueMicrotask(fn);
    else Promise.resolve().then(fn);
  }

  push(media, type, delay, payload) {
    this.now += 1;
    this.pending.push({ media, type, delay, payload, at: this.now + Math.max(0, delay), seq: this.seq++ });
    if (this.auto) this._kick();
  }

  _kick() {
    if (this._kicking) return;
    this._kicking = true;
    this.asMicrotask(() => {
      this._kicking = false;
      if (!this.pending.length) return;
      const batch = this.pending.splice(0);
      // delay 越小越早；同 delay 保持入队 FIFO。
      batch.sort((a, b) => (a.delay - b.delay) || (a.seq - b.seq));
      for (const e of batch) this.dispatch(e);
      if (this.pending.length) this._kick();
    });
  }

  dispatch(e) {
    if (e._run) { e._run(); return; }
    if (e.media.destroyed) return;
    e.media.fire(e.type, e.payload);
  }

  // ---- manual 控制 API ----

  /** 派发第一个匹配的待发事件，返回该事件（无匹配返回 null） */
  tick(filter = null) {
    const idx = this.pending.findIndex((e) => (!filter
      || ((!filter.type || e.type === filter.type) && (!filter.media || e.media === filter.media))));
    if (idx < 0) return null;
    const [e] = this.pending.splice(idx, 1);
    this.dispatch(e);
    return e;
  }

  /** 派发匹配事件；回调中新入队的匹配事件也会一并处理，直到没有匹配项 */
  flush(filter = null) {
    const picked = [];
    let guard = 0;
    for (;;) {
      let progressed = false;
      for (let i = 0; i < this.pending.length; i += 1) {
        const e = this.pending[i];
        const match = !filter || ((!filter.type || e.type === filter.type) && (!filter.media || e.media === filter.media));
        if (match) {
          this.pending.splice(i, 1);
          picked.push(e);
          this.dispatch(e);
          progressed = true;
          i -= 1;
        }
      }
      if (!progressed || (guard += 1) > 1000) break;
    }
    return picked;
  }

  pendingOf(type) {
    return type ? this.pending.filter((e) => e.type === type) : [...this.pending];
  }

  /**
   * manual 模式：循环派发直到队列清空。
   * 必须是 async：取帧器在 Promise 微任务（.finally/_pump、toBlob）中
   * 才会启动排队任务、创建新媒体并入队新事件，同步 flush 看不到这些事件。
   */
  async drain(filter = null) {
    for (let guard = 0; guard < 1000; guard += 1) {
      if (!this.pending.length) {
        // 多排空转两轮微任务，给 _pump/toBlob 链充分时间，仍无新事件才算结束
        await microtasks(2);
        if (!this.pending.length) return;
        continue;
      }
      // 一次只派发一个事件，随后排空微任务：精确模拟“一个回调 + 其后续”
      const idx = filter
        ? this.pending.findIndex((e) => (!filter.type || e.type === filter.type) && (!filter.media || e.media === filter.media))
        : 0;
      if (idx < 0) {
        if (!filter) return;
        await microtasks(1);
        if (!this.pending.some((e) => (!filter.type || e.type === filter.type) && (!filter.media || e.media === filter.media))) return;
        continue;
      }
      const [e] = this.pending.splice(idx, 1);
      this.dispatch(e);
      await microtasks(4);
    }
  }
}

/**
 * 假画布：drawFake 记录帧身份，toBlob 异步返回带标记的“PNG”。
 * toBlobDelay 可调，方便制造“旧任务的 toBlob 晚于新任务 seeked”的交错。
 */
export class FakeCanvas {
  constructor(w, h) {
    this.width = w;
    this.height = h;
    this.marks = [];
  }

  getContext() {
    return {
      drawFake: (mediaId, time, url, w, h) => {
        this.marks.push({ mediaId, time, url, w, h });
      },
    };
  }

  toBlob(cb) {
    const run = () => cb(makeFakePngBlob(this.width, this.height, this.marks[0] ?? null));
    const delay = FakeCanvas.toBlobDelay ?? 0;
    if (delay > 0 && typeof setTimeout === 'function') setTimeout(run, delay);
    else if (typeof queueMicrotask === 'function') queueMicrotask(run);
    else Promise.resolve().then(run);
  }
}
FakeCanvas.toBlobDelay = 0;

export function makeFakePngBlob(w, h, mark) {
  const blob = new Blob([`PNGFAKE\n${JSON.stringify({ w, h, mark })}`], { type: 'image/png' });
  Object.defineProperty(blob, '__mark', { value: mark });
  Object.defineProperty(blob, '__seq', { value: (blobSeq += 1) });
  return blob;
}

export function makeHarness({ auto = true, seekTimeout = 50, mediaOpts } = {}) {
  const env = new FakeEnv({ auto });
  const created = [];
  const createMedia = (opts) => {
    const m = new FakeMedia(env, { ...mediaOpts, ...opts });
    created.push(m);
    return m;
  };
  const createCanvas = (w, h) => new FakeCanvas(w, h);
  const makeExtractor = (overrides = {}) => new (extractorCtor())({
    createMedia, createCanvas, seekTimeout, ...overrides,
  });
  return { env, createMedia, createCanvas, created, makeExtractor };
}

// 避免在 fakes 顶层 import extractor（页面直接 import 时更简单）；
// 由调用方传入或使用全局。
function extractorCtor() {
  if (globalThis.__FrameExtractor) return globalThis.__FrameExtractor;
  throw new Error('使用 makeExtractor 前请设置 globalThis.__FrameExtractor');
}
