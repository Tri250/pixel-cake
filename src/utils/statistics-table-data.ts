import * as XLSX from 'xlsx';
import { inflateRawSync } from 'zlib';
import { NestedTableDataResult } from './nested-variable-analysis';
import { isBinarySpreadsheet, parseScriptTableData, ScriptTableFormat } from './table-data';
import { decodeTextFile } from './text';

export const MAX_STATISTICS_TABLE_BYTES = 16 * 1024 * 1024;
const MAX_TABLE_CELLS = 1024 * 1024;
const MAX_TABLE_TEXT = 8 * 1024 * 1024;
const MAX_ZIP_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2048;

/** Parse caller-owned bytes only; this module never resolves paths, writes or runs macros. */
export function readStatisticsTableData(
  data: Uint8Array,
  format: ScriptTableFormat,
  warn?: (reason: string) => void,
): NestedTableDataResult | undefined {
  const reject = (reason: string): undefined => { warn?.(reason); return undefined; };
  if (data.length > MAX_STATISTICS_TABLE_BYTES) return reject('统计表格超过 16 MiB 读取上限');
  try {
    if (!isBinarySpreadsheet(data)) {
      const text = decodeTextFile(Buffer.from(data)).text;
      // Bound delimiter-heavy input before the legacy parser allocates its
      // row/cell arrays (a small file can still contain millions of blanks).
      let possibleCells = 1;
      for (let index = 0; index < text.length; index++) {
        const char = text[index];
        // Count quoted delimiters too, conservatively: malformed quoting must
        // not bypass the allocation guard of the actual delimiter parser.
        if (/[,\t\r\n]/.test(char)) {
          if (char === '\r' && text[index + 1] === '\n') index++;
          if (++possibleCells > MAX_TABLE_CELLS) return reject('统计文本表格超过单元格上限');
        }
      }
      const rows = parseScriptTableData(text, format);
      let cells = 0, textLength = 0;
      for (const row of rows) {
        cells += row.length;
        for (const value of row) textLength += value.length;
        if (cells > MAX_TABLE_CELLS || textLength > MAX_TABLE_TEXT) return reject('统计表格超过单元格或文字总量上限');
      }
      return { rows, complete: true };
    }
    if (format !== 'excel') return reject('二进制工作簿不能作为 CSV 读取');
    const buffer = Buffer.from(data);
    const biff = buffer[0] === 0xd0;
    if (biff) validateBiff8(buffer);
    else validateXlsxZip(buffer);
    const workbook = XLSX.read(buffer, {
      type: 'buffer', cellFormula: true, cellDates: false, cellNF: false,
      cellHTML: false, cellText: false, bookVBA: false,
    });
    // There is no engine-independent rule selecting a sheet. Do not silently
    // treat the first sheet as complete coverage of all possible runtime reads.
    if (workbook.SheetNames.length !== 1) return reject('多工作表的选表规则未确定，统计不擅自选择第一张');
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!sheet) return reject('工作表缺失');
    for (const [address, raw] of Object.entries(sheet)) {
      if (address.startsWith('!') || !raw || typeof raw !== 'object') continue;
      const cell = raw as XLSX.CellObject;
      if (cell.f !== undefined || cell.F !== undefined) return reject('公式结果需要重算，统计不采用工作簿缓存值');
      if (cell.t === 'e') return reject('工作表含错误值，不能作为完整的脚本列值');
    }
    if (!sheet['!ref']) return { rows: [], complete: true };
    const range = XLSX.utils.decode_range(sheet['!ref']);
    if (![range.s.r, range.s.c, range.e.r, range.e.c].every(Number.isSafeInteger)
      || range.s.r < 0 || range.s.c < 0 || range.e.r < range.s.r || range.e.c < range.s.c
      || range.e.r > (biff ? 65535 : 1048575) || range.e.c > (biff ? 255 : 16383)
      || (range.e.r + 1) * (range.e.c + 1) > MAX_TABLE_CELLS) {
      return reject('工作表绝对尺寸超过统计单元格上限');
    }
    // Preserve absolute A1 origin, unlike the editable grid's compact !ref
    // view. READEXCEL's row-1 / column-0 conversion belongs to the evaluator.
    const rows: string[][] = [];
    let totalText = 0;
    for (let row = 0; row <= range.e.r; row++) {
      const cells: string[] = [];
      for (let column = 0; column <= range.e.c; column++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })] as XLSX.CellObject | undefined;
        const value = cell?.v === undefined || cell.v === null ? '' : String(cell.v);
        totalText += value.length;
        if (totalText > MAX_TABLE_TEXT) return reject('工作表文字总量超过 8 MiB 统计上限');
        cells.push(value);
      }
      rows.push(cells);
    }
    return { rows, complete: true };
  } catch (error) {
    return reject(error instanceof Error ? error.message : '统计表格损坏、加密或格式无法确定');
  }
}

