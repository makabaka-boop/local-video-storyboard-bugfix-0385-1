// 页面渲染层：只处理 DOM/事件；所有规则在 src/ 模块中。
import { App } from './app.js';
import { MAX_POINTS, frameKeyFor } from './timeline.js';
import { FrameExtractor } from './extractor.js';
import { formatTime } from './exports.js';
import { makeHarness, FakeCanvas } from '../test/fakes.js';

const $ = (sel) => document.querySelector(sel);
const app = new App();
globalThis.__app = app; // E2E 测试钩子

const player = $('#player');
const grid = $('#pointGrid');
const trackList = $('#trackList');
const ruler = $('#ruler');
const rulerMeta = $('#rulerMeta');
const pointStatus = $('#pointStatus');
const playerHint = $('#playerHint');
$('#maxN').textContent = String(MAX_POINTS);

// ---------------- toast ----------------

let toastTimer = null;
function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = isErr ? 'toast err' : 'toast';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------------- 渲染 ----------------

app.onDirty = render;

function render() {
  renderTracks();
  renderRuler();
  renderPoints();
  renderStatus();
  refreshCacheInfo();
}

function renderTracks() {
  const tracks = app.tracks();
  if (!tracks.length) {
    trackList.innerHTML = '<p class="hint">尚未导入视频。每个轨道可设置相对项目时间起点的偏移（秒）。</p>';
    return;
  }
  trackList.innerHTML = '';
  tracks.forEach((t, i) => {
    const entry = app.files.get(t.id);
    const card = document.createElement('div');
    card.className = 'track-card';
    card.innerHTML = `
      <div class="name">#${i + 1} ${escapeHtml(t.name)}</div>
      <div class="meta">${formatTime(t.duration)} · ${t.width || '?'}×${t.height || '?'}</div>
      <div class="digest" title="${t.digest?.algo}:${t.digest?.hex}">${t.digest?.algo}:${(t.digest?.hex ?? '').slice(0, 24)}…</div>
      <div class="row" style="margin-top:8px">
        <span>项目偏移(s)</span>
        <input type="number" min="0" step="0.1" value="${t.offset}" data-role="offset" data-id="${t.id}" />
      </div>
      <div class="row" style="margin-top:8px">
        <label class="btn small">替换文件<input type="file" accept="video/*" hidden data-role="replace" data-id="${t.id}" /></label>
        <button class="btn small danger" data-role="remove" data-id="${t.id}">删除轨道</button>
      </div>
      <div class="meta" style="margin-top:6px">缓存键前缀：${entry ? frameKeyFor(entry.digest.hex, 0).replace(/t0$/, 't{源时间ms}') : ''}</div>
    `;
    trackList.appendChild(card);
  });

  trackList.querySelectorAll('[data-role="offset"]').forEach((inp) => {
    const id = inp.dataset.id;
    inp.addEventListener('input', () => app.requestOffsetChange(id, inp.value));
    inp.addEventListener('change', () => app.commitOffset(id, inp.value));
  });
  trackList.querySelectorAll('[data-role="replace"]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const f = inp.files?.[0];
      if (!f) return;
      toast('正在替换文件并使旧帧失效…');
      try {
        await app.replaceFile(inp.dataset.id, f);
        toast('已替换文件，该轨分镜帧已全部重取');
      } catch (err) { toast(err.message, true); }
    });
  });
  trackList.querySelectorAll('[data-role="remove"]').forEach((btn) => {
    btn.addEventListener('click', () => app.removeTrack(btn.dataset.id));
  });
}

function renderStatus() {
  const n = app.points().length;
  const loading = app.points().filter((p) => p.frameStatus === 'loading').length;
  const ok = app.points().filter((p) => p.frameStatus === 'ok').length;
  const err = app.points().filter((p) => p.frameStatus === 'error').length;
  pointStatus.textContent = `共 ${n}/${MAX_POINTS} 个分镜点 · 帧：${ok} 就绪${loading ? ` · ${loading} 取帧中` : ''}${err ? ` · ${err} 失败` : ''}`;
  rulerMeta.textContent = app.tracks().length
    ? `项目总时长 ${formatTime(app.timeline.projectDuration())}（多轨重叠处取最先导入的轨道；点击标尺在该项目时间添加分镜点）`
    : '';
}

