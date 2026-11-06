#Requires -Version 5.1
<#
.SYNOPSIS
  构建 BOO 可视化编辑器 Windows EXE 安装程序（7-Zip SFX 自解压，运行后自动安装 VSIX）。

.DESCRIPTION
  将 VSIX 与安装器载荷（tools/release/installer/install-boo.ps1）打包为单个自解压 EXE：
    - 采用 7-Zip 安装器 SFX 模块（7zSD.sfx + 安装配置 + 7z 归档拼接）：
      双击 EXE 解压后自动执行 install-boo.cmd；
      （曾用 IExpress 打包：其 GUI 子系统与 LOLBin 属性在 GitHub windows-latest
      无头 runner 上必然静默退出码 1，与 SED 格式无关，故弃用；）
    - 安装器探测本机 VS Code（PATH / 用户级 / 系统级 / Insiders），
      通过 code --install-extension --force 安装，并以 --list-extensions 校验；
    - 未检测到 VS Code 时引导官网下载并打开解压目录供手动安装；
    - 扩展全部功能（冻结 Python 运行时、M2Reloader 原生组件、AccessBridge、数据、主题）
      均已封在 VSIX 内，EXE 不需要分发额外组件。

.PARAMETER VsixPath
  待打包的 .vsix 文件路径（必需）。

.PARAMETER OutPath
  输出 EXE 路径。默认 <ProjectRoot>\artifacts\releases\windows-installer\<name>-<version>-Setup-Windows.exe。

.PARAMETER ProjectRoot
  仓库根目录。默认取本脚本上三级目录。

.EXAMPLE
  pwsh -File tools/release/build-windows-installer.ps1 -VsixPath artifacts/releases/vscode-marketplace/boo-ngom-editor-4.4.2.vsix
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$VsixPath,

  [string]$OutPath = '',

  [string]$ProjectRoot = (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $PSCommandPath)))
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $VsixPath -PathType Leaf)) {
  throw "VSIX not found: $VsixPath"
}
$VsixPath = (Resolve-Path -LiteralPath $VsixPath).Path
$vsixName = Split-Path -Leaf $VsixPath

$manifestPath = Join-Path $ProjectRoot 'package.json'
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "package.json not found under project root: $ProjectRoot"
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$installerName = "$($manifest.name)-$($manifest.version)-Setup-Windows.exe"

if (-not $OutPath) {
  $OutPath = Join-Path $ProjectRoot "artifacts\releases\windows-installer\$installerName"
}
$OutPath = [System.IO.Path]::GetFullPath($OutPath)
$outDirectory = Split-Path -Parent $OutPath
if (-not (Test-Path -LiteralPath $outDirectory)) {
  New-Item -ItemType Directory -Path $outDirectory -Force | Out-Null
}

$installerPayload = Join-Path $ProjectRoot 'tools\release\installer\install-boo.ps1'
if (-not (Test-Path -LiteralPath $installerPayload -PathType Leaf)) {
  throw "Installer payload not found: $installerPayload"
}

