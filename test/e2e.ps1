# 端到端测试：真实浏览器加载扩展，打开本地模拟课程页，验证下载面板整条链路。
#
#   powershell -File test/e2e.ps1
#
# 断言：
#   1. 面板被注入并构建
#   2. 检测到课程视频
#   3. 「重新探测」拿到媒体地址，且识别为「直连」
#   4. 「扫描章节」扫出全部章节行，且只高亮当前节
#   5. 「下载本节」真的把请求交给了浏览器下载器
#      —— fixture 里那个 mp4 是假的，所以下载器会回报失败；
#         面板上能看到那个失败，恰恰证明整条链路通了。
#         如果请求根本没发出去，面板只会停在「正在准备…」。
#
# 本文件必须保存为 UTF-8 带 BOM，否则 Windows PowerShell 5.1 会按 ANSI 解析中文而崩。

param(
  [int]$Port = 8796,
  [string]$Browser
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$work = Join-Path $root '.e2e'
New-Item -ItemType Directory -Force -Path $work | Out-Null

if (-not $Browser) {
  $cands = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  )
  $Browser = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
}
if (-not $Browser) { throw '没找到 Chrome 或 Edge' }
Write-Host "浏览器: $Browser"

$server = $null
try {
  $server = Start-Job -ScriptBlock { param($r, $p) Set-Location $r; node test/serve.js $p } -ArgumentList $root, $Port

  $up = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try { Invoke-WebRequest "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 3 | Out-Null; $up = $true; break } catch {}
  }
  if (-not $up) { throw "fixture 服务器没能在端口 $Port 起来" }

  node (Join-Path $root 'test/make-test-build.js') (Join-Path $work 'ext') $Port | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'make-test-build 失败' }

  $dom = Join-Path $work 'dom.html'
  $err = Join-Path $work 'err.txt'
  $bat = Join-Path $work 'run.bat'
  $line = '"' + $Browser + '" --headless=new --disable-gpu --no-first-run --no-default-browser-check' +
    ' --user-data-dir="' + $work + '\profile"' +
    ' --load-extension="' + $work + '\ext"' +
    ' --disable-extensions-except="' + $work + '\ext"' +
    ' --dump-dom "http://127.0.0.1:' + $Port + '/index.html" > "' + $dom + '" 2> "' + $err + '"'
  Set-Content -Path $bat -Value @('@echo off', $line) -Encoding ASCII

  Remove-Item (Join-Path $work 'profile') -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $dom, $err -Force -ErrorAction SilentlyContinue
  if (Test-Path $dom) { throw '无法删除上一次的 dom.html，会读到陈旧结果，已中止' }

  $startedAt = Get-Date
  cmd /c $bat

  if (-not (Test-Path $dom) -or (Get-Item $dom).Length -eq 0) {
    Get-Content $err -TotalCount 10 -ErrorAction SilentlyContinue
    throw '浏览器没有输出 DOM（很可能是沙箱不允许 Chromium 启动）'
  }
  if ((Get-Item $dom).LastWriteTime -lt $startedAt) { throw 'dom.html 早于本次运行，浏览器并未产出结果' }

  $html = Get-Content $dom -Raw -Encoding UTF8
  # 取最后一条 RESULT（页面会反复上报，最后一条信息最全）；同时报出阶段名便于排错
  $all = [regex]::Matches($html, 'RESULT\[(\w+)\]=(\{.*?\})</div>')
  if ($all.Count -eq 0) { throw '页面没上报 RESULT —— 内容脚本可能没注入' }
  $m = $all[$all.Count - 1]
  $phase = $m.Groups[1].Value
  $o = $m.Groups[2].Value | ConvertFrom-Json
  Write-Host ("  读到 RESULT[{0}]（共 {1} 条上报）" -f $phase, $all.Count)

  $checks = [ordered]@{
    'fixture 版本匹配'      = ($o.fixtureVersion -eq 1)
    '面板已注入并构建'      = [bool]$o.panelBuilt
    '检测到课程视频'        = ($o.videoCount -eq 1)
    '探测到媒体地址'        = ($o.src -like '*mock-video.mp4*')
    '识别为直连'            = ($o.kind -like '*直连*')
    '扫出全部章节行'        = ($o.chapterRows -eq 3)
    '只高亮当前节'          = ($o.currentMarked -eq 1)
    '下载请求已交给下载器'  = ($o.statusAfterDownload -like '*下载完成*' -or $o.statusAfterDownload -like '*下载中断*')
    '下载按钮没卡在准备中'  = ($o.statusAfterDownload -notlike '*正在准备*')
    # 少了 web_accessible_resources 时注入 Shadow DOM 的 <style> 会是空的，
    # 面板看上去就是一堆没样式的原生 HTML —— 这条专门守它
    '面板样式已生效'        = ($o.panelHasStyles -eq $true)
    # 换掉视频地址后再下载，提交的必须是**新**地址。
    # 旧实现用的是面板上缓存的 state.media，这里会重复提交旧地址。
    '切节后下的是新地址'    = (($o.downloadedUrls -join ',') -like '*mock-video-2.mp4*')
    '旧地址只下过一次'      = (($o.downloadedUrls | Where-Object { $_ -like '*mock-video.mp4' }).Count -eq 1)
  }

  $bad = 0
  foreach ($k in $checks.Keys) {
    if ($checks[$k]) { Write-Host "  ✓ $k" -ForegroundColor Green }
    else { Write-Host "  ✗ $k" -ForegroundColor Red; $bad++ }
  }

  Write-Host ''
  Write-Host ("  实测媒体地址 = {0}" -f $o.src)
  Write-Host ("  实测类型     = {0}" -f $o.kind)
  Write-Host ("  实测章节     = {0} 行、高亮 {1} 行" -f $o.chapterRows, $o.currentMarked)
  Write-Host ("  实测下载状态 = {0}" -f $o.statusAfterDownload)
  Write-Host ("  实测样式生效 = {0}" -f $o.panelHasStyles)
  Write-Host ("  实测下载目标 = {0}" -f (($o.downloadedUrls -join '  |  ')))
  Write-Host ''
  if ($bad) { Write-Host "端到端测试失败 $bad 项" -ForegroundColor Red; exit 1 }
  Write-Host '端到端测试全部通过 ✓' -ForegroundColor Green
}
finally {
  if ($server) {
    Stop-Job $server -ErrorAction SilentlyContinue
    Remove-Job $server -Force -ErrorAction SilentlyContinue
  }
}
