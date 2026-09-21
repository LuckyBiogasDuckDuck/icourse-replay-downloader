/* iCourse 回放下载器 —— 内容脚本
 *
 * 职责：
 *   1. 找到页面上的课程视频与章节清单
 *   2. 画一个可拖动的小面板（下载本节 / 批量下载）
 *   3. 把媒体地址交给 background 里的 chrome.downloads 落盘
 *
 * 它**不**做任何绕过限制的事：不伪造观看进度、不改播放记录、
 * 遇到加密流直接放弃。只是把你能正常播放的内容另存一份。
 */

(function () {
  'use strict';

  const DL = globalThis.ICDL;
  if (!DL) return; // 共享模块没加载上（manifest 顺序错了），安静退出

  /* ============================================================ 状态 */

  const state = {
    video: null,
    /** 当前探测到的媒体：{ url, kind } */
    media: null,
    /** 当前下载：{ downloadId, resolve } 供状态回执对应 */
    active: null,
    batchRunning: false,
    batchAbort: false,
    /** 章节清单 [{ row, name, isCurrent, i, state }] */
    chapters: [],
    panelHidden: false,
    /** 提交过的下载记录 [{url, filename}]，最多留 20 条 */
    log: []
  };

  /** 记录一次提交（面板上有个隐藏节点会把它吐出来，便于自动化测试断言） */
  function logDownload(url, filename) {
    state.log.push({ url, filename });
    if (state.log.length > 20) state.log.shift();
    renderLog();
  }

  function renderLog() {
    if (!ui.logEl) return;
    // 形式是 JSON，但把 < > 转义掉，免得内容里的尖括号破坏 DOM
    ui.logEl.textContent = JSON.stringify(state.log).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  }

  let ui = {};

  /** 批量下载时，连续这么多节拿不到媒体地址就停下（防止章节选择器猜错后长时间空转） */
  const MISS_LIMIT = 3;

  /* ============================================================ 小工具 */

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  function log(text) {
    try {
      chrome.runtime.sendMessage({ type: 'icdl/log', text });
    } catch (e) {
      /* 扩展被卸载时忽略 */
    }
  }

  /* ============================================================ 视频探测 */

  function pickVideo() {
    const list = $$('video').filter((v) => v.readyState !== undefined);
    if (!list.length) return null;

    // 优先认这个站点播放器的视频元素（README 里记录的实测 id）。
    // 页面以后可能加广告/预览/试看之类的小视频，光靠"时长最长"会挑错。
    const known = list.find((v) => v.id === 'cmc_player_video');
    if (known) return known;

    // 认不到就退回启发式：时长最长的那个最像正片
    return list.reduce((best, v) => {
      const d = isFinite(v.duration) ? v.duration : 0;
      const bd = best && isFinite(best.duration) ? best.duration : 0;
      return d > bd ? v : best;
    }, list[0]);
  }

  /** 探测本节媒体地址。返回 { url, kind, why } */
  function probeMedia() {
    const v = state.video || pickVideo();
    if (!v) return { url: '', kind: 'other', why: '页面上没找到 <video> 元素' };

    const src = v.currentSrc || v.src || '';
    if (src && /^blob:/i.test(src)) {
      return {
        url: '',
        kind: 'blob',
        why: '这个播放器用的是 blob: 地址（边下边播），拿不到可直连的文件地址'
      };
    }
    if (src) return { url: src, kind: DL.mediaKind(src), why: '' };

    // <video> 里可能是 <source>，读它
    const s = v.querySelector && v.querySelector('source');
    if (s && s.src) return { url: s.src, kind: DL.mediaKind(s.src), why: '' };

    return { url: '', kind: 'other', why: '视频还没加载出地址；让它播一下，再点「重新探测」' };
  }

  /* ============================================================ 章节清单 */

  const CATALOGUE_SELECTORS = [
    '.course-catalogue-wrapper .item-wrapper',
    '.course-catalogue-wrapper .catalogue-item',
    '[class*="catalogue-wrapper"] [class*="item-wrapper"]',
    '[class*="catalogue"] [class*="catalogue-item"]',
    '[class*="chapter-list"] > *',
    '[class*="chapter"] [class*="item"]'
  ];

  function collectChapters() {
    let rows = [];
    for (const sel of CATALOGUE_SELECTORS) {
      try {
        const found = $$(sel);
        if (found.length >= 2) {
          rows = found;
          break;
        }
      } catch (e) {
        /* 选择器语法问题，试下一个 */
      }
    }
    if (!rows.length) return [];

    return rows.map((row, i) => {
      const nameEl = row.querySelector('.catalogue-name,[class*="catalogue-name"]');
      let name = nameEl ? nameEl.textContent.trim() : '';
      if (!name) {
        name = String(row.textContent || '')
          .replace(/\d{1,3}:\d{2}(:\d{2})?/g, ' ')
          .replace(/当前播放|播放中|已学完|未开始/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
      }
      const isCurrent = !!row.querySelector('[class*="current"],[class*="active"],[class*="playing"]');
      return { row, name: name || '第 ' + (i + 1) + ' 节', isCurrent, i, state: '' };
    });
  }

  /** 课程名：优先页面标题，标题不像话就用空 */
  function courseName() {
    const t = (document.title || '').trim();
    if (!t) return '';
    if (/^(icourse|智慧教学|复旦大学)/i.test(t)) return '';
    return t;
  }

  function currentChapterName() {
    const cur = (state.chapters.length ? state.chapters : collectChapters()).find((c) => c.isCurrent);
    if (cur) return cur.name;
    const el = $('.catalogue-name');
    return el ? el.textContent.trim() : '';
  }

  function buildFileName(chapter) {
    const base = DL.buildBaseName({ course: courseName(), chapter: chapter || currentChapterName() });
    return base;
  }

  /* ============================================================ 面板 UI */

  function buildPanel(cssText) {
    const host = document.createElement('div');
    host.id = 'icdl-host';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>${cssText || ''}</style>
      <div class="root">
        <div class="head" data-drag>
          <span class="logo">↓</span>
          <span class="title">回放下载</span>
          <button class="hbtn" data-act="collapse" title="收起 / 展开">–</button>
          <button class="hbtn" data-act="hide" title="隐藏（点工具栏图标可再打开）">×</button>
        </div>
        <div class="body">
          <div class="status" data-level="idle"><span class="dot"></span><span data-el="status">就绪</span></div>

          <div class="label">本节媒体地址 <span data-el="kind"></span></div>
          <div class="src" data-el="src">—</div>

          <div class="row">
            <button class="btn primary" data-act="dl">下载本节</button>
            <button class="btn" data-act="probe">重新探测</button>
            <button class="btn ghost" data-act="cancel">取消</button>
          </div>

          <div class="prog"><i data-el="bar"></i></div>
          <div class="hint" data-el="hint"></div>

          <hr>

          <div class="label">批量下载</div>
          <div class="row">
            <button class="btn" data-act="scan">扫描章节</button>
            <button class="btn primary" data-act="batch">开始批量</button>
          </div>
          <label class="row-inline">
            每节加载等待
            <input class="num" data-opt="wait" type="number" min="3" max="90" step="1" value="12"> 秒
          </label>
          <div class="list" data-el="list"></div>

          <div class="row">
            <button class="btn ghost" data-act="diag">复制诊断信息</button>
          </div>
          <div class="hint">
            下载交给浏览器下载器完成，可在 <b>chrome://downloads</b> 看进度、暂停、续传。
            <b>不会</b>伪造观看进度，也不处理加密内容。
          </div>
          <!-- 提交过的下载记录（JSON）。不显示，只给自动化测试读 -->
          <span data-el="log" style="display:none"></span>
        </div>
      </div>
    `;

    const root = shadow.querySelector('.root');
    ui = {
      host,
      root,
      status: shadow.querySelector('[data-el="status"]'),
      statusBox: shadow.querySelector('.status'),
      kind: shadow.querySelector('[data-el="kind"]'),
      src: shadow.querySelector('[data-el="src"]'),
      bar: shadow.querySelector('[data-el="bar"]'),
      prog: shadow.querySelector('.prog'),
      hint: shadow.querySelector('[data-el="hint"]'),
      list: shadow.querySelector('[data-el="list"]'),
      logEl: shadow.querySelector('[data-el="log"]'),
      wait: shadow.querySelector('[data-opt="wait"]')
    };

    // 事件委托
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.getAttribute('data-act');
      if (act === 'collapse') root.classList.toggle('collapsed');
      else if (act === 'hide') setPanelHidden(true);
      else if (act === 'probe') refresh();
      else if (act === 'dl') await downloadCurrent();
      else if (act === 'cancel') await cancelDownload();
      else if (act === 'scan') await scanChapters();
      else if (act === 'batch') batchDownload();
      else if (act === 'diag') await copyDiag();
    });

    // 等待秒数持久化
    chrome.storage.local.get('icdlWait', (r) => {
      if (r && r.icdlWait) ui.wait.value = String(r.icdlWait);
    });
    ui.wait.addEventListener('change', () => {
      const n = Math.max(3, Math.min(90, Number(ui.wait.value) || 12));
      ui.wait.value = String(n);
      chrome.storage.local.set({ icdlWait: n });
    });

    // 拖动
    makeDraggable(shadow.querySelector('[data-drag]'), root);

    document.documentElement.appendChild(host);
  }


  function makeDraggable(handle, root) {
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      dragging = true;
      sx = e.clientX; sy = e.clientY;
      const r = root.getBoundingClientRect();
      ox = r.left; oy = r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const nx = Math.max(0, Math.min(window.innerWidth - 60, ox + e.clientX - sx));
      const ny = Math.max(0, Math.min(window.innerHeight - 30, oy + e.clientY - sy));
      root.style.left = nx + 'px';
      root.style.top = ny + 'px';
      root.style.right = 'auto';
    });
    document.addEventListener('mouseup', () => (dragging = false));
  }

  let toastTimer = null;
  function toast(text) {
    let el = ui.root.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      ui.root.appendChild(el);
    }
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }

  function setPanelHidden(hidden) {
    state.panelHidden = hidden;
    ui.host.style.display = hidden ? 'none' : '';
  }

  function setStatus(level, text) {
    if (ui.statusBox) ui.statusBox.setAttribute('data-level', level);
    if (ui.status) ui.status.textContent = text;
  }

  function setBar(pct, indeterminate) {
    if (!ui.prog) return;
    ui.prog.classList.toggle('indet', !!indeterminate);
    if (!indeterminate) ui.bar.style.width = (pct < 0 ? 0 : pct) + '%';
  }

  function renderKind(kind) {
    if (!ui.kind) return;
    if (kind === 'hls') ui.kind.innerHTML = '<span class="badge warn">HLS · 抓流合并</span>';
    else if (kind === 'mp4') ui.kind.innerHTML = '<span class="badge ok">直连</span>';
    else if (kind === 'blob') ui.kind.innerHTML = '<span class="badge err">blob（不可直连）</span>';
    else ui.kind.innerHTML = '<span class="badge err">未识别</span>';
  }

  function renderList() {
    if (!ui.list) return;
    const rows = state.chapters;
    if (!rows.length) {
      ui.list.innerHTML = '<div class="lrow"><span class="name">还没扫描章节</span></div>';
      return;
    }
    ui.list.innerHTML = rows
      .map((r) => {
        const cls = 'lrow' + (r.isCurrent ? ' cur' : '') + (r.state ? ' ' + r.state : '');
        const st = r.state === 'done' ? '已完成' : r.state === 'fail' ? '失败' : r.state === 'run' ? '下载中…' : r.isCurrent ? '当前' : '';
        return `<div class="${cls}"><span class="name">${escapeHtml(r.name)}</span><span class="st">${st}</span></div>`;
      })
      .join('');
  }

  function refresh() {
    const m = probeMedia();
    state.media = m.url ? { url: m.url, kind: m.kind } : null;
    if (ui.src) ui.src.textContent = m.url || '—';
    renderKind(m.kind);
    if (ui.hint) {
      ui.hint.textContent = m.url
        ? '文件名会用「课程名-章节名」，重名自动加序号。'
        : m.why || '探测不到媒体地址。';
    }
    if (!state.chapters.length) state.chapters = collectChapters();
    renderList();
    return m;
  }

  /* ============================================================ 下载 */

  async function dlStart(url, filename) {
    const r = await chrome.runtime.sendMessage({ type: 'icdl/start', url, filename });
    if (!r || !r.ok) throw new Error((r && r.error) || '下载请求被拒');
    return r.downloadId;
  }

  /** 带 credentials 抓，失败退回不带（CDN 常不允许带凭据的跨域请求） */
  async function fetchWithFallback(url) {
    try {
      return await fetch(url, { credentials: 'include' });
    } catch (e) {
      return await fetch(url, { credentials: 'omit' });
    }
  }

  /** HLS：拉播放列表 → 逐片下载 → 拼成一个 Blob 交给下载器 */
  async function fetchHlsAsBlob(playlistUrl, baseName) {
    const getText = async (u) => {
      const res = await fetchWithFallback(u);
      if (!res.ok) throw new Error('取播放列表失败 HTTP ' + res.status);
      return await res.text();
    };

    let text = await getText(playlistUrl);
    let parsed = DL.parseM3U8(text, playlistUrl);
    if (parsed.isMaster && parsed.variants.length) {
      const best = DL.pickBestVariant(parsed.variants);
      if (!best) throw new Error('播放列表里没有可用的码流');
      text = await getText(best);
      parsed = DL.parseM3U8(text, best);
    }
    if (!parsed.segments.length) throw new Error('播放列表里没有分片');
    if (DL.hlsHazards(text).encrypted) throw new Error('这一节是加密流，本插件不处理加密内容');

    const parts = [];
    let got = 0;
    for (let i = 0; i < parsed.segments.length; i++) {
      if (state.batchAbort) throw new Error('已取消');
      const r = await fetchWithFallback(parsed.segments[i]);
      if (!r.ok) throw new Error(`第 ${i + 1}/${parsed.segments.length} 个分片失败 HTTP ${r.status}`);
      parts.push(await r.blob());
      got += parts[parts.length - 1].size;
      setStatus('work', `抓第 ${i + 1}/${parsed.segments.length} 片（已 ${DL.fmtBytes(got)}）`);
      setBar(Math.floor(((i + 1) / parsed.segments.length) * 100), false);
    }
    return { url: URL.createObjectURL(new Blob(parts, { type: 'video/mp2t' })), filename: baseName + '.ts' };
  }

  async function downloadCurrent(chapterName) {
    if (state.active) {
      setStatus('warn', '已有一个下载在进行，等它结束或先点「取消」');
      return false;
    }

    // 永远实时探测，不用缓存值。
    // state.media 只在 refresh() 时更新，切节后它会是**上一节**的地址 ——
    // 用它会把上一节重复下一遍。
    const m = probeMedia();
    state.media = m.url ? { url: m.url, kind: m.kind } : null;
    if (!m || !m.url) {
      setStatus('err', (m && m.why) || '没有可下载的媒体地址');
      return false;
    }

    const base = buildFileName(chapterName);
    setStatus('work', '正在准备…');
    setBar(0, false);

    try {
      let url = m.url;
      let filename;
      let isBlob = false;

      if (DL.mediaKind(m.url) === 'hls') {
        const r = await fetchHlsAsBlob(m.url, base);
        url = r.url;
        filename = r.filename;
        isBlob = true;
      } else {
        filename = base + '.' + (DL.extFromUrl(m.url) || 'mp4');
      }

      setBar(-1, true);
      setStatus('work', '已交给浏览器下载：' + filename);
      const downloadId = await dlStart(url, filename);
      state.active = { downloadId, resolve: null, name: filename };
      logDownload(url, filename);

      if (isBlob) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) {} }, 60000);
      return true;
    } catch (e) {
      setBar(0, false);
      setStatus('err', String((e && e.message) || e));
      return false;
    }
  }

  async function cancelDownload() {
    state.batchAbort = true;
    if (state.active && state.active.downloadId != null) {
      await chrome.runtime.sendMessage({ type: 'icdl/cancel', downloadId: state.active.downloadId });
      setStatus('warn', '已取消当前下载');
    } else {
      setStatus('warn', '没有进行中的下载');
    }
    setBar(0, false);
  }

  /* ============================================================ 批量下载 */

  async function scanChapters() {
    state.chapters = collectChapters();
    renderList();
    setStatus(
      state.chapters.length ? 'ok' : 'warn',
      state.chapters.length ? `扫到 ${state.chapters.length} 节` : '页面上没找到章节清单，先把课程目录展开'
    );
    return state.chapters.length;
  }

  /** 等这一节的媒体地址出现（切节后播放器需要时间加载） */
  async function waitForMedia(timeoutMs) {
    const t0 = Date.now();
    let last = '';
    while (Date.now() - t0 < timeoutMs) {
      if (state.batchAbort) return null;
      const m = probeMedia();
      if (m.url) {
        if (m.url === last) return m; // 连续两次一样，认定已稳定
        last = m.url;
      }
      await sleep(500);
    }
    return null;
  }

  function waitActiveDownload() {
    if (!state.active) return Promise.resolve();
    return new Promise((resolve) => {
      state.active.resolve = resolve;
      // 兜底：万一状态回执丢了，最多等 30 分钟
      setTimeout(() => {
        if (state.active && state.active.resolve === resolve) {
          state.active.resolve = null;
          resolve();
        }
      }, 30 * 60 * 1000);
    });
  }

  async function batchDownload() {
    if (state.batchRunning) return;

    if (state.active) {
      setStatus('work', '等当前下载结束再开始批量…');
      await waitActiveDownload();
    }

    state.chapters = collectChapters();
    if (!state.chapters.length) {
      setStatus('err', '页面上没有章节清单，先把课程目录展开再扫描');
      return;
    }

    state.batchRunning = true;
    state.batchAbort = false;
    renderList();

    const waitSec = Math.max(3, Number(ui.wait && ui.wait.value) || 12);
    let done = 0;
    let failed = 0;
    // 连续拿不到地址的节数。章节选择器是猜的，一旦猜错了页面上别的列表，
    // 后面每一节都会白等一个 waitSec —— 没有熔断就会空转好几分钟。
    let consecutiveMiss = 0;
    let tripped = false;

    try {
      for (const ch of state.chapters) {
        if (state.batchAbort) break;
        ch.state = 'run';
        renderList();
        setStatus('work', `[${ch.i + 1}/${state.chapters.length}] ${ch.name}`);

        if (!ch.isCurrent) {
          // 优先点行内的按钮/链接，没有再点行本身
          const target = ch.row.querySelector('a,button,[role="button"]') || ch.row;
          target.click();
          await sleep(600);
        }

        const m = await waitForMedia(waitSec * 1000);
        if (!m || !m.url) {
          ch.state = 'fail';
          failed++;
          consecutiveMiss++;
          renderList();
          if (consecutiveMiss >= MISS_LIMIT) {
            tripped = true;
            break;
          }
          continue;
        }
        consecutiveMiss = 0;

        const ok = await downloadCurrent(ch.name);
        if (ok) {
          await waitActiveDownload();
          ch.state = 'done';
          done++;
        } else {
          ch.state = 'fail';
          failed++;
        }
        renderList();
      }
    } finally {
      state.batchRunning = false;
      renderList();
      setBar(0, false);

      let msg = `批量结束${state.batchAbort ? '（已取消）' : ''}：成功 ${done}，失败 ${failed}`;
      let level = failed ? 'warn' : 'ok';

      if (tripped) {
        // 连续失败到熔断：多半是章节选择器猜错了页面上别的列表，
        // 或者这些节的播放器结构不一样 —— 两种情况都该明确告诉用户
        level = 'err';
        msg += `；连续 ${MISS_LIMIT} 节都拿不到播放地址，已提前停下`;
        if (ui.hint) {
          ui.hint.textContent =
            '可能原因：扫到的「章节」其实是页面上别的列表（先看面板里列出的章节名对不对）；' +
            '或这些节需要先点开才能加载；或网络太慢，把「每节加载等待」调大再试。';
        }
      } else if (done === 0 && failed > 0) {
        msg += '；一节都没成功，建议先点「复制诊断信息」排查';
      }

      setStatus(level, msg);
    }
  }

  /* ============================================================ 诊断 */

  function collectDiag() {
    const m = probeMedia();
    return {
      页面: location.href,
      标题: document.title,
      顶层frame: window.top === window,
      视频: state.video
        ? {
            id: state.video.id || '',
            currentSrc: String(state.video.currentSrc || '').slice(0, 300),
            src: String(state.video.src || '').slice(0, 300),
            duration: state.video.duration,
            是blob地址: /^blob:/i.test(state.video.currentSrc || state.video.src || '')
          }
        : null,
      探测结果: { url: String(m.url || '').slice(0, 300), 类型: m.kind, 说明: m.why },
      章节数: (state.chapters.length ? state.chapters : collectChapters()).length,
      章节清单: (state.chapters.length ? state.chapters : collectChapters())
        .slice(0, 30)
        .map((c) => ({ 序号: c.i, 名称: c.name, 当前: c.isCurrent }))
    };
  }

  async function copyDiag() {
    const text = JSON.stringify(collectDiag(), null, 2);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch (e) {
      ok = false;
    }
    if (ok) {
      setStatus('ok', '诊断信息已复制');
      toast('诊断信息已复制，粘贴给我即可');
    } else {
      // 剪贴板被拒时退而求其次：直接显示出来让人手动复制
      if (ui.hint) ui.hint.textContent = text.slice(0, 900);
      setStatus('warn', '复制失败，已把诊断信息显示在下方');
    }
  }

  /* ============================================================ 消息 / 启动 */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;

    if (msg.type === 'icdl/toggle') {
      if (!state.video) return; // 只让找到视频的那个 frame 响应
      setPanelHidden(!state.panelHidden);
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'icdl/command' && msg.cmd === 'download') {
      downloadCurrent();
      sendResponse({ ok: true });
      return true;
    }

    if (msg.type === 'icdl/progress') {
      const pct = typeof msg.pct === 'number' ? msg.pct : -1;
      setBar(pct, pct < 0);
      if (pct >= 0) {
        setStatus(
          'work',
          `下载中 ${pct}%　${DL.fmtBytes(msg.bytesReceived)} / ${msg.totalBytes ? DL.fmtBytes(msg.totalBytes) : '未知大小'}`
        );
      }
      return;
    }

    if (msg.type === 'icdl/status') {
      if (msg.state === 'complete') {
        setBar(100, false);
        setStatus('ok', '下载完成：' + (msg.filename || '文件'));
        toast('下载完成：' + (msg.filename || ''));
      } else if (msg.state === 'interrupted') {
        setBar(0, false);
        setStatus('err', '下载中断：' + (msg.error || '未知原因'));
      } else {
        return;
      }
      if (state.active && state.active.resolve) {
        const r = state.active.resolve;
        state.active.resolve = null;
        r();
      }
      if (state.active && state.active.downloadId === msg.downloadId) state.active = null;
      return;
    }
  });

  function tick() {
    const v = pickVideo();
    if (v !== state.video) {
      state.video = v;
      if (v) refresh();
    }
  }

  async function boot() {
    // 样式从 panel.css 读进来再注入 Shadow DOM（读不到也不影响功能，只是不好看）
    let css = '';
    try {
      const res = await fetch(chrome.runtime.getURL('src/content/panel.css'));
      css = await res.text();
    } catch (e) {
      log('panel.css 读取失败：' + e.message);
    }
    buildPanel(css);
    state.video = pickVideo();
    refresh();
    setInterval(tick, 1500);
  }

  boot();
})();
