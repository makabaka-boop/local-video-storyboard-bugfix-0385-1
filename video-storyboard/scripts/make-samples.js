// 用 Chromium 自身的 canvas + MediaRecorder 录制短视频样本：
// 每帧绘制秒号大字与按时间变化的色块——之后 E2E 测试可读取取帧画布的像素，
// 验证“seek 到 t 取到的确实是 t 时刻的帧”，而不是别的时间。
//
// 输出：samples/clip-a.webm（4s，红橙系）、samples/clip-b.webm（3s，青蓝系）

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', 'samples');

const PAGE = `<!doctype html><html><body><canvas id="c" width="320" height="180"></canvas>
<script>
const canvas = document.getElementById('c');
const ctx = canvas.getContext('2d');

function draw(tSec, hue0) {
  const hue = (hue0 + Math.floor(tSec) * 40) % 360;
  ctx.fillStyle = 'hsl(' + hue + ',80%,45%)';
  ctx.fillRect(0, 0, 320, 180);
  // 顶部按 100ms 变化的细条，用于区分亚秒时间
  ctx.fillStyle = 'hsl(' + ((hue + 180) % 360) + ',90%,70%)';
  ctx.fillRect(0, 0, Math.round((tSec % 1) * 320), 24);
  // 秒号
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 96px monospace';
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(String(Math.floor(tSec)), 160, 100);
  // 两位小数时间
  ctx.font = '20px monospace';
  ctx.fillText(tSec.toFixed(2), 160, 160);
}

async function record(seconds, hue0, fps) {
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 1_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = () => res(new Blob(chunks, { type: 'video/webm' })); });
  rec.start();
  const start = performance.now();
  await new Promise((res) => {
    function step() {
      const t = (performance.now() - start) / 1000;
      if (t >= seconds) { res(); return; }
      draw(t, hue0);
      setTimeout(step, 1000 / fps);
    }
    step();
  });
  draw(seconds - 0.01, hue0);
  rec.stop();
  return done;
}

window.__make = async (seconds, hue0, fps) => {
  const blob = await record(seconds, hue0, fps);
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
};
</script></body></html>`;

async function makeSample(page, seconds, hue0, fps) {
  return page.evaluate(async ([s, h, f]) => window.__make(s, h, f), [seconds, hue0, fps]);
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.log('PAGE ERROR:', m.text()); });
  await page.goto(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);

  const clips = [
    { name: 'clip-a.webm', seconds: 4, hue0: 0, fps: 10 },
    { name: 'clip-b.webm', seconds: 3, hue0: 160, fps: 10 },
  ];
  for (const c of clips) {
    const data = await makeSample(page, c.seconds, c.hue0, c.fps);
    const file = path.join(outDir, c.name);
    await writeFile(file, Buffer.from(data));
    console.log(`wrote ${c.name} (${data.length} bytes, ${c.seconds}s)`);
  }
  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
