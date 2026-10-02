// 浏览器真实媒体：把 HTMLVideoElement 适配成 FrameExtractor 需要的受控接口。
// - 每次取帧使用独立的静音 video（muted+playsInline），blob: URL 由调用方管理；
// - 只监听 loadedmetadata / seeked / error，顺序乱也没关系——
//   令牌校验全部在 extractor 里完成。

export function createRealMedia() {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.crossOrigin = 'anonymous';
  return {
    addEventListener: (t, fn) => video.addEventListener(t, fn),
    removeEventListener: (t, fn) => video.removeEventListener(t, fn),
    setSource(url) { video.src = url; },
    requestLoad() { video.load(); },
    seek(t) {
      // 某些浏览器在 currentTime 已等于目标值时不触发 seeked，
      // 先挪开一点再设置，保证一定产生 seek 动作。
      if (Math.abs(video.currentTime - t) < 1e-4) video.currentTime = Math.max(0, t - 0.001);
      video.currentTime = t;
    },
    // extractor 发现落点早于目标（关键帧 seek）时调用：向未来轻推，
    // 取“不早于目标”的帧，避免拿到上一秒的画面。
    seekAccurate(t) {
      video.currentTime = Math.min(video.duration || t, t + 0.12);
    },
    get currentTime() { return video.currentTime; },
    draw(ctx, w, h) {
      ctx.drawImage(video, 0, 0, w, h);
    },
    get videoWidth() { return video.videoWidth; },
    get videoHeight() { return video.videoHeight; },
    get error() { return video.error; },
    destroy() {
      video.removeAttribute('src');
      try { video.load(); } catch { /* 释放解码器资源 */ }
    },
  };
}

export function createRealCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * 探测文件元数据（时长、尺寸），供导入/替换时建立轨道。
 * @returns {Promise<{duration,width,height}>}
 */
export function probeVideo(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    const cleanup = () => {
      video.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
    video.onloadedmetadata = () => {
      const out = { duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      cleanup();
      if (!Number.isFinite(out.duration) || out.duration <= 0) {
        reject(new Error('无法读取视频时长（文件可能不是有效视频）'));
      } else {
        resolve(out);
      }
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('浏览器无法解码该视频（建议使用 WebM/MP4(H.264)）'));
    };
    video.src = url;
  });
}