function renderPoints() {
  const snap = app.timeline.confirmedSnapshot();
  grid.innerHTML = '';
  snap.forEach((p, i) => {
    const track = app.timeline.getTrack(p.trackId);
    const card = document.createElement('div');
    card.className = 'point-card';
    card.dataset.pid = p.id;

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.title = '点击定位播放';
    if (p.frameURL && p.frameStatus === 'ok') {
      const img = document.createElement('img');
      img.src = p.frameURL;
      thumb.appendChild(img);
    } else {
      const ov = document.createElement('div');
      ov.className = 'status-overlay' + (p.frameStatus === 'error' ? ' err' : '');
      ov.textContent = p.frameStatus === 'loading' ? '取帧中…（旧帧已作废）'
        : p.frameStatus === 'error' ? '取帧失败（点击重试）' : '缺帧（点击重试）';
      thumb.appendChild(ov);
      thumb.addEventListener('click', () => app.ensurePointFrame(p));
    }
    thumb.insertAdjacentHTML('beforeend', `<span class="badge">#${String(i + 1).padStart(2, '0')} · ${formatTime(p.projectTime)}</span>`);
    if (p.frameFromCache) thumb.insertAdjacentHTML('beforeend', '<span class="fromcache">缓存</span>');
    thumb.addEventListener('click', (ev) => {
      if (ev.target.classList.contains('status-overlay')) return;
      playAt(p, card);
    });

    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `<div class="t">项目 ${formatTime(p.projectTime)}</div>
      <div class="src">${escapeHtml(track?.name ?? '?')} · 源 ${formatTime(p.sourceTime)}</div>`;

    const foot = document.createElement('div');
    foot.className = 'foot';
    const retry = document.createElement('button');
    retry.textContent = '重取帧';
    retry.style.color = 'var(--accent)';
    retry.addEventListener('click', () => app.ensurePointFrame(p));
    const del = document.createElement('button');
    del.textContent = '删除点';
    del.addEventListener('click', () => app.removePoint(p.id));
    foot.append(retry, del);

    card.append(thumb, info, foot);
    grid.appendChild(card);
  });
}

function playAt(point, card) {
  const loc = app.locatePlayback(point);
  if (!loc) { toast('该分镜点对应的轨道已不存在', true); return; }
  if (player.dataset.url !== loc.url) {
    player.src = loc.url;
    player.dataset.url = loc.url;
  }
  player.currentTime = loc.sourceTime;
  playerHint.textContent = `#${app.timeline.confirmedSnapshot().indexOf(loc.point) + 1} 项目 ${formatTime(loc.projectTime)} → 源 ${formatTime(loc.sourceTime)}`;
  const pr = player.play();
  if (pr && pr.catch) pr.catch(() => { /* 自动播放被拦截时停在目标帧 */ });
  document.querySelectorAll('.point-card.active').forEach((c) => c.classList.remove('active'));
  card?.classList.add('active');
}

// ---------------- 时间轴标尺 ----------------

const TRACK_COLORS = ['#4f9cff', '#3fb96b', '#e0a13c', '#b977ff'];

function renderRuler() {
  const dpr = window.devicePixelRatio || 1;
  const cssW = ruler.clientWidth || 800;
  ruler.width = cssW * dpr;
  ruler.height = 150 * dpr;
  ruler.style.height = '150px';
  const ctx = ruler.getContext('2d');
  ctx.scale(dpr, dpr);
  const W = cssW, H = 150;
  ctx.fillStyle = '#0a0d11';
  ctx.fillRect(0, 0, W, H);

  const tracks = app.tracks();
  const D = Math.max(app.timeline.projectDuration(), 1);
  const padL = 8, padR = 8;
  const xOf = (t) => padL + (t / D) * (W - padL - padR);
  const laneH = 22, laneGap = 4, top0 = 30;

  // 网格
  ctx.strokeStyle = '#1d242d'; ctx.fillStyle = '#7e8a99'; ctx.font = '10px monospace';
  const step = niceStep(D);
  for (let t = 0; t <= D + 1e-6; t += step) {
    const x = xOf(t);
    ctx.beginPath(); ctx.moveTo(x, 24); ctx.lineTo(x, H - 22); ctx.stroke();
    ctx.fillText(formatTime(t), x + 2, 14);
  }

  tracks.forEach((t, i) => {
    const y = top0 + i * (laneH + laneGap);
    const x = xOf(t.offset);
    const w = Math.max(2, xOf(t.offset + t.duration) - x);
    ctx.fillStyle = TRACK_COLORS[i % TRACK_COLORS.length] + '55';
    ctx.fillRect(x, y, w, laneH);
    ctx.strokeStyle = TRACK_COLORS[i % TRACK_COLORS.length];
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, laneH - 1);
    ctx.fillStyle = '#c8d2df'; ctx.font = '11px sans-serif';
    ctx.fillText(`#${i + 1} ${t.name.slice(0, 18)}`, x + 6, y + 15);
  });

  // 分镜点
  const snap = app.timeline.confirmedSnapshot();
  snap.forEach((p, i) => {
    const x = xOf(p.projectTime);
    const trackIdx = tracks.findIndex((t) => t.id === p.trackId);
    const y = top0 + Math.max(0, trackIdx) * (laneH + laneGap) - 6;
    ctx.fillStyle = p.frameStatus === 'ok' ? '#3fb96b' : p.frameStatus === 'error' ? '#e5534b' : '#e0a13c';
    ctx.beginPath();
    ctx.moveTo(x, y); ctx.lineTo(x - 5, y - 7); ctx.lineTo(x + 5, y - 7);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#aeb9c7'; ctx.font = '9px monospace';
    ctx.fillText(String(i + 1), x - 3, y - 9);
  });
}

