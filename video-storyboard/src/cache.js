// 本地有界缩略帧缓存：IndexedDB，键 = 文件摘要 + 源时间（毫秒桶）。
// 设计约束：
//  - 重开页面后，只有“重新选中内容相同的视频”（摘要一致）才能命中；
//    应用层不持久化任何 文件<->摘要 的绑定关系。
//  - 配额/事务失败一律降级为“仅内存”，绝不向上抛出、绝不影响分镜清单。
//  - LRU 淘汰按最近访问时间；put 失败时先淘汰再重试，仍失败则放弃写入。

const DB_NAME = 'vsb-thumb-cache-v1';
const STORE = 'frames';
const META = 'meta';

export class FrameCache {
  constructor({ maxBytes = 200 * 1024 * 1024, maxEntries = 2000 } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntries = maxEntries;
    this.db = null;
    this.failed = false;     // 永久降级（隐私模式等）
    this.mem = new Map();   // key -> {blob, atime}
    this.memBytes = 0;
  }

  async open() {
    if (this.db || this.failed) return;
    if (typeof indexedDB === 'undefined') { this.failed = true; return; }
    try {
      this.db = await openDb(DB_NAME, (db) => {
        if (!db.objectStoreNames.contains(STORE)) {
          const s = db.createObjectStore(STORE);
          s.createIndex('atime', 'atime');
        }
        if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      });
    } catch {
      this.failed = true;
      this.db = null;
    }
  }

  /** 取帧；命中即刷新 atime。无 DB 时查内存 Map。 */
  async get(key) {
    await this.open();
    if (this.db) {
      try {
        const rec = await txGet(this.db, STORE, key);
        if (rec) {
          // 不 await 刷新失败也无所谓
          txPut(this.db, STORE, key, { ...rec, atime: Date.now() }).catch(() => {});
          return rec.blob;
        }
        return null;
      } catch {
        return this.memGet(key);
      }
    }
    return this.memGet(key);
  }

  /** 存帧；任何配额错误都吞掉并降级。 */
  async put(key, blob) {
    await this.open();
    if (this.db) {
      try {
        await this.evictToFit(blob.size);
        await txPut(this.db, STORE, key, { blob, atime: Date.now(), size: blob.size });
        return;
      } catch (err) {
        if (isQuotaError(err)) {
          // 激进淘汰一半后重试一次；仍失败则放弃（不影响清单）。
          try {
            await this.evictFraction(0.5);
            await this.evictToFit(blob.size);
            await txPut(this.db, STORE, key, { blob, atime: Date.now(), size: blob.size });
            return;
          } catch { /* fall through to memory */ }
        }
      }
    }
    this.memPut(key, blob);
  }

  async delete(key) {
    if (this.db) {
      try { await txDelete(this.db, STORE, key); } catch { /* ignore */ }
    }
    this.mem.delete(key);
  }

  /** 清空缓存（供“清除缓存”按钮；不会改动分镜数据） */
  async clear() {
    if (this.db) {
      try { await txClear(this.db, STORE); } catch { /* ignore */ }
    }
    this.mem.clear();
    this.memBytes = 0;
  }

  async usage() {
    await this.open();
    let entries = 0;
    let bytes = 0;
    if (this.db) {
      try {
        const all = await txGetAll(this.db, STORE);
        for (const rec of all) { entries += 1; bytes += rec.blob?.size ?? rec.size ?? 0; }
      } catch { /* ignore */ }
    } else {
      entries = this.mem.size;
      bytes = this.memBytes;
    }
    return { entries, bytes, degraded: this.failed || !this.db };
  }

  // ---- 内部：LRU 淘汰 ----

  async evictToFit(incomingSize) {
    const all = await txGetAll(this.db, STORE);
    let total = 0;
    for (const rec of all) total += rec.blob?.size ?? rec.size ?? 0;
    all.sort((a, b) => a.atime - b.atime);
    let i = 0;
    while ((total + incomingSize > this.maxBytes || all.length - i + 1 > this.maxEntries) && i < all.length) {
      // 键来自游标主键（cur.key），与记录体解耦，旧记录也能被淘汰
      const rec = all[i];
      await txDelete(this.db, STORE, rec.key); // eslint-disable-line no-await-in-loop
      total -= rec.blob?.size ?? rec.size ?? 0;
      i += 1;
    }
  }

  async evictFraction(fraction) {
    const all = await txGetAll(this.db, STORE);
    all.sort((a, b) => a.atime - b.atime);
    const n = Math.floor(all.length * fraction);
    for (let i = 0; i < n; i += 1) {
      try { await txDelete(this.db, STORE, all[i].key); } catch { /* ignore */ } // eslint-disable-line no-await-in-loop
    }
  }

  memGet(key) {
    const rec = this.mem.get(key);
    if (!rec) return null;
    rec.atime = Date.now();
    return rec.blob;
  }

  memPut(key, blob) {
    const old = this.mem.get(key);
    if (old) this.memBytes -= old.blob.size;
    this.mem.set(key, { blob, atime: Date.now() });
    this.memBytes += blob.size;
    // 内存映射也做有界
    while (this.mem.size > this.maxEntries || this.memBytes > this.maxBytes) {
      const oldest = [...this.mem.entries()].sort((a, b) => a[1].atime - b[1].atime)[0];
      if (!oldest) break;
      this.memBytes -= oldest[1].blob.size;
      this.mem.delete(oldest[0]);
    }
  }
}

function isQuotaError(err) {
  return err && (err.name === 'QuotaExceededError'
    || err.name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || err.code === 22);
}

// ---- 极简 IndexedDB Promise 封装（无外部依赖） ----

function openDb(name, onUpgrade) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 1);
    req.onupgradeneeded = () => onUpgrade(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(req.error || new Error('blocked'));
  });
}

function txReq(db, mode, store, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const s = tx.objectStore(store);
    const req = fn(s);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error || req.error || new Error('aborted'));
  });
}

function txGet(db, store, key) {
  return txReq(db, 'readonly', store, (s) => s.get(key));
}

function txPut(db, store, key, rec) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put({ ...rec, key }, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

function txDelete(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

function txClear(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('aborted'));
  });
}

function txGetAll(db, store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).openCursor();
    const out = [];
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        out.push({ ...cur.value, key: cur.key });
        cur.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}
