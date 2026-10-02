// 文件摘要：SubtleCrypto SHA-256（Web Crypto），失败时回退 xxh 风格 32 位哈希。
// 摘要只用于“内容相同的视频”识别，不承担安全用途；
// 但同一缓存键同时包含 SHA 前缀/回退前缀，两种算法不会互相撞键。

export async function digestFile(file) {
  try {
    const buf = await file.arrayBuffer();
    const out = await crypto.subtle.digest('SHA-256', buf);
    return { algo: 'sha256', hex: bufToHex(out), bytes: buf };
  } catch {
    const buf = await file.arrayBuffer();
    return { algo: 'fcs32', hex: fcs32Hex(new Uint8Array(buf)), bytes: buf };
  }
}

function bufToHex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 1) s += b[i].toString(16).padStart(2, '0');
  return s;
}

// FCS-32：极轻量回退，确定性、跨会话稳定。
const FCS_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let v = n;
    for (let k = 0; k < 8; k += 1) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
    t[n] = v >>> 0;
  }
  return t;
})();

export function fcs32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = FCS_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function fcs32Hex(bytes) {
  return fcs32(bytes).toString(16).padStart(8, '0');
}
