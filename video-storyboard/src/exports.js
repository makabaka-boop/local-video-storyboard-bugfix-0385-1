// 导出物：PNG 接触表 与 JSON 清单。
// 两者只能接收同一次 App.freezeSnapshot() 的不可变副本——
// 生成是异步的，实时分镜数据在生成期间被编辑也不会串入本次导出。

export function formatTime(sec) {
  if (!Number.isFinite(sec)) return '--:--.--';
  const neg = sec < 0;
  sec = Math.abs(sec);
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = s.toFixed(2).padStart(5, '0');
  return `${neg ? '-' : ''}${String(m).padStart(2, '0')}:${ss}`;
}

function loadImage(blob) {
  if (typeof createImageBitmap === 'function') {
    return createImageBitmap(blob).then((bmp) => ({ bmp }), () => null);
  }
  return new Promise((resolve) => {
    if (typeof Image === 'undefined') { resolve(null); return; }
    const img = new Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

function freeImage(im) {
  if (!im) return;
  if (im.bmp && typeof im.bmp.close === 'function') im.bmp.close();
  if (im.url) URL.revokeObjectURL(im.url);
}

/**
 * 生成接触表。缺失帧的格子画占位框并标注“缺帧”，
 * 保证格子数量、顺序与 JSON 清单严格一致。
 * @param snapshot freezeSnapshot() 返回的不可变分镜记录数组
 * @param tracks Map/record: trackId -> track（含 name、offset）
 * @param opts {columns, cellWidth, frameWidth}
 */
export async function buildContactSheet(snapshot, tracks, opts = {}) {
  const columns = Math.max(1, opts.columns ?? 4);
  const cellW = opts.cellWidth ?? 360;
  const cellH = opts.cellHeight ?? 250;
  const pad = opts.padding ?? 12;
  const headerH = opts.headerHeight ?? 28;
  const rows = Math.max(1, Math.ceil(snapshot.length / columns));

  const W = pad + columns * (cellW + pad);
  const H = pad + rows * (cellH + headerH + pad);
  const mkCanvas = opts.createCanvas
    ?? ((w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      return c;
    });
  const canvas = mkCanvas(W, H);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#101317';
  ctx.fillRect(0, 0, W, H);
  ctx.font = '13px monospace';
  ctx.textBaseline = 'top';

  for (let i = 0; i < snapshot.length; i += 1) {
    const p = snapshot[i];
    const track = tracks.get?.(p.trackId) || tracks[p.trackId];
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = pad + col * (cellW + pad);
    const y = pad + row * (cellH + headerH + pad);
    const im = p.frame ? await loadImage(p.frame) : null;

    ctx.fillStyle = '#1b2027';
    ctx.fillRect(x, y, cellW, cellH);
    if (im) {
      const bmp = im.bmp || im.img;
      drawCover(ctx, bmp, x, y, cellW, cellH);
    } else {
      ctx.strokeStyle = '#3a4350';
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x + 4, y + 4, cellW - 8, cellH - 8);
      ctx.setLineDash([]);
      ctx.fillStyle = '#8a96a6';
      ctx.fillText('缺帧（未提取或提取失败）', x + 12, y + cellH / 2 - 8);
    }

    // 角标编号
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(x, y, 46, 22);
    ctx.fillStyle = '#e9eef5';
    ctx.fillText(`#${String(i + 1).padStart(2, '0')}`, x + 8, y + 4);

    // 表头行（统一时间轴项目时间 / 源时间 / 文件名）
    const hy = y + cellH + 6;
    ctx.fillStyle = '#c8d2df';
    ctx.fillText(`${formatTime(p.projectTime)}  ←  ${track?.name ?? '?'} @ ${formatTime(p.sourceTime)}`, x, hy);
    ctx.fillStyle = '#7e8a99';
    ctx.fillText(`点ID ${p.id}${p.frameFromCache ? ' · 缓存' : ''}`, x, hy + 15);

    freeImage(im);
  }

  const blob = await new Promise((resolve) => {
    if (typeof canvas.convertToBlob === 'function') {
      canvas.convertToBlob({ type: 'image/png' }).then(resolve, () => resolve(null));
    } else {
      canvas.toBlob(resolve, 'image/png');
    }
  });
  return { blob, width: W, height: H, columns, rows };
}

function drawCover(ctx, img, x, y, w, h) {
  const iw = img.width || img.videoWidth;
  const ih = img.height || img.videoHeight;
  const scale = Math.max(w / iw, h / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
}

/**
 * JSON 清单：与接触表同一数组、同一顺序、同一 index。
 * 不内嵌图片二进制；只记录缓存键/帧是否就绪/PNG 中是否缺帧。
 */
export function buildManifest(snapshot, tracks, sheetMeta = null) {
  const trackList = (tracks instanceof Map ? [...tracks.values()] : Object.values(tracks));
  return {
    format: 'video-storyboard-manifest',
    version: 1,
    generatedAt: new Date().toISOString(),
    projectDuration: trackList.reduce((m, t) => Math.max(m, t.offset + t.duration), 0),
    tracks: trackList.map((t) => ({
      id: t.id,
      name: t.name,
      digestAlgo: t.digest?.algo ?? null,
      digest: t.digest?.hex ?? null,
      duration: round3(t.duration),
      width: t.width ?? null,
      height: t.height ?? null,
      offset: round3(t.offset),
    })),
    contactSheet: sheetMeta ? {
      columns: sheetMeta.columns,
      rows: sheetMeta.rows,
      width: sheetMeta.width,
      height: sheetMeta.height,
      points: snapshot.length,
    } : null,
    points: snapshot.map((p, i) => {
      const track = tracks.get?.(p.trackId) || tracks[p.trackId];
      return {
        index: i + 1,
        id: p.id,
        projectTime: round3(p.projectTime),
        trackId: p.trackId,
        trackName: track?.name ?? null,
        sourceTime: round3(p.sourceTime),
        frameKey: p.frameKey ?? null,
        frameReady: !!p.frame,
        frameFromCache: !!p.frameFromCache,
        frameBytes: p.frame?.size ?? 0,
        status: p.frameStatus,
      };
    }),
  };
}

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function downloadBlob(blob, filename) {
  if (typeof document === 'undefined') throw new Error('downloadBlob 仅可在浏览器中调用');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 0);
}