# ---- 1. 组装暂存目录（IExpress SourceFiles0）----
$stageRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [System.IO.Path]::GetTempPath() }
$srcDir = Join-Path $stageRoot ("boo-sfx-src-" + [Guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $srcDir -Force | Out-Null
try {
  Copy-Item -LiteralPath $VsixPath -Destination (Join-Path $srcDir $vsixName) -Force
  # 以 UTF-8 BOM 写出载荷：Windows PowerShell 5.1 无 BOM 时按 ANSI 解码，中文提示会乱码
  $payloadText = [System.IO.File]::ReadAllText($installerPayload, [System.Text.Encoding]::UTF8)
  [System.IO.File]::WriteAllText(
    (Join-Path $srcDir 'install-boo.ps1'),
    $payloadText,
    (New-Object System.Text.UTF8Encoding($true)))

  # 自举 cmd（纯 ASCII）：IExpress 的 AppLaunched 经 cmd 执行，%~dp0 定位解压目录；
  # -STA 保证 Windows Forms 消息框可用的单线程单元模式。
  $bootstrap = @(
    '@echo off',
    'setlocal',
    'set "SDIR=%~dp0"',
    'powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "%SDIR%install-boo.ps1"',
    'exit /b %ERRORLEVEL%'
  ) -join "`r`n"
  Set-Content -LiteralPath (Join-Path $srcDir 'install-boo.cmd') -Value $bootstrap -Encoding ascii

  # ---- 2. 7z 归档：载荷位于归档根（RunProgram 在解压根执行）----
  $sevenZipCandidates = @(
    (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
    (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe')
  )
  $sevenZip = $sevenZipCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  if (-not $sevenZip) { $sevenZip = (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source }
  if (-not $sevenZip) { throw '7-Zip (7z.exe) not found: this script must run on Windows with 7-Zip installed' }

  $archivePath = Join-Path $stageRoot ("boo-sfx-archive-" + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.7z')
  & $sevenZip a -t7z $archivePath (Join-Path $srcDir '*') -mx=9 | Write-Host
  if ($LASTEXITCODE -ne 0) { throw "7z archive failed with exit code $LASTEXITCODE" }

  # ---- 3. SFX 模块与安装配置 ----
  # 现代 7-Zip（15.06+）的 7z.sfx 支持「安装器配置」（;!@Install@!UTF-8! ...
  # RunProgram），取代了旧版的 7zSD.sfx（新版安装包已不再分发）。
  # GUIMode=2：SFX 自身静默（无解压进度对话框），由 install-boo.cmd 的控制台
  # 展示安装进度与结果。
  $sfxModule = Join-Path (Split-Path -Parent $sevenZip) '7z.sfx'
  if (-not (Test-Path -LiteralPath $sfxModule -PathType Leaf)) {
    throw "7z.sfx (installer SFX module) not found next to 7z.exe: $sfxModule"
  }
  Write-Host "SFX module: $sfxModule"

  $configPath = Join-Path $stageRoot 'boo-sfx-config.txt'
  $configLines = @(
    ';!@Install@!UTF-8!',
    'Title="BOO Visual Editor Setup"',
    'RunProgram="install-boo.cmd"',
    'GUIMode="2"',
    ';!@InstallEnd@!'
  )
  [System.IO.File]::WriteAllText(
    $configPath,
    (($configLines -join "`r`n") + "`r`n"),
    (New-Object System.Text.UTF8Encoding($false)))

  # ---- 4. 拼接：SFX 模块 + 配置 + 归档 → 单文件安装 EXE ----
  $targetStream = [System.IO.File]::Create($OutPath)
  try {
    foreach ($part in @($sfxModule, $configPath, $archivePath)) {
      $bytes = [System.IO.File]::ReadAllBytes($part)
      $targetStream.Write($bytes, 0, $bytes.Length)
    }
  }
  finally { $targetStream.Dispose() }

  # ---- 5. 等待文件写入完成（大小稳定）----
  $lastSize = -1
  for ($i = 0; $i -lt 15; $i++) {
    $size = (Get-Item -LiteralPath $OutPath).Length
    if ($size -eq $lastSize -and $size -gt 0) { break }
    $lastSize = $size
    Start-Sleep -Seconds 2
  }

  if ((Get-Item -LiteralPath $OutPath).Length -lt 4096) {
    throw "Windows EXE installer suspiciously small: $OutPath ($((Get-Item -LiteralPath $OutPath).Length) bytes)"
  }

  Write-Host "Windows EXE installer ready: $OutPath ($((Get-Item -LiteralPath $OutPath).Length) bytes)"
  Write-Output $OutPath
}
finally {
  if (Test-Path -LiteralPath $srcDir) {
    Remove-Item -LiteralPath $srcDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