function niceStep(d) {
  const target = d / 10;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  const n = target / pow;
  const f = n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10;
  return f * pow;
}

ruler.addEventListener('click', (ev) => {
  const rect = ruler.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const W = rect.width;
  const D = Math.max(app.timeline.projectDuration(), 0);
  if (!D) { toast('请先导入视频', true); return; }
  const t = (x / W) * D;
  const res = app.addPointAtProjectTime(Math.max(0, t));
  if (!res.ok) toast(res.error, true);
});

window.addEventListener('resize', renderRuler);

// ---------------- 事件 ----------------

$('#fileInput').addEventListener('change', async (ev) => {
  const files = [...ev.target.files].slice(0, 3);
  if (ev.target.files.length > 3) toast('最多 3 段，已只取前 3 个');
  if (!files.length) return;
  const errors = await app.importFiles(files);
  if (errors.length) toast(errors.join('；'), true);
  else toast(`已导入 ${files.length} 段视频，默认偏移 0，可拖动调整`);
  await app.refreshStaleFrames();
  ev.target.value = '';
});

$('#btnUniform').addEventListener('click', () => {
  const n = Math.min(MAX_POINTS, Math.max(1, Number($('#uniformN').value) || 12));
  const res = app.addUniform(n);
  if (!res.ok) toast(res.error, true);
});

$('#btnRefresh').addEventListener('click', () => app.refreshStaleFrames());

$('#btnClear').addEventListener('click', () => {
  app.clearPoints();
  player.removeAttribute('src'); player.load(); player.dataset.url = '';
});

$('#btnExport').addEventListener('click', async () => {
  if (!app.points().length) { toast('请先建立分镜点', true); return; }
  toast('正在补齐缺帧并生成 PNG 接触表 + JSON 清单（同一组已确认时间点）…');
  try {
    const { count } = await app.exportAll({ columns: 4 });
    toast(`已导出 ${count} 个分镜的 PNG 接触表与 JSON 清单`);
  } catch (err) { toast(err.message, true); }
});

