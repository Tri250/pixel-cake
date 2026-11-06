#Requires -Version 5.1
<#
.SYNOPSIS
  构建 BOO 可视化编辑器 Windows EXE 安装程序（IExpress 自解压，运行后自动安装 VSIX）。

.DESCRIPTION
  将 VSIX 与安装器载荷（tools/release/installer/install-boo.ps1）打包为单个自解压 EXE：
    - 用户双击 EXE 后自动解压并执行 install-boo.ps1；
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

  # ---- 2. 生成 IExpress SED（向导原生 SEDVersion=3 格式；全部 ASCII）----
  # 采用 iexpress 向导自身生成的指令格式（%占位符 + [Strings] 分节 +
  # SourceFiles=SourceFiles 指向 + 完整 [Options] 字段）。精简的
  # SEDVersion=1 直写格式在 CI 无头环境下会被解析器静默拒绝（退出码 1）。
  # 注意：SED 解析器要求 CRLF 行尾；路径含空格时在 [Strings] 里加引号。
  $sedPath = Join-Path $stageRoot 'boo-setup.sed'
  $sedValue = { param([string]$v) if ($v -match '\s') { '"' + $v + '"' } else { $v } }
  $sedLines = @(
    '[Version]',
    'Class=IEXPRESS',
    'SEDVersion=3',
    '',
    '[Options]',
    'PackagePurpose=InstallApp',
    'ShowInstallProgramWindow=0',
    'HideExtractAnimation=0',
    'UseLongFileName=1',
    'InsideCompressed=0',
    'CAB_FixedSize=0',
    'CAB_ResvCodeSigning=0',
    'RebootMode=N',
    'InstallPrompt=%InstallPrompt%',
    'DisplayLicense=%DisplayLicense%',
    'FinishMessage=%FinishMessage%',
    'TargetName=%TargetName%',
    'FriendlyName=%FriendlyName%',
    'AppLaunched=%AppLaunched%',
    'PostInstallCmd=%PostInstallCmd%',
    'AdminQuietInstCmd=%AdminQuietInstCmd%',
    'UserQuietInstCmd=%UserQuietInstCmd%',
    'SourceFiles=SourceFiles',
    '',
    '[Strings]',
    'InstallPrompt=',
    'DisplayLicense=',
    'FinishMessage=',
    (& $sedValue ('TargetName=' + $OutPath)),
    (& $sedValue ('FriendlyName=BOO Visual Editor Setup')),
    (& $sedValue ('AppLaunched=cmd /c install-boo.cmd')),
    'PostInstallCmd=<None>',
    'AdminQuietInstCmd=',
    'UserQuietInstCmd=',
    "FILE0=`"$vsixName`"",
    'FILE1="install-boo.cmd"',
    'FILE2="install-boo.ps1"',
    '',
    '[SourceFiles]',
    (& $sedValue ('SourceFiles0=' + (Join-Path $srcDir ''))),
    '',
    '[SourceFiles0]',
    '%FILE0%=',
    '%FILE1%=',
    '%FILE2%='
  )
  [System.IO.File]::WriteAllText(
    $sedPath,
    (($sedLines -join "`r`n") + "`r`n"),
    [System.Text.Encoding]::ASCII)

  # x86 iexpress（SysWOW64）：产物可在 x86/x64 Windows 通用运行，行为与向导一致；
  # 64 位 iexpress 在部分系统上打包异常。缺失时回退 System32。
  $iexpress = if ($env:SystemRoot) { Join-Path $env:SystemRoot 'SysWOW64\iexpress.exe' } else { $null }
  if (-not $iexpress -or -not (Test-Path -LiteralPath $iexpress -PathType Leaf)) {
    $iexpress = if ($env:SystemRoot) { Join-Path $env:SystemRoot 'System32\iexpress.exe' } else { $null }
  }
  if (-not $iexpress -or -not (Test-Path -LiteralPath $iexpress -PathType Leaf)) {
    throw "iexpress.exe not found (this script must run on Windows): $iexpress"
  }

  # ---- 3. 同步执行 iexpress（/Q 静默模式；捕获 stdout/stderr 作为唯一线索）----
  $iexpressStdout = Join-Path $stageRoot 'iexpress-stdout.log'
  $iexpressStderr = Join-Path $stageRoot 'iexpress-stderr.log'
  $proc = Start-Process -FilePath $iexpress `
    -ArgumentList "/N /Q `"$sedPath`"" `
    -WindowStyle Hidden -PassThru -Wait `
    -RedirectStandardOutput $iexpressStdout -RedirectStandardError $iexpressStderr
  Write-Host "iexpress ($iexpress) exit code: $($proc.ExitCode)"
  if ((Test-Path -LiteralPath $iexpressStdout) -and ((Get-Item -LiteralPath $iexpressStdout).Length -gt 0)) {
    Write-Host '--- iexpress stdout ---'
    Get-Content -LiteralPath $iexpressStdout | Write-Host
  }
  if ((Test-Path -LiteralPath $iexpressStderr) -and ((Get-Item -LiteralPath $iexpressStderr).Length -gt 0)) {
    Write-Host '--- iexpress stderr ---'
    Get-Content -LiteralPath $iexpressStderr | Write-Host
  }

  # ---- 4. 产物落点兜底：iexpress 可能把 EXE 写到其他路径 ----
  if (-not (Test-Path -LiteralPath $OutPath -PathType Leaf)) {
    $found = Get-ChildItem -Path $stageRoot, $ProjectRoot -Recurse -Filter '*-Setup-Windows.exe' -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending |
      Select-Object -First 1
    if ($found) {
      Write-Host "EXE found at $($found.FullName), moving to $OutPath"
      Move-Item -LiteralPath $found.FullName -Destination $OutPath -Force
    }
  }

  if (-not (Test-Path -LiteralPath $OutPath -PathType Leaf)) {
    Write-Host '=== SED content (for diagnosis) ==='
    Get-Content -LiteralPath $sedPath | Write-Host
    throw "Windows EXE installer was not created: $OutPath (iexpress exit code: $($proc.ExitCode))"
  }

  # ---- 5. 等待文件写入完成（大小稳定）----
  $lastSize = -1
  for ($i = 0; $i -lt 30; $i++) {
    $size = (Get-Item -LiteralPath $OutPath).Length
    if ($size -eq $lastSize -and $size -gt 0) { break }
    $lastSize = $size
    Start-Sleep -Seconds 2
  }

  Write-Host "Windows EXE installer ready: $OutPath ($((Get-Item -LiteralPath $OutPath).Length) bytes)"
  Write-Output $OutPath
}
finally {
  if (Test-Path -LiteralPath $srcDir) {
    Remove-Item -LiteralPath $srcDir -Recurse -Force -ErrorAction SilentlyContinue
  }
}
