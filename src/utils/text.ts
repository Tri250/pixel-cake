/**
 * 文本编码工具 — GBK/UTF-8 解码
 */
import { Buffer } from 'buffer';
import * as crypto from 'crypto';

export type PreservedTextEncoding = 'utf8' | 'utf8-bom' | 'gbk';

export interface DecodedTextFile {
  text: string;
  encoding: PreservedTextEncoding;
}

/**
 * 实体行内容指纹：对原始行文本取短哈希。地图预览把解析出的 NPC/刷怪/标识
 * 连同指纹一起发给前端，落盘前用当前文件里的同一行重新计算比对；不一致说明
 * 行内容在预览加载后被外部程序或未保存草稿改动，按行号写入会改错记录，
 * 必须拒绝并提示刷新。
 */
export function entityLineFingerprint(rawLine: string): string {
  return crypto.createHash('sha256').update(rawLine, 'utf8').digest('hex').slice(0, 16);
}

/** GBK编码读取文件内容 (传奇脚本默认GBK) */
export function readFileGBK(raw: Uint8Array): string {
  const buf = Buffer.from(raw);
  try {
    const iconv = require('iconv-lite');
    const gbkStr = iconv.decode(buf, 'gbk');
    if (gbkStr.indexOf('�') >= 0) return buf.toString('utf-8');
    return gbkStr;
  } catch (e) {
    console.warn('[BOO] GBK解码失败，回退到UTF-8:', e instanceof Error ? e.message : String(e));
    return buf.toString('utf-8');
  }
}

export function decodeTextFile(raw: Uint8Array): DecodedTextFile {
  const buf = Buffer.from(raw);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8-bom' };
  }

  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�') && Buffer.from(utf8, 'utf8').equals(buf)) {
    return { text: utf8, encoding: 'utf8' };
  }

  try {
    const iconv = require('iconv-lite');
    return { text: iconv.decode(buf, 'gbk'), encoding: 'gbk' };
  } catch (error) {
    console.warn('[BOO] 文本编码识别失败，回退到UTF-8:', error instanceof Error ? error.message : String(error));
    return { text: utf8, encoding: 'utf8' };
  }
}

export function encodeTextFile(text: string, encoding: PreservedTextEncoding): Buffer {
  if (encoding === 'utf8-bom') {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  }
  if (encoding === 'gbk') {
    const iconv = require('iconv-lite');
    return Buffer.from(iconv.encode(text, 'gbk'));
  }
  return Buffer.from(text, 'utf8');
}