$('#btnJson').addEventListener('click', () => {
  if (!app.points().length) { toast('请先建立分镜点', true); return; }
  const m = app.buildManifestNow();
  const blob = new Blob([JSON.stringify(m, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `storyboard-${new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 100);
});

let cacheInfoTimer = null;
function refreshCacheInfo() {
  clearTimeout(cacheInfoTimer);
  cacheInfoTimer = setTimeout(async () => {
    const u = await app.cacheUsage();
    $('#cacheInfo').textContent = `${u.entries} 帧 · ${(u.bytes / 1024).toFixed(1)} KiB${u.degraded ? ' · IndexedDB 不可用，已降级为内存（重开页面不保留）' : ''}`;
  }, 200);
}
$('#btnCacheRefresh').addEventListener('click', refreshCacheInfo);
$('#btnCacheClear').addEventListener('click', async () => {
  await app.clearCache();
  toast('缓存已清空（分镜清单不受影响，显示的帧会在下次重取后恢复）');
  refreshCacheInfo();
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ============================================================
// 页面内竞争测试：复用 test/fakes.js 的可控媒体/画布
// ============================================================

const raceLog = $('#raceLog');
function rlog(msg) {
  raceLog.textContent += `${new Date().toLocaleTimeString()} ${msg}\n`;
  raceLog.scrollTop = raceLog.scrollHeight;
}

function raceHarness() {
  // 让假画布的 toBlob 走微任务即可；身份标记在 blob.__mark 上
  FakeCanvas.toBlobDelay = 0;
  const h = makeHarness({ auto: false, seekTimeout: 1000 });
  return h;
}

$('#raceRapid').addEventListener('click', async () => {
  raceLog.textContent = '';
  const h = raceHarness();
  const ex = new FrameExtractor({ createMedia: h.createMedia, createCanvas: h.createCanvas, concurrency: 2, seekTimeout: 1000 });
  const results = [];
  const promises = [];
  // 模拟连续拖动：对同一个分镜点快速发起 10 次取帧（源时间不断变）
  for (let i = 1; i <= 10; i += 1) {
    promises.push(ex.capture('dragPoint', { trackId: 't1', url: `blob://seek-${i}`, sourceTime: i }).then((r) => results.push({ i, r })));
  }
  await h.env.drain();
  await Promise.all(promises);
  const oks = results.filter((x) => x.r.status === 'ok');
  const stales = results.filter((x) => x.r.status === 'stale');
  rlog(`连续拖动 10 次：${stales.length} 个旧请求 stale，${oks.length} 个成功；成功帧源时间=${oks.map((x) => x.r.blob.__mark.time).join(',')}`);
  rlog(oks.length === 1 && oks[0].r.blob.__mark.time === 10 ? '✔ 只有最后一次（源时间 10.00）提交了帧' : '[×] 异常！');
});

$('#raceReplace').addEventListener('click', async () => {
  raceLog.textContent = '';
  const h = raceHarness();
  const ex = new FrameExtractor({ createMedia: h.createMedia, createCanvas: h.createCanvas, concurrency: 4, seekTimeout: 1000 });
  const p1 = ex.capture('pA', { trackId: 't1', url: 'blob://OLD-FILE', sourceTime: 2 });
  const p2 = ex.capture('pB', { trackId: 't1', url: 'blob://OLD-FILE', sourceTime: 5 });
  rlog('两个分镜正在用旧文件取帧（回调尚未派发）…');
  ex.bumpTrack('t1');
  rlog('用户替换了文件 -> bumpTrack，旧请求全部换代');
  await h.env.drain();
  const [r1, r2] = await Promise.all([p1, p2]);
  rlog(`结果：pA=${r1.status}，pB=${r2.status}`);
  rlog(r1.status === 'stale' && r2.status === 'stale' ? '✔ 旧文件的帧一张都没有进入新分镜' : '[×] 异常！');

  // 新文件重新取帧必须成功
  const q1 = ex.capture('pA', { trackId: 't1', url: 'blob://NEW-FILE', sourceTime: 2 });
  await h.env.drain();
  const nr = await q1;
  rlog(`新文件重取 pA：${nr.status}，帧来自 ${nr.blob?.__mark?.url}`);
  rlog(nr.status === 'ok' && nr.blob.__mark.url === 'blob://NEW-FILE' ? '✔ 新文件帧正常' : '[×] 异常！');
});

$('#raceCancel').addEventListener('click', async () => {
  raceLog.textContent = '';
  const h = raceHarness();
  const ex = new FrameExtractor({ createMedia: h.createMedia, createCanvas: h.createCanvas, concurrency: 1, seekTimeout: 1000 });
  const ps = [];
  for (let i = 0; i < 5; i += 1) ps.push(ex.capture(`p${i}`, { trackId: 't1', url: 'blob://x', sourceTime: i + 1 }));
  rlog('concurrency=1：1 个在途 + 4 个排队，立即 cancelAll');
  ex.cancelAll();
  await h.env.drain();
  const rs = await Promise.all(ps);
  const allStale = rs.every((r) => r.status === 'stale');
  rlog(`5 个请求结果：${rs.map((r) => r.status).join(', ')}`);
  rlog(allStale ? '✔ 在途与排队任务全部 stale，无帧提交' : '[×] 异常！');
});

$('#raceOutOfOrder').addEventListener('click', async () => {
  raceLog.textContent = '';
  const h = raceHarness();
  const ex = new FrameExtractor({ createMedia: h.createMedia, createCanvas: h.createCanvas, concurrency: 4, seekTimeout: 1000 });
  rlog('手动乱序：先发两次取帧，再让【旧媒体】的 loadedmetadata/seeked 全部晚于新媒体派发');
  const oldCapture = ex.capture('pX', { trackId: 't1', url: 'blob://OLD', sourceTime: 1 });
  const newCapture = ex.capture('pX', { trackId: 't1', url: 'blob://NEW', sourceTime: 9 });
  const [oldM, newM] = h.created;
  h.env.flush({ media: newM }); // 新媒体全部回调先到
  h.env.flush({ media: oldM }); // 旧媒体回调晚到（乱序）
  const [ro, rn] = await Promise.all([oldCapture, newCapture]);
  rlog(`旧请求=${ro.status}，新请求=${rn.status}（帧源时间=${rn.blob?.__mark?.time}）`);
  rlog(ro.status === 'stale' && rn.status === 'ok' && rn.blob.__mark.time === 9 ? '✔ 乱序回调下旧帧被丢弃，新分镜为源时间 9.00' : '[×] 异常！');
});

render();
