#Requires -Version 5.1
<#
.SYNOPSIS
  BOO 可视化编辑器 Windows 卸载程序。

.DESCRIPTION
  与安装程序（install-boo.ps1）同源探测本机 VS Code（PATH 中的 code、
  用户级/系统级安装、Insiders 变体），通过 code CLI 卸载扩展并校验结果：
    1. 探测 VS Code CLI；
    2. 执行 code --uninstall-extension boo1213.boo-ngom-editor；
    3. 用 --list-extensions 校验扩展已从列表移除；
    4. 未检测到 VS Code 或扩展本就未安装时给出对应提示。

.NOTES
  扩展所有组件均封装在 VSIX 内并由 VS Code 管理，卸载扩展即完成全部清理，
  不存在注册表残留或独立服务。如需彻底清除设置，可手动删除 VS Code
  用户目录下的 settings.json 中 boo.* 配置项。
#>
[CmdletBinding()]
param(
  [string]$ExtensionId = 'boo1213.boo-ngom-editor',
  [string]$ExtensionNamePattern = 'boo-ngom-editor'
)

$ErrorActionPreference = 'Stop'
$Title = 'BOO 可视化编辑器 卸载程序'

function Show-Message([string]$Message, [string]$Buttons = 'OK', [string]$Icon = 'Information') {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  return [System.Windows.Forms.MessageBox]::Show($Message, $Title, $Buttons, $Icon)
}

try {
  # ---- 1. 探测 VS Code CLI（与 install-boo.ps1 相同的候选列表）----
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
    Show-Message '未检测到已安装的 VS Code，无需卸载 BOO 可视化编辑器。' 'OK' 'Information' | Out-Null
    exit 3
  }

  # ---- 2. 确认卸载 ----
  $installedBefore = & $codeCmd --list-extensions --show-versions 2>$null
  $installedText = ($installedBefore -join "`n")
  if ($installedText -notmatch [regex]::Escape($ExtensionNamePattern)) {
    Show-Message 'BOO 可视化编辑器当前未安装，无需卸载。' 'OK' 'Information' | Out-Null
    exit 0
  }
  $confirm = Show-Message (
    '即将从 VS Code 卸载“BOO UI编辑器”。' + "`n`n" +
    '工作区内的服务器文件与数据不受影响；扩展自带组件将由 VS Code 一并移除。' + "`n`n" +
    '是否继续？') 'YesNo' 'Question'
  if ($confirm -ne 'Yes') {
    exit 0
  }

  # ---- 3. 卸载扩展 ----
  & $codeCmd --uninstall-extension $ExtensionId --force
  if ($LASTEXITCODE -ne 0) {
    Show-Message (
      '扩展卸载失败（code CLI 退出码 ' + $LASTEXITCODE + '）。' + "`n`n" +
      '请关闭 VS Code 后重试；或在 VS Code 扩展面板中手动卸载。') 'OK' 'Error' | Out-Null
    exit 4
  }

  # ---- 4. 校验卸载结果 ----
  $installedAfter = & $codeCmd --list-extensions --show-versions 2>$null
  $afterText = ($installedAfter -join "`n")
  if ($afterText -match [regex]::Escape($ExtensionNamePattern)) {
    Show-Message '卸载命令已执行，但扩展仍出现在已安装列表中。请重启 VS Code 后在扩展面板确认。' 'OK' 'Warning' | Out-Null
    exit 5
  }

  # ---- 5. 完成 ----
  $launch = Show-Message (
    'BOO 可视化编辑器已成功卸载。' + "`n`n" +
    '如 VS Code 正在运行，请按 Ctrl+Shift+P 执行“Developer: Reload Window”重新加载窗口。' + "`n`n" +
    '是否现在启动 VS Code？') 'YesNo' 'Information'
  if ($launch -eq 'Yes') {
    Start-Process $codeCmd
  }
  exit 0
}
catch {
  try {
    Show-Message ('卸载过程中发生错误：' + "`n" + $_.Exception.Message) 'OK' 'Error' | Out-Null
  } catch {
    # 连消息框都无法弹出时至少留下退出码
  }
  exit 1
}