function validateBiff8(buffer: Buffer): void {
  const container = XLSX.CFB.read(buffer, { type: 'buffer' }) as { FileIndex?: { name?: string; content?: Uint8Array }[] };
  const streams = (container.FileIndex || []).filter(entry => /^(?:Workbook|Book)$/i.test(entry.name || ''));
  if (streams.length !== 1) throw new Error('XLS 工作簿流缺失或不唯一');
  const stream = streams[0].content;
  if (!stream || stream.length < 8 || stream[0] !== 0x09 || stream[1] !== 0x08 || stream[4] !== 0 || stream[5] !== 6) {
    throw new Error('统计仅读取 BIFF8 XLS 工作簿');
  }
  // Check original records: unsupported formula tokens may leave a cached .v
  // while the parser cannot provide .f. Never turn that cache into certainty.
  let cursor = 0;
  while (cursor + 4 <= stream.length) {
    const record = stream[cursor] | (stream[cursor + 1] << 8);
    const length = stream[cursor + 2] | (stream[cursor + 3] << 8);
    if (cursor + 4 + length > stream.length) throw new Error('XLS 记录长度损坏');
    if (record === 0x0006) throw new Error('公式结果需要重算，统计不采用 XLS 缓存值');
    if (record === 0x002f) throw new Error('统计不读取加密 XLS');
    cursor += 4 + length;
  }
}

/** Bound ZIP expansion before giving XLSX.read any compressed workbook bytes. */
function validateXlsxZip(buffer: Buffer): void {
  let end = -1;
  for (let cursor = buffer.length - 22; cursor >= Math.max(0, buffer.length - 65557); cursor--) {
    if (buffer.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + buffer.readUInt16LE(cursor + 20) === buffer.length) {
      end = cursor; break;
    }
  }
  if (end < 0 || buffer.readUInt16LE(end + 4) !== 0 || buffer.readUInt16LE(end + 6) !== 0) throw new Error('XLSX ZIP 目录损坏或分卷不受支持');
  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12), offset = buffer.readUInt32LE(end + 16);
  if (count < 1 || count > MAX_ZIP_ENTRIES || count !== buffer.readUInt16LE(end + 8)
    || offset + size !== end) throw new Error('XLSX ZIP 目录超限或格式不受支持');
  let cursor = offset, expanded = 0;
  const names = new Set<string>();
  for (let entry = 0; entry < count; entry++) {
    if (cursor + 46 > end || buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('XLSX ZIP 成员目录损坏');
    const flags = buffer.readUInt16LE(cursor + 8), method = buffer.readUInt16LE(cursor + 10);
    const compressed = buffer.readUInt32LE(cursor + 20), uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28), extraLength = buffer.readUInt16LE(cursor + 30), commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42), next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || flags & 1 || (method !== 0 && method !== 8) || buffer.readUInt16LE(cursor + 34) !== 0) throw new Error('XLSX ZIP 成员加密或格式不受支持');
    expanded += uncompressed;
    if (expanded > MAX_ZIP_EXPANDED_BYTES) throw new Error('XLSX ZIP 展开量超过 32 MiB 统计上限');
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    if (names.has(name)) throw new Error('XLSX ZIP 有重名成员，不能确定内容');
    names.add(name);
    if (local + 30 > offset || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('XLSX ZIP 成员头损坏');
    const localNameLength = buffer.readUInt16LE(local + 26);
    const start = local + 30 + localNameLength + buffer.readUInt16LE(local + 28);
    if (buffer.readUInt16LE(local + 6) !== flags || buffer.readUInt16LE(local + 8) !== method
      || buffer.toString('utf8', local + 30, local + 30 + localNameLength) !== name) throw new Error('XLSX ZIP 成员头与目录不一致');
    if (start + compressed > offset) throw new Error('XLSX ZIP 成员越界');
    const payload = buffer.subarray(start, start + compressed);
    const content = method === 8 ? inflateRawSync(payload, { maxOutputLength: uncompressed + 1 }) : payload;
    if (content.length !== uncompressed) throw new Error('XLSX ZIP 声明长度与实际展开量不符');
    if (/\.xml$/i.test(name)) {
      const littleEndian = (content[0] === 0xff && content[1] === 0xfe) || (content[0] === 0x3c && content[1] === 0);
      const bigEndian = (content[0] === 0xfe && content[1] === 0xff) || (content[0] === 0 && content[1] === 0x3c);
      const xml = littleEndian ? content.toString('utf16le')
        : bigEndian ? Buffer.from(content).swap16().toString('utf16le') : content.toString('utf8');
      if (/<(?:[A-Za-z_][\w.-]*:)?f(?:\s|\/?>)/.test(xml)) throw new Error('公式结果需要重算，统计不采用 XLSX 缓存值');
    }
    cursor = next;
  }
  if (cursor !== end || !names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) throw new Error('不是可确定的 XLSX 工作簿');
}
