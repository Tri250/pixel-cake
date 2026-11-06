#Requires -Version 5.1
<#
.SYNOPSIS
  BOO 可视化编辑器 Windows 安装程序载荷（由 IExpress 自解压 EXE 调用）。

.DESCRIPTION
  自解压 EXE 释放本脚本与 VSIX 到临时目录后执行本脚本：
    1. 在脚本同目录查找 *.vsix 安装包；
    2. 探测本机 VS Code 安装（PATH 中的 code、用户级/系统级安装、Insiders 变体）；
    3. 通过 code CLI 以 --force 安装 VSIX，并用 --list-extensions 校验安装结果；
    4. 未检测到 VS Code 时引导下载，并打开 VSIX 所在目录供手动安装；
    5. 安装成功后可选直接启动 VS Code。

.NOTES
  扩展的全部功能（冻结 Python 运行时、M2Reloader 原生组件、AccessBridge、数据与主题）
  均已封装在 VSIX 内，本安装器无需分发额外组件。
#>
[CmdletBinding()]
param(
  [string]$VsixPath = '',
  [string]$ExtensionNamePattern = 'boo-ngom-editor'
)

$ErrorActionPreference = 'Stop'
$Title = 'BOO 可视化编辑器 安装程序'

function Show-Message([string]$Message, [string]$Buttons = 'OK', [string]$Icon = 'Information') {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  return [System.Windows.Forms.MessageBox]::Show($Message, $Title, $Buttons, $Icon)
}

try {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

  # ---- 1. 定位 VSIX ----
  if (-not $VsixPath -or -not (Test-Path -LiteralPath $VsixPath -PathType Leaf)) {
    $found = Get-ChildItem -LiteralPath $scriptDir -Filter *.vsix -File | Select-Object -First 1
    if ($found) { $VsixPath = $found.FullName }
  }
  if (-not $VsixPath -or -not (Test-Path -LiteralPath $VsixPath -PathType Leaf)) {
    Show-Message ('未找到 BOO 安装包（.vsix）。' + "`n" + '请重新下载完整安装程序后重试。') 'OK' 'Error' | Out-Null
    exit 2
  }
  $VsixPath = (Resolve-Path -LiteralPath $VsixPath).Path

  # ---- 2. 探测 VS Code CLI ----
  $candidates = New-Object System.Collections.Generic.List[string]
  $pathCommand = Get-Command 'code' -ErrorAction SilentlyContinue
  if ($pathCommand) { $candidates.Add($pathCommand.Source) }
  $knownRoots = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\bin\code.cmd'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code Insiders\bin\code-insiders.cmd'),
    (Join-Path $env:ProgramFiles 'Microsoft VS Code\bin\code.cmd'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\bin\code.cmd')
  )
  foreach ($root in $knownRoots) {
    if ($root -and (Test-Path -LiteralPath $root -PathType Leaf)) { $candidates.Add($root) }
  }
  $codeCmd = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1

  if (-not $codeCmd) {
    $answer = Show-Message (
      '未检测到已安装的 VS Code。' + "`n`n" +
      'BOO 是 VS Code 扩展，需要先安装 VS Code 1.68 或更高版本。' + "`n" +
      '选择“是”打开 VS Code 官网下载页面；随后可手动双击本程序同目录下的 .vsix 文件，' + "`n" +
      '或在 VS Code 扩展面板选择“从 VSIX 安装”。' + "`n`n" +
      '是否现在打开官网下载页面？') 'YesNo' 'Warning'
    if ($answer -eq 'Yes') {
      Start-Process 'https://code.visualstudio.com/'
    }
    if (Test-Path -LiteralPath $scriptDir) {
      Start-Process explorer.exe $scriptDir
    }
    exit 3
  }

  # ---- 3. 安装 VSIX ----
  & $codeCmd --install-extension $VsixPath --force
  if ($LASTEXITCODE -ne 0) {
    Show-Message (
      '扩展安装失败（code CLI 退出码 ' + $LASTEXITCODE + '）。' + "`n`n" +
      '请关闭 VS Code 后重试；或在 VS Code 扩展面板选择“…” → “从 VSIX 安装…”，' + "`n" +
      '手动选择本程序同目录下的 .vsix 文件。') 'OK' 'Error' | Out-Null
    exit 4
  }

  # ---- 4. 校验安装结果 ----
  $installed = & $codeCmd --list-extensions --show-versions 2>$null
  $installedText = ($installed -join "`n")
  if ($installedText -notmatch [regex]::Escape($ExtensionNamePattern)) {
    Show-Message (
      '安装命令已执行，但未在已安装扩展列表中找到 BOO 编辑器。' + "`n`n" +
      '请在 VS Code 扩展面板确认“BOO UI编辑器”存在；如不存在，' + "`n" +
      '请选择“…” → “从 VSIX 安装…”手动选择 .vsix 文件。') 'OK' 'Warning' | Out-Null
    exit 5
  }

  # ---- 5. 完成 ----
  $launch = Show-Message (
    'BOO 可视化编辑器安装完成。' + "`n`n" +
    '如 VS Code 正在运行，请按 Ctrl+Shift+P 执行“Developer: Reload Window”重新加载窗口。' + "`n`n" +
    '是否现在启动 VS Code？') 'YesNo' 'Information'
  if ($launch -eq 'Yes') {
    Start-Process $codeCmd
  }
  exit 0
}
catch {
  try {
    Show-Message ('安装过程中发生错误：' + "`n" + $_.Exception.Message) 'OK' 'Error' | Out-Null
  } catch {
    # 连消息框都无法弹出时至少留下退出码
  }
  exit 1
}
