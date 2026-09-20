/* Service Worker：把内容脚本请求的媒体地址交给浏览器下载器，并把进度回传。
 *
 * 为什么下载必须放在这里：chrome.downloads 只有扩展的 background 能用，
 * 内容脚本里没有这个 API。
 *
 * 用浏览器下载器而不是自己 fetch 再拼 blob 的好处：
 *   - 大文件不占内存（三小时的课也就几百 MB，不会把页面拖垮）
 *   - 支持暂停 / 续传，进度在 chrome://downloads 里也能看
 *   - 下载目录就是浏览器的默认下载目录
 */

/* ------------------------------------------------------------ 下载通道 */

/** downloadId -> { tabId, filename } —— 用来把 onChanged 回报给发起它的标签页 */
const jobs = new Map();

/** downloadId -> 上次上报的百分比，避免每秒都刷面板 */
const lastPct = new Map();

async function startDownload(msg) {
  const { url, filename } = msg;
  if (!url) throw new Error('下载请求缺少 url');

  const downloadId = await chrome.downloads.download({
    url,
    filename: filename || undefined,
    saveAs: false,
    // 重名时自动加序号，不覆盖已有文件
    conflictAction: 'uniquify'
  });
  console.log('[回放下载器] 已提交下载 id=' + downloadId + ' -> ' + filename);
  return downloadId;
}

function sendToTab(tabId, msg) {
  if (tabId == null || tabId < 0) return;
  // 目标标签页可能已经关掉了，sendMessage 会 reject —— 吞掉即可
  chrome.tabs.sendMessage(tabId, msg).catch(() => {});
}

chrome.downloads.onChanged.addListener((delta) => {
  const job = jobs.get(delta.id);
  if (!job) return;
  const st = delta.state && delta.state.current;
  if (st === 'complete' || st === 'interrupted') {
    jobs.delete(delta.id);
    lastPct.delete(delta.id);
    sendToTab(job.tabId, {
      type: 'icdl/status',
      downloadId: delta.id,
      state: st,
      error: (delta.error && delta.error.current) || '',
      filename: job.filename
    });
  }
});

/* chrome.downloads 没有 progress 事件，只能轮询 */
setInterval(async () => {
  if (!jobs.size) return;
  for (const [id, job] of jobs) {
    try {
      const [item] = await chrome.downloads.search({ id });
      if (!item) continue;
      const got = item.bytesReceived || 0;
      const total = item.totalBytes || 0;
      const pct = total > 0 ? Math.floor((got / total) * 100) : -1;
      if (pct === lastPct.get(id)) continue;
      lastPct.set(id, pct);
      sendToTab(job.tabId, {
        type: 'icdl/progress',
        downloadId: id,
        bytesReceived: got,
        totalBytes: total,
        pct
      });
    } catch (e) {
      /* 条目可能被用户从下载列表里删了，忽略 */
    }
  }
}, 1000);

/* ------------------------------------------------------------ 消息入口 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  const tabId = sender.tab && sender.tab.id;

  if (msg.type === 'icdl/start') {
    console.log('[回放下载器] 收到下载请求 filename=' + msg.filename);
    startDownload(msg)
      .then((downloadId) => {
        jobs.set(downloadId, { tabId, filename: msg.filename || '' });
        sendResponse({ ok: true, downloadId });
      })
      .catch((e) => {
        console.log('[回放下载器] 下载请求失败：' + String((e && e.message) || e));
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      });
    return true; // 异步响应
  }

  if (msg.type === 'icdl/cancel') {
    (async () => {
      try {
        await chrome.downloads.cancel(msg.downloadId);
      } catch (e) {
        /* 已结束的下载取消会抛，忽略 */
      }
      jobs.delete(msg.downloadId);
      lastPct.delete(msg.downloadId);
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg.type === 'icdl/log') {
    // 内容脚本的排错日志，方便用户在扩展的「服务工作进程」控制台里看
    console.log('[iCourse 回放下载器]', msg.text);
    sendResponse({ ok: true });
    return true;
  }
});

/* ------------------------------------------- 工具栏图标：显示 / 隐藏面板 */

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  chrome.tabs
    .sendMessage(tab.id, { type: 'icdl/toggle' })
    .catch(() => {
      /* 不是 icourse 页面，没有内容脚本，忽略 */
    });
});

/* -------------------------------------------------- 安装时的右键菜单 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'icdl-download',
      title: '下载本节回放',
      contexts: ['video', 'page']
    });
    chrome.contextMenus.create({
      id: 'icdl-toggle',
      title: '显示/隐藏下载面板',
      contexts: ['page']
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;
  if (info.menuItemId === 'icdl-download') {
    chrome.tabs.sendMessage(tab.id, { type: 'icdl/command', cmd: 'download' }).catch(() => {});
  } else if (info.menuItemId === 'icdl-toggle') {
    chrome.tabs.sendMessage(tab.id, { type: 'icdl/toggle' }).catch(() => {});
  }
});
