import * as path from 'path';

export type SavedMapMarkerFiles = Record<string, string>;

/**
 * 地图标识路径来自 VS Code 工作区（主要平台为 Windows，形如 D:\MirServer）。
 * Windows 绝对路径按 Windows 语义原样规范化，其余路径按宿主语义解析，
 * 避免在 Linux/macOS 上把盘符路径误拼到当前目录。
 */
function normalizeMarkerPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return /^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith('\\\\')
    ? path.win32.normalize(trimmed)
    : path.resolve(trimmed);
}

export function mapMarkerWorkspaceKey(workspaceRoot: string | undefined): string {
  const root = String(workspaceRoot || '').trim();
  return root ? normalizeMarkerPath(root).toLocaleLowerCase() : '';
}

export function resolveSavedMapMarkerFile(
  workspaceValue: string | undefined,
  savedByWorkspace: SavedMapMarkerFiles,
  workspaceRoot: string | undefined
): string {
  const localValue = String(workspaceValue || '').trim();
  if (localValue) return normalizeMarkerPath(localValue);
  const key = mapMarkerWorkspaceKey(workspaceRoot);
  const globalValue = key ? String(savedByWorkspace?.[key] || '').trim() : '';
  return globalValue ? normalizeMarkerPath(globalValue) : '';
}

export function rememberMapMarkerFile(
  savedByWorkspace: SavedMapMarkerFiles,
  workspaceRoot: string | undefined,
  markerFile: string
): SavedMapMarkerFiles {
  const key = mapMarkerWorkspaceKey(workspaceRoot);
  if (!key) throw new Error('未打开工作区，无法保存地图标识路径');
  const filePath = String(markerFile || '').trim();
  if (!filePath) throw new Error('地图标识路径不能为空');
  return { ...savedByWorkspace, [key]: normalizeMarkerPath(filePath) };
}
