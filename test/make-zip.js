/* 把目录打成 zip，路径一律用正斜杠。
 *
 * 为什么不用 Compress-Archive / System.IO.Compression.ZipFile：
 * 它们在 Windows 上写的条目名是反斜杠（src\background.js），而 zip 规范要求正斜杠。
 * 结果是 macOS / Linux 上解压可能报错或解出带反斜杠的怪文件名。
 *
 * 用法: node test/make-zip.js <源目录> <输出zip>
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const srcDir = process.argv[2];
const outZip = process.argv[3];
if (!srcDir || !outZip) {
  console.error('用法: node test/make-zip.js <源目录> <输出zip>');
  process.exit(1);
}

/** 递归收集文件，返回 [{ rel, abs }]，rel 用正斜杠 */
function walk(dir, base) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = base ? base + '/' + entry.name : entry.name;
    if (entry.isDirectory()) out.push(...walk(abs, rel));
    else if (entry.isFile()) out.push({ rel, abs });
  }
  return out;
}

/* ---- CRC32（zip 每个条目都要带）---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const files = walk(srcDir, '');
const locals = [];
const centrals = [];
let offset = 0;

for (const f of files) {
  const data = fs.readFileSync(f.abs);
  const nameBuf = Buffer.from(f.rel, 'utf8');
  const crc = crc32(data);
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  // 压不小就直接存原文
  const useDeflate = deflated.length < data.length;
  const payload = useDeflate ? deflated : data;
  const method = useDeflate ? 8 : 0;

  // ---- 本地文件头 ----
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);   // 签名
  lh.writeUInt16LE(20, 4);           // 解压所需版本
  lh.writeUInt16LE(0x0800, 6);       // 标志位：文件名是 UTF-8
  lh.writeUInt16LE(method, 8);       // 压缩方法
  lh.writeUInt16LE(0, 10);           // 修改时间（用固定值，保证可复现）
  lh.writeUInt16LE(0x2821, 12);      // 修改日期（2020-01-01 附近）
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(payload.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nameBuf.length, 26);
  lh.writeUInt16LE(0, 28);           // 扩展字段长度
  locals.push(lh, nameBuf, payload);

  // ---- 中央目录条目 ----
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);   // 签名
  ch.writeUInt16LE(20, 4);           // 创建版本
  ch.writeUInt16LE(20, 6);           // 解压所需版本
  ch.writeUInt16LE(0x0800, 8);       // UTF-8 标志
  ch.writeUInt16LE(method, 10);
  ch.writeUInt16LE(0, 12);
  ch.writeUInt16LE(0x2821, 14);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(payload.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nameBuf.length, 28);
  ch.writeUInt16LE(0, 30);           // 扩展字段
  ch.writeUInt16LE(0, 32);           // 注释
  ch.writeUInt16LE(0, 34);           // 磁盘号
  ch.writeUInt16LE(0, 36);           // 内部属性
  ch.writeUInt32LE(0, 38);           // 外部属性
  ch.writeUInt32LE(offset, 42);      // 本地头偏移
  centrals.push(ch, nameBuf);

  offset += lh.length + nameBuf.length + payload.length;
}

const centralBuf = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(0, 4);
eocd.writeUInt16LE(0, 6);
eocd.writeUInt16LE(files.length, 8);
eocd.writeUInt16LE(files.length, 10);
eocd.writeUInt32LE(centralBuf.length, 12);
eocd.writeUInt32LE(offset, 16);
eocd.writeUInt16LE(0, 20);

fs.writeFileSync(outZip, Buffer.concat([...locals, centralBuf, eocd]));
console.log('已生成 ' + outZip);
console.log('  条目数: ' + files.length + '（路径全部使用正斜杠）');
for (const f of files) console.log('    ' + f.rel);
