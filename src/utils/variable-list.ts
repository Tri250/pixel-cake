import * as fs from 'fs';
import * as path from 'path';
import { ScriptTextSpan } from './command-arguments';
import { isOffsetInTextRanges } from './map-code-context';
import {
  analyzeNestedVariables, isNestedVariableBaseOffset, NestedVariableAnalysisOptions,
  NestedVariableResolutionStatus, normalizeNestedVariableReference, normalizePersonalFlagReference,
} from './nested-variable-analysis';
import { isScriptCommentLine } from './script-labels';
import { decodeTextFile } from './text';
import { compactVariableTypeLabel, findScriptVariables, findSemanticScriptVariables, normalizeScriptVariableName, recordVariableUsage } from './variable-statistics';
import { CandidateUsage, collectCandidateUsage, createCandidateUsage, mergeCandidateUsage, personalFlagRangeForEngine } from './variable-candidates';
import { EngineId } from '../types';

const SCRIPT_DIRS = ['MapQuest_Def', 'Market_Def', 'QuestDiary', 'Robot_def', 'Npc_Def'];
const SCRIPT_DIR_KEYS = new Set(SCRIPT_DIRS.map(dir => dir.toLowerCase()));
export const variableListPathKey = (file: string): string => {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

export function isVariableListFile(file: string): boolean { return /\.(txt|ini)$/i.test(file); }

function inside(file: string, root: string): boolean {
  const relative = path.relative(variableListPathKey(root), variableListPathKey(file));
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep));
}

/** Stay inside selected script subtrees; never ascend and scan sibling servers/data. */
export function variableListScanRoots(workspaceRoots: readonly string[]): string[] {
  const candidates: string[] = [];
  for (const selected of workspaceRoots) {
    const root = path.resolve(selected);
    let ancestor = root;
    while (path.basename(ancestor).toLowerCase() !== 'envir' && path.dirname(ancestor) !== ancestor) ancestor = path.dirname(ancestor);
    if (path.basename(ancestor).toLowerCase() === 'envir') {
      const relative = path.relative(ancestor, root);
      if (!relative) candidates.push(...SCRIPT_DIRS.map(dir => path.join(root, dir)));
      else if (SCRIPT_DIR_KEYS.has(relative.split(path.sep)[0].toLowerCase())) candidates.push(root);
    } else if (SCRIPT_DIR_KEYS.has(path.basename(root).toLowerCase())) {
      candidates.push(root);
    } else {
      for (const base of [path.join(root, 'Mir200', 'Envir'), path.join(root, 'Envir')]) {
        candidates.push(...SCRIPT_DIRS.map(dir => path.join(base, dir)));
      }
    }
  }
  const unique = [...new Map(candidates.map(root => [variableListPathKey(root), root])).values()];
  return unique.filter(root => !unique.some(other => other !== root && inside(root, other)));
}

export type VariableReferenceKind = 'direct' | 'inferred' | 'possible' | 'unknown';
export interface VariableReferenceSource {
  kind: VariableReferenceKind;
  expression: string;
  status?: NestedVariableResolutionStatus;
  /** Source spans identify one expression even when it expands to several possible slots. */
  start?: number;
  end?: number;
  reasons?: string[];
  trace?: { line: number; description: string }[];
}
export interface VariableListSourceCounts {
  directCount?: number;
  inferredCount?: number;
  possibleCount?: number;
  unknownCount?: number;
}
export interface VariableListOccurrence { file: string; line: number; source?: VariableReferenceSource }
export interface VariableListUsage extends VariableListSourceCounts { type: string; count: number; files: Set<string> }
export interface VariableListSnapshot {
  usages: Map<string, VariableListUsage>;
  occurrences: Map<string, VariableListOccurrence[]>;
  errors: string[];
  candidates: CandidateUsage;
  scannedFiles: number;
}
export interface VariableListDocument { filePath: string; text: string }
export interface VariableListOptions {
  engine?: () => EngineId;
  nestedOptions?: (file: string) => NestedVariableAnalysisOptions;
  mapRanges?: (text: string, file: string) => readonly ScriptTextSpan[];
}
export interface FileVariable { name: string; type: string; line: number; source?: VariableReferenceSource }
interface CachedFile { stamp: string; text?: string; variables: FileVariable[]; external: boolean; candidates: CandidateUsage }

