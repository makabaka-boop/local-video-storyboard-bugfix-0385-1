# 多视频统一时间轴 · 分镜工具

纯前端（ESM，无构建步骤）工具：浏览器导入 **2～3 段本地短视频**，为每段设置相对
项目时间的偏移，在统一时间轴上建立 **不超过 30 个**分镜点；从视频提取对应缩略帧，
支持**点击分镜定位播放**、生成 **PNG 接触表**与 **JSON 清单**——三者严格使用
**同一组已确认时间点**。

## 运行

```bash
npm run serve         # http://127.0.0.1:8791
# 或任意静态服务器，如：python3 -m http.server 8791
```

浏览器打开页面后：

1. 点「导入 2～3 段视频」选择本地视频（WebM / MP4 等浏览器可解码格式）；
2. 在左侧为每段视频设置**项目偏移（秒）**，连续拖动也不会让旧帧串到新分镜；
3. 点击时间轴标尺手动加点，或输入数量点「均匀取点」（硬上限 30）；
4. 点击缩略图**定位播放**；点「导出 PNG + JSON」同时产出接触表与清单。

## 模块结构

```
src/
  timeline.js   纯逻辑：轨道/偏移、统一时间轴解析、分镜点（≤30）、已确认快照
  extractor.js  取帧器：令牌(token)+换代(epoch)解决 load/seek/toBlob 全部乱序竞争
  media-dom.js  真实 HTMLVideoElement / canvas 适配器、元数据探测、seek 精度保护
  cache.js      IndexedDB 有界缓存（LRU、字节+条目双配额、失败静默降级内存）
  hash.js       文件摘要：SHA-256（Web Crypto），失败回退 FCS-32
  exports.js    PNG 接触表 + JSON 清单（共用同一快照）；缺帧点保留格子并标注
  app.js        主控：导入/替换/偏移/取帧调度/播放/导出，维护三者同源不变量
test/
  fakes.js      可控媒体假件（manual/auto 两种回调派发），Node 与页面共用
  node/         37 个 node:test 单测（时间轴/竞争/缓存/摘要/导出/导出一致性）
  browser/e2e.js 真实 Chromium 端到端（23 项检查，见下）
samples/        clip-a.webm (4s) / clip-b.webm (3s)，画面带秒号与时间变色
scripts/        make-samples.js（用 Chromium MediaRecorder 录制样本）、server.js
```

## 竞争安全设计（核心）

浏览器的 `loadedmetadata` / `seeked` / `toBlob` 回调在以下情况下会乱序：

- **连续拖动**时间点：同一点旧的 seek 请求尚未结束，新的请求已发起；
- **替换文件**：旧文件的回调还在路上，轨道已换成新文件；
- **取消 / 清空**：任务在排队、在途、或已画完只等 `toBlob`。

`FrameExtractor` 对每个分镜点只保留一个在世令牌；令牌在**每个回调入口**与
**`toBlob` 异步返回之后**都重新校验（`isLive`），失效任务一律兑现 `{status:'stale'}`，
其帧**绝不提交**：

- 同一点的新请求 → 覆盖旧令牌（`_current: pointId -> token`）；
- 替换/删除文件 → `bumpTrack(trackId)` 使该轨令牌换代，排队任务同步作废；
- 全部取消 → `cancelAll()` 全局换代，在途与排队任务全部 stale；
- 加载/seek/toBlob 各阶段有超时守护，任务不会悬空。

页面底部「竞争次序测试」面板用**可控假媒体**（与 Node 单测同一份 `test/fakes.js`）
手动决定每个回调何时到达，可在浏览器里直接复现乱序并查看结果。

## 本地有界缓存

- 键：`sha256:<文件内容摘要>/t<源时间毫秒>`（回退算法用 `fcs32:` 前缀，不会撞键）；
- 只依赖**文件内容**与**源时间**，与项目偏移无关；
- 应用层**不持久化任何文件↔摘要绑定**：重开页面后轨道/分镜清空，
  只有**重新选中内容相同的视频**（摘要一致）时才会命中缓存；
- IndexedDB 双配额（默认 200MiB / 2000 条），LRU 淘汰；
- 配额或事务错误 → 先激进淘汰重试，仍失败则**静默降级到内存**，
  取帧与 JSON 清单永远可用（缓存失败不会破坏分镜清单）。

## 三者同源

`Timeline.confirmedSnapshot()` 返回唯一有序分镜数组；`App.freezeSnapshot()`
在导出时把每个分镜点**拷贝为不可变记录**（成员、顺序、轨道、源时间、
缓存键、帧 Blob 引用全部定格在同一版已确认数据），`buildContactSheet` 与
`buildManifest` 只消费这次冻结（接触表格子数/顺序/编号 = 清单 `points[].index`）。
导出是异步的：导出过程中的偏移调整、替换文件、在途取帧完成都只作用于实时
实例，**不会串入本次 PNG 或 JSON**；`exportAll` 先收敛（补取缺帧并等待全部
在途取帧结束，有界轮次防止连续编辑阻塞）再冻结。播放定位 `locatePlayback`
读取当前确认状态，未再编辑时与导出快照一致。缺帧/被取消的点在 PNG 中保留
占位格并在清单中标注 `frameReady:false`。

## 测试

```bash
npm test          # 37 个 Node 单测（含可控媒体竞争次序、LRU、配额失败、导出一致性）
npm run make-samples   # 用 Chromium 录制短视频样本（已附带生成好的 samples/）
npm run test:e2e  # 真实 Chromium：实际取帧/播放/导出/导出中编辑/缓存跨会话/配额隔离
npm run test:all  # 以上全部
```

E2E 会用样本画面中随秒变化的背景色相验证“取到的帧确实属于正确视频、正确源时间”，
而不仅仅是“拿到了一张图”。

> 无 root 环境若 Chromium 缺系统库（`libnspr4` 等），可从 Debian 镜像下载对应
> `.deb` 解包到用户目录，再以 `LD_LIBRARY_PATH=<解包目录的库路径> npm run test:e2e`
> 运行；常规环境直接 `npx playwright install --with-deps chromium` 即可。
> `samples/*.webm` 已随仓库附带，无需重新录制。
