/* src/shared/downloads.js 的单元测试。无依赖，直接 `node test/downloads.test.js`。
   重点覆盖：文件名清洗（Windows 非法字符）、扩展名/类型判定、m3u8 解析与选流、
   以及会让批量下载静默出错的边界。 */

const D = require('../src/shared/downloads.js');

let pass = 0;
const failures = [];

function eq(actual, expected, name) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    failures.push(`${name}\n    期望: ${e}\n    实际: ${a}`);
  }
}

function ok(cond, name) {
  if (cond) pass++;
  else failures.push(`${name}（条件为假）`);
}

/* ============================================================ safeName */

eq(D.safeName('第 6-8 节 主视频流'), '第 6-8 节 主视频流', 'safeName 保留中文与连字符');
eq(D.safeName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j', 'safeName 替换 Windows 非法字符');
eq(D.safeName(' 前后空白 '), '前后空白', 'safeName 去首尾空白');
eq(D.safeName('...name...'), 'name', 'safeName 去首尾点');
eq(D.safeName('___x___'), 'x', 'safeName 去首尾下划线');
eq(D.safeName(''), 'download', 'safeName 空串回退');
eq(D.safeName('   '), 'download', 'safeName 全空白回退');
eq(D.safeName(null), 'download', 'safeName null 安全');
eq(D.safeName(undefined, '兜底'), '兜底', 'safeName undefined 用 fallback');
eq(D.safeName('a\tb\nc'), 'a b c', 'safeName 折叠控制空白');
eq(D.safeName('x'.repeat(300)).length <= 120, true, 'safeName 限制长度不超过 120');

/* ============================================================ extFromUrl */

eq(D.extFromUrl('https://a.b/c/d.mp4'), 'mp4', 'extFromUrl 普通 mp4');
eq(D.extFromUrl('https://a.b/c/d.M3U8'), 'm3u8', 'extFromUrl 大写转小写');
eq(D.extFromUrl('https://a.b/c/d.mp4?x=1#y'), 'mp4', 'extFromUrl 忽略 query/hash');
eq(D.extFromUrl('https://a.b/c/d'), '', 'extFromUrl 无扩展名返回空');
eq(D.extFromUrl(''), '', 'extFromUrl 空串安全');
eq(D.extFromUrl(null), '', 'extFromUrl null 安全');

/* ============================================================ mediaKind */

eq(D.mediaKind('https://a/x.m3u8'), 'hls', 'mediaKind m3u8 → hls');
eq(D.mediaKind('https://a/x.m3u8?a=1&b=2'), 'hls', 'mediaKind m3u8 带参数');
eq(D.mediaKind('https://a/x.mp4'), 'mp4', 'mediaKind mp4 → mp4');
eq(D.mediaKind('https://a/x.flv'), 'mp4', 'mediaKind flv 归入可直连');
eq(D.mediaKind('https://a/path/mp4/1234'), 'mp4', 'mediaKind 无扩展名但路径含 /mp4/');
eq(D.mediaKind('https://a/x.jpg'), 'other', 'mediaKind 图片算 other');
eq(D.mediaKind(''), 'other', 'mediaKind 空串安全');

/* ============================================================ absUrl */

eq(D.absUrl('b.m3u8', 'https://a/x/y.m3u8'), 'https://a/x/b.m3u8', 'absUrl 相对路径');
eq(D.absUrl('/b.m3u8', 'https://a/x/y.m3u8'), 'https://a/b.m3u8', 'absUrl 根路径');
eq(D.absUrl('https://c/d.m3u8', 'https://a/x'), 'https://c/d.m3u8', 'absUrl 绝对 URL 原样');
eq(D.absUrl('b.m3u8', 'not a url'), 'b.m3u8', 'absUrl 非法 base 时原样返回');

/* ============================================================ parseM3U8: 媒体播放列表 */

const media = [
  '#EXTM3U',
  '#EXT-X-VERSION:3',
  '#EXT-X-TARGETDURATION:10',
  '#EXTINF:10.0,',
  'seg0.ts',
  '#EXTINF:10.0,',
  'sub/seg1.ts',
  '#EXTINF:9.5,',
  'https://cdn.x/seg2.ts',
  '#EXT-X-ENDLIST'
].join('\n');

const pm = D.parseM3U8(media, 'https://v.x/a/b.m3u8');
eq(pm.isMaster, false, 'parseM3U8 媒体列表不认成 master');
eq(pm.segments.length, 3, 'parseM3U8 解析出 3 个分片');
eq(pm.segments[0], 'https://v.x/a/seg0.ts', 'parseM3U8 同目录相对路径');
eq(pm.segments[1], 'https://v.x/a/sub/seg1.ts', 'parseM3U8 子目录相对路径');
eq(pm.segments[2], 'https://cdn.x/seg2.ts', 'parseM3U8 绝对 URL 保留');
eq(pm.variants.length, 0, 'parseM3U8 媒体列表没有变体');

/* ============================================================ parseM3U8: master */

const master = [
  '#EXTM3U',
  '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360',
  'low/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720',
  'high/index.m3u8',
  '#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=960x540',
  'mid/index.m3u8'
].join('\n');

const pM = D.parseM3U8(master, 'https://v.x/c/master.m3u8');
eq(pM.isMaster, true, 'parseM3U8 认出 master');
eq(pM.variants.length, 3, 'parseM3U8 解析出 3 路变体');
eq(pM.variants[1].bandwidth, 2400000, 'parseM3U8 解析 BANDWIDTH');
eq(pM.variants[1].resolution, '1280x720', 'parseM3U8 解析 RESOLUTION');
eq(pM.variants[0].url, 'https://v.x/c/low/index.m3u8', 'parseM3U8 变体 URL 相对解析');
eq(D.pickBestVariant(pM.variants), 'https://v.x/c/high/index.m3u8', 'pickBestVariant 选最高码率');

// 带宽相同时按分辨率决胜
const tie = D.parseM3U8(
  [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=640x360',
    'a.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1920x1080',
    'b.m3u8'
  ].join('\n'),
  'https://v.x/'
);
eq(D.pickBestVariant(tie.variants), 'https://v.x/b.m3u8', 'pickBestVariant 带宽相同比分辨率');

eq(D.pickBestVariant([]), '', 'pickBestVariant 空数组返回空');
eq(D.pickBestVariant(null), '', 'pickBestVariant null 安全');

/* 变体条目缺 URI 行时不能产出空 URL 的变体 */
const broken = D.parseM3U8(
  ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=500'].join('\n'),
  'https://v.x/'
);
eq(broken.variants.length, 0, 'parseM3U8 没有 URI 行时不产出变体');

/* ============================================================ hlsHazards */

const hzPlain = D.hlsHazards(media);
eq(hzPlain.encrypted, false, 'hlsHazards 明文流不报加密');
eq(hzPlain.ended, true, 'hlsHazards 认出 EXT-X-ENDLIST（点播）');
eq(hzPlain.isLive, false, 'hlsHazards 有 ENDLIST 时不算直播');

ok(D.hlsHazards('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"').encrypted, 'hlsHazards 认出 AES-128 加密');
ok(D.hlsHazards('#EXTM3U\n#EXT-X-KEY:METHOD=SAMPLE-AES').encrypted, 'hlsHazards 认出 SAMPLE-AES 加密');
eq(D.hlsHazards('#EXTM3U\n#EXT-X-KEY:METHOD=NONE').encrypted, false, 'hlsHazards METHOD=NONE 不算加密');
ok(D.hlsHazards('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,').isLive, 'hlsHazards 无 ENDLIST 判定为直播');
ok(D.hlsHazards('#EXTM3U\n#EXT-X-MAP:URI="init.mp4"').hasMap, 'hlsHazards 认出 EXT-X-MAP（fMP4）');
eq(D.hlsHazards('').encrypted, false, 'hlsHazards 空串安全');

/* ============================================================ fmtBytes */

eq(D.fmtBytes(0), '0 B', 'fmtBytes 0');
eq(D.fmtBytes(512), '512 B', 'fmtBytes 字节');
eq(D.fmtBytes(1024), '1.0 KB', 'fmtBytes KB');
eq(D.fmtBytes(1536), '1.5 KB', 'fmtBytes 小数');
eq(D.fmtBytes(1048576), '1.0 MB', 'fmtBytes MB');
eq(D.fmtBytes(1073741824), '1.0 GB', 'fmtBytes GB');
eq(D.fmtBytes(120 * 1024 * 1024), '120 MB', 'fmtBytes 超过 100 不显示小数');
eq(D.fmtBytes(-1), '—', 'fmtBytes 负数');
eq(D.fmtBytes(NaN), '—', 'fmtBytes NaN');
eq(D.fmtBytes(null), '0 B', 'fmtBytes null 当 0');

/* ============================================================ buildBaseName */

eq(D.buildBaseName({ course: '程序设计', chapter: '第 6-8 节' }), '程序设计-第 6-8 节', 'buildBaseName 课程+章节');
eq(D.buildBaseName({ chapter: '第 3 讲' }), '第 3 讲', 'buildBaseName 只有章节');
eq(D.buildBaseName({ course: '程序设计' }), '程序设计', 'buildBaseName 只有课程');
eq(D.buildBaseName({ course: 'X', chapter: 'X' }), 'X', 'buildBaseName 同名不重复拼接');
eq(D.buildBaseName({}), 'icourse-视频', 'buildBaseName 空输入回退');
eq(D.buildBaseName(null), 'icourse-视频', 'buildBaseName null 安全');
ok(!D.buildBaseName({ chapter: 'a/b:c' }).includes('/'), 'buildBaseName 结果不含路径分隔符');

/* ============================================================ chapterOrder */

eq(D.chapterOrder('第 3 讲'), 3, 'chapterOrder 提取数字');
eq(D.chapterOrder('第 12 讲'), 12, 'chapterOrder 两位数');
eq(D.chapterOrder('第 6-8 节'), 6, 'chapterOrder 取第一个数字');
eq(D.chapterOrder('引言'), Number.MAX_SAFE_INTEGER, 'chapterOrder 无数字排最后');
ok(D.chapterOrder('第 12 讲') > D.chapterOrder('第 3 讲'), 'chapterOrder 是按数值不是字符串');

/* ============================================================ withIndex */

eq(D.withIndex('a.mp4', 0, 1), 'a.mp4', 'withIndex 单个不加前缀');
eq(D.withIndex('a.mp4', 0, 12), '01-a.mp4', 'withIndex 补零对齐');
eq(D.withIndex('a.mp4', 11, 12), '12-a.mp4', 'withIndex 最后一项');

/* ============================================================ 结果 */

if (failures.length) {
  console.log(`通过 ${pass} 项，失败 ${failures.length} 项\n`);
  for (const f of failures) console.log('  ✗ ' + f + '\n');
  process.exitCode = 1;
} else {
  console.log(`通过 ${pass} 项，失败 0 项`);
  console.log('downloads 全部通过 ✓');
}