/** Counts source references, not executions. One possible slot receives one count per source expression. */
export function recordVariableListUsage<T extends VariableListSourceCounts & { count: number; files: Set<string> }>(
  usages: Map<string, T>, name: string, file: string, create: (normalizedName: string) => T,
  source?: VariableReferenceSource,
): { name: string; usage: T } {
  const result = recordVariableUsage(usages, name, file, create);
  const kind = source?.kind || 'direct';
  const field = kind === 'direct' ? 'directCount' : kind === 'inferred' ? 'inferredCount' : kind === 'possible' ? 'possibleCount' : 'unknownCount';
  result.usage[field] = (result.usage[field] || 0) + 1;
  return result;
}

export function variableReferenceKindLabel(kind: VariableReferenceKind): string {
  return { direct: '直接引用', inferred: '确定推导', possible: '可能引用', unknown: '未解动态' }[kind];
}

export function variableListSourceSummary(info: VariableListSourceCounts): string {
  return ([['direct', info.directCount], ['inferred', info.inferredCount], ['possible', info.possibleCount], ['unknown', info.unknownCount]] as const)
    .filter(([, count]) => !!count)
    .map(([kind, count]) => `${variableReferenceKindLabel(kind)} ${count}处`).join(' · ');
}

export function analyzeVariableListFile(text: string, file: string, options: VariableListOptions): Pick<CachedFile, 'variables' | 'external' | 'candidates'> {
  const variables: FileVariable[] = [];
  let external = false;
  const nestedOptions = options.nestedOptions?.(file) || {};
  const engine = options.engine?.() || 'GOM';
  const flagRange = personalFlagRangeForEngine(engine);
  const nested = analyzeNestedVariables(text, {
    ...nestedOptions,
    engine,
    personalFlagRange: flagRange,
    resolveConfigValues: request => { external = true; return nestedOptions.resolveConfigValues?.(request); },
    resolveTableData: request => { external = true; return nestedOptions.resolveTableData?.(request); },
    resolveListData: request => { external = true; return nestedOptions.resolveListData?.(request); },
  });
  const add = (name: string, line: number, type = compactVariableTypeLabel(name), source?: VariableReferenceSource) => {
    variables.push({ name: normalizeScriptVariableName(name), type, line, source });
  };
  for (const reference of nested.references) {
    const kind: VariableReferenceKind = reference.status === 'resolved' && reference.variables.length === 1 ? 'inferred' : 'possible';
    const reasons = [...(reference.reasons || [])];
    if (reference.variables.length > 1) reasons.push(`同一表达式有${reference.variables.length}个可能编号；不是执行次数`);
    if (reference.status !== 'resolved' && !reasons.length) reasons.push('动态编号未完全确定，已知编号仅为可能引用');
    const source: VariableReferenceSource = { kind, expression: reference.raw, status: reference.status,
      start: reference.start, end: reference.end, reasons, trace: reference.trace };
    for (const name of reference.variables) add(name, reference.line, undefined, source);
    if (reference.status !== 'resolved') add(normalizeNestedVariableReference(reference), reference.line,
      reference.status === 'partial' ? '嵌套变量（部分推导）' : '嵌套变量（未解动态）',
      { ...source, kind: 'unknown', reasons: reasons.length ? reasons : ['无法静态确定动态编号'] });
  }
  for (const reference of nested.personalFlags) {
    const staticReference = /^[\d,\-\s]+$/.test(reference.content) && /^\d+$/.test(reference.countExpression || '1');
    const kind: VariableReferenceKind = staticReference && reference.status === 'resolved' ? 'direct'
      : reference.status === 'resolved' && reference.flags.length === 1 ? 'inferred' : 'possible';
    const reasons = [...(reference.reasons || [])];
    if (!staticReference && reference.flags.length > 1) reasons.push(`同一表达式有${reference.flags.length}个可能标志；不是执行次数`);
    if (reference.status !== 'resolved' && !reasons.length) reasons.push('标志编号未完全确定，或超出当前引擎范围');
    const source: VariableReferenceSource = { kind, expression: normalizePersonalFlagReference(reference), status: reference.status,
      start: reference.start, end: reference.end, reasons, trace: reference.trace };
    for (const flag of reference.flags) add(flag, reference.line, `个人标识 [${flagRange.min}-${flagRange.max}]`, source);
    if (reference.status !== 'resolved') add(normalizePersonalFlagReference(reference), reference.line,
      reference.status === 'partial' ? '个人标识（部分推导）' : '个人标识（未确定或越界）', { ...source, kind: 'unknown' });
  }
  const ranges = options.mapRanges?.(text, file) || [];
  let offset = 0;
  let activeBlock: string | undefined;
  const lines = text.split(/\r\n|\n|\r/);
  for (let line = 0; line < lines.length; line++) {
    const content = lines[line];
    if (!isScriptCommentLine(content)) {
      if (/^\s*\[@[^\]]+\]/.test(content)) activeBlock = undefined;
      const directive = /^\s*#(IF|ACT|SAY|ELSEACT|ELSESAY|OR|AND)\b/i.exec(content);
      if (directive) activeBlock = directive[1].toUpperCase();
      const semantic = findSemanticScriptVariables(content, engine, !activeBlock || activeBlock === 'ACT' || activeBlock === 'ELSEACT');
      for (const reference of semantic.references) add(reference.name, line, undefined, {
        kind: 'direct', expression: reference.expression, start: offset + reference.index, end: offset + reference.end,
        reasons: reference.reason ? [reference.reason] : undefined,
      });
      for (const match of findScriptVariables(content)) {
        const absolute = offset + match.index;
        if (isNestedVariableBaseOffset(absolute, nested.references) || isOffsetInTextRanges(absolute, ranges) ||
          isOffsetInTextRanges(match.index, semantic.excludedRanges)) continue;
        add(match.name, line, undefined, { kind: 'direct', expression: match.name, start: absolute });
      }
    }
    offset += content.length;
    offset += text[offset] === '\r' && text[offset + 1] === '\n' ? 2 : 1;
  }
  return { variables: variables.sort((a, b) => a.line - b.line), external,
    candidates: collectCandidateUsage(text, { engine, nestedAnalysis: nested, excludedRanges: ranges }) };
}

