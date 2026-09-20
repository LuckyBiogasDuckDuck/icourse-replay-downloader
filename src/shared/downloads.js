/* 下载相关的纯函数（iCourse 回放下载器）。
 *
 * 被三处加载：
 *   - content script（普通脚本，挂在 globalThis.ICDL 上）
 *   - 测试（node 里 require 不了，测试用 vm 加载，见 wiring.test.js 的做法）
 *
 * 这里只放**不碰 DOM、不碰网络**的纯逻辑，方便单测：
 *   文件名清洗、扩展名推断、m3u8 解析与合并、分片命名、体积格式化。
 * 真正的下载动作在 background.js（chrome.downloads）和 content.js（m3u8 抓流）。
 */

globalThis.ICDL = (function () {
  'use strict';

  /** Windows / macOS / Linux 都不安全的字符，统一换成下划线 */
  const UNSAFE = /[\\/:*?"<>|\u0000-\u001f]/g;

  /** 规范化文件名：去掉非法字符、压掉首尾空白与点、限制长度。
   *  注意要在**已经拼好扩展名之后**再调用会误伤 ".mp4" 里的点，
   *  所以这里只处理"基名"，保留调用方传入的扩展名。 */
  function safeName(name, fallback) {
    let s = String(name == null ? '' : name);
    // 先把制表/换行这类空白折成空格，避免它们被当成"非法字符"变下划线
    s = s.replace(/[\t\n\r\f\v\u00a0]+/g, ' ');
    // 其余控制字符（含 \u0000）确实不适合出现在文件名里
    s = s.replace(/[\u0000-\u001f\u007f]/g, '_');
    s = s.replace(UNSAFE, '_');
    // 折叠连续空白（含中英文空格）
    s = s.replace(/\s+/g, ' ').trim();
    // 首尾的点和下划线在 Windows 上不合法/易丢失
    s = s.replace(/^[.\s_]+|[.\s_]+$/g, '');
    if (!s) s = String(fallback == null ? 'download' : fallback);
    // 文件系统对单段名有长度限制，留出扩展名和序号空间
    if (s.length > 120) s = s.slice(0, 120).trim();
    return s || 'download';
  }

  /** 给同名文件加序号，避免浏览器自动 \ (1) 这种难看的重名后缀 */
  function withIndex(name, i, total) {
    if (total <= 1) return name;
    const w = String(total).length;
    return String(i + 1).padStart(w, '0') + '-' + name;
  }

  /** 从 URL 的 pathname 里取扩展名（小写，不含点）。取不到返回 ''。 */
  function extFromUrl(url) {
    try {
      const u = new URL(String(url), 'https://example.invalid/');
      const m = /\.([a-z0-9]{1,8})$/i.exec(u.pathname);
      return m ? m[1].toLowerCase() : '';
    } catch (e) {
      return '';
    }
  }

  /** 判断这个 URL 属于哪种媒体。返回 'hls' | 'mp4' | 'other'。 */
  function mediaKind(url) {
    const e = extFromUrl(url);
    if (e === 'm3u8') return 'hls';
    if (e === 'mp4' || e === 'm4v' || e === 'mov' || e === 'flv' || e === 'webm' || e === 'mkv') return 'mp4';
    // 没有扩展名时看路径关键词
    const s = String(url || '').toLowerCase();
    if (/\.m3u8(\?|#|$)/.test(s)) return 'hls';
    if (/(\.mp4|\.flv|\/mp4\/|\/video\/)/.test(s)) return 'mp4';
    return 'other';
  }

  /** 解析 m3u8 文本。
   *  返回 { isMaster: boolean, variants: [{bandwidth, resolution, url}], segments: [绝对 URL] }
   *  baseUrl 用来把相对路径解析成绝对 URL。 */
  function parseM3U8(text, baseUrl) {
    const out = { isMaster: false, variants: [], segments: [] };
    if (!text || typeof text !== 'string') return out;
    const lines = text.split(/\r?\n/);
    if (lines.some((l) => l.indexOf('#EXT-X-STREAM-INF') === 0)) out.isMaster = true;

    let pendingVariant = null;
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].trim();
      if (!raw) continue;

      if (raw.startsWith('#EXT-X-STREAM-INF:')) {
        const attrs = raw.slice('#EXT-X-STREAM-INF:'.length);
        const bw = /BANDWIDTH=(\d+)/i.exec(attrs);
        const res = /RESOLUTION=([0-9x]+)/i.exec(attrs);
        pendingVariant = {
          bandwidth: bw ? parseInt(bw[1], 10) : 0,
          resolution: res ? res[1] : '',
          url: ''
        };
        continue;
      }

      if (raw.startsWith('#')) continue;

      // 非 # 开头 = URI 行
      const abs = absUrl(raw, baseUrl);
      if (pendingVariant) {
        pendingVariant.url = abs;
        out.variants.push(pendingVariant);
        pendingVariant = null;
      } else {
        out.segments.push(abs);
      }
    }
    return out;
  }

  /** 把可能是相对路径的 URL 解析成绝对 URL；失败时原样返回。 */
  function absUrl(u, base) {
    try {
      return new URL(String(u), base).href;
    } catch (e) {
      return String(u);
    }
  }

  /** 从 master playlist 里挑一路变体：优先最高 BANDWIDTH，其次最高分辨率。
   *  没有任何变体时返回 ''。 */
  function pickBestVariant(variants) {
    if (!Array.isArray(variants) || !variants.length) return '';
    let best = null;
    let bestScore = [-1, -1];
    for (const v of variants) {
      if (!v || !v.url) continue;
      const px = /^(\d+)x(\d+)$/.exec(v.resolution || '');
      const h = px ? parseInt(px[2], 10) : 0;
      const score = [Number(v.bandwidth) || 0, h];
      if (score[0] > bestScore[0] || (score[0] === bestScore[0] && score[1] > bestScore[1])) {
        best = v;
        bestScore = score;
      }
    }
    return best ? best.url : '';
  }

  /** m3u8 里有时带加密或独立分片初始化段（fMP4）。这几个标记决定我们能不能简单拼接。 */
  function hlsHazards(text) {
    const s = String(text || '');
    return {
      encrypted: /#EXT-X-KEY:[^\n]*METHOD=(?!NONE)/i.test(s),
      // fMP4 的初始化段：拼接时需要把它放在最前面
      hasMap: /#EXT-X-MAP:/i.test(s),
      ended: /#EXT-X-ENDLIST/i.test(s),
      isLive: !/#EXT-X-ENDLIST/i.test(s) && /#EXT-X-TARGETDURATION/i.test(s)
    };
  }

  /** 字节数格式化，用于进度显示 */
  function fmtBytes(n) {
    const v = Number(n);
    if (!isFinite(v) || v < 0) return '—';
    if (v < 1024) return v + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let x = v / 1024;
    let i = 0;
    while (x >= 1024 && i < units.length - 1) {
      x /= 1024;
      i++;
    }
    return (x >= 100 ? x.toFixed(0) : x.toFixed(1)) + ' ' + units[i];
  }

  /** 由课程/章节信息算出建议文件名（不含扩展名）。
   *  课程名可缺省；章节名优先，二者都有时拼成「课程-章节」。 */
  function buildBaseName(parts) {
    const p = parts || {};
    // 这里用 safeName(x, '') 而不是 safeName(x)：课程名或章节名缺一个时，
    // 我们要的是"空"，不是补上默认的 'download'（那会拼出 "download-第 3 讲"）
    const clean = (x) => {
      const s = safeName(x, '');
      return s === 'download' ? '' : s;
    };
    const chapter = clean(p.chapter);
    const course = clean(p.course);
    let s;
    if (course && chapter && course !== chapter) s = course + '-' + chapter;
    else s = chapter || course || 'icourse-视频';
    return safeName(s, 'icourse-视频');
  }

  /** 章节排序键：把「第 12 讲」排到「第 3 讲」后面（按数字，不按字符串） */
  function chapterOrder(text) {
    const t = String(text || '');
    const m = /(\d+)/.exec(t);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  }

  return {
    safeName,
    withIndex,
    extFromUrl,
    mediaKind,
    parseM3U8,
    absUrl,
    pickBestVariant,
    hlsHazards,
    fmtBytes,
    buildBaseName,
    chapterOrder
  };
})();

/* 供 Node 单测使用（浏览器里 module 不存在，自动跳过） */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = globalThis.ICDL;
}
