/* 极简 fixture 服务器：给端到端测试用。
 *   /                     -> test/fixture/index.html（模拟课程页）
 *   /mock-video.mp4       -> 一个很小的假 mp4（只用来让 <video> 有地址）
 *   其他                  -> 按路径当静态文件返回
 *
 * 用法: node test/serve.js [port]
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const port = Number(process.argv[2] || 8796);
const root = path.join(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixture');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4',
  '.vtt': 'text/vtt; charset=utf-8'
};

/* 最小可用的 mp4 头（ftyp + 空 moov 占位）。
   浏览器不一定要真的解码成功 —— 这里只要 <video> 能拿到一个地址即可。 */
const FAKE_MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18]),
  Buffer.from('ftypisom'),
  Buffer.from([0x00, 0x00, 0x02, 0x00]),
  Buffer.from('isomiso2avc1mp41'),
  Buffer.from([0x00, 0x00, 0x00, 0x08]),
  Buffer.from('free')
]);

/** 把文件发出去，带上正确的 Content-Type */
function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found: ' + file);
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  if (url === '/' || url === '/index.html') {
    sendFile(res, path.join(fixtureDir, 'index.html'));
    return;
  }

  if (url === '/hold') {
    // 故意拖住 load 事件：--dump-dom 会等 load，
    // 这样扩展的异步请求（读 panel.css）有机会先跑完。
    const ms = Math.min(20000, Number(new URL(req.url, 'http://x').searchParams.get('ms')) || 5000);
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64'));
    }, ms);
    return;
  }

  // 两个假视频：第二个用来验证"切节之后下的是新地址，而不是上一节的旧地址"
  if (url === '/mock-video.mp4' || url === '/mock-video-2.mp4') {
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Content-Length': FAKE_MP4.length,
      'Accept-Ranges': 'bytes'
    });
    res.end(FAKE_MP4);
    return;
  }

  // 先在 fixture 目录里找，再回落到仓库根（扩展自己的文件，比如 panel.css）。
  // 以前这里只判断了 "/" 和 "/index.html"，其它页面文件名会被拼到仓库根上，直接 404。
  const rel = url.replace(/^\/+/, '');
  const inFixture = path.join(fixtureDir, rel);
  const inRoot = path.join(root, rel);
  const file = fs.existsSync(inFixture) ? inFixture : inRoot;

  // 防目录穿越
  const rp = path.resolve(file);
  if (!rp.startsWith(path.resolve(root)) && !rp.startsWith(path.resolve(fixtureDir))) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  sendFile(res, file);
});

server.listen(port, '127.0.0.1', () => {
  console.log('fixture 服务器: http://127.0.0.1:' + port + '/');
});