/** Async disk IO + per-file analysis reuse; a cancelled scan never publishes a partial list. */
export class VariableListScanner {
  private readonly cache = new Map<string, CachedFile>();
  constructor(private readonly options: VariableListOptions = {}) {}
  invalidate(file?: string): void {
    if (file) this.cache.delete(variableListPathKey(file));
    else this.cache.clear();
  }
  async scan(workspaceRoots: readonly string[], documents: readonly VariableListDocument[] = [],
    cancelled: () => boolean = () => false): Promise<VariableListSnapshot | undefined> {
    const roots = variableListScanRoots(workspaceRoots);
    const files = new Map<string, string>();
    const errors: string[] = [];
    const visited = new Set<string>();
    const walk = async (directory: string): Promise<void> => {
      if (cancelled() || visited.has(variableListPathKey(directory))) return;
      visited.add(variableListPathKey(directory));
      try {
        const entries = await fs.promises.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
          if (cancelled()) return;
          const file = path.join(directory, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isDirectory()) await walk(file);
          else if (entry.isFile() && isVariableListFile(file)) files.set(variableListPathKey(file), file);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${directory}: ${String(error)}`);
      }
    };
    for (const root of roots) await walk(root);
    const open = new Map<string, VariableListDocument>();
    for (const document of documents) {
      if (!isVariableListFile(document.filePath) || !roots.some(root => inside(document.filePath, root))) continue;
      const key = variableListPathKey(document.filePath);
      open.set(key, document);
      files.set(key, path.resolve(document.filePath));
    }
    const usages = new Map<string, VariableListUsage>();
    const occurrences = new Map<string, VariableListOccurrence[]>();
    const engine = this.options.engine?.() || 'GOM';
    const candidates = createCandidateUsage(engine);
    let scannedFiles = 0;
    let processed = 0;
    for (const [key, file] of files) {
      if (cancelled()) return undefined;
      try {
        const document = open.get(key);
        const stat = document ? undefined : await fs.promises.stat(file);
        const stamp = stat ? `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` : 'document';
        let cached = this.cache.get(key);
        if (!cached || cached.stamp !== stamp || cached.text !== document?.text || cached.external || cached.candidates.engine !== engine) {
          const text = document?.text ?? decodeTextFile(await fs.promises.readFile(file)).text;
          cached = { stamp, text: document?.text, ...analyzeVariableListFile(text, file, this.options) };
          if (cancelled()) return undefined;
          this.cache.set(key, cached);
        }
        scannedFiles++;
        mergeCandidateUsage(candidates, cached.candidates);
        for (const variable of cached.variables) {
          recordVariableListUsage(usages, variable.name, file, () => ({ type: variable.type, count: 0, files: new Set() }), variable.source);
          const positions = occurrences.get(variable.name) || [];
          positions.push({ file, line: variable.line, source: variable.source });
          occurrences.set(variable.name, positions);
        }
      } catch (error) {
        this.cache.delete(key);
        errors.push(`${file}: ${String(error)}`);
      }
      if (++processed % 20 === 0) await new Promise<void>(resolve => setImmediate(resolve));
    }
    if (cancelled()) return undefined;
    for (const key of this.cache.keys()) if (!files.has(key)) this.cache.delete(key);
    return { usages, occurrences, errors, candidates, scannedFiles };
  }
}
