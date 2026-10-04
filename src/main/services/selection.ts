import type { LookupResult } from '../../shared/types'
import { lookup } from './dictionary'

/**
 * 划词即译。
 *
 * 设计取舍（与方案书「不打扰」一致）：
 *  - 只对**单个英文词**或**短词组**触发弹窗；
 *  - 优先查本地词典，命中即出，零网络延迟、零出网；
 *  - 未命中不擅自联网，交由用户点「深度解释」再走云端；
 *  - 过滤掉网址、纯数字、路径、代码等——这些划词没有查询价值，
 *    弹窗反而是噪音。
 */

export interface SelectionResult {
  word: string
  hit: LookupResult | null
  /** 若被过滤掉，给出原因（用于调试与用户提示） */
  skipped?: string
}

/** 明显不该触发查询的选区 */
const JUNK = [
  /^https?:\/\//i,
  /^[\w.-]+\.(com|cn|org|net|io|dev|edu|gov)$/i,
  /^[0-9\s.,:%+\-*/()#]+$/, // 纯数字与常见符号
  /^[A-Za-z]:\\/, // Windows 路径
  /^\/[\w./-]+$/, // Unix 路径
  /[{}<>;=|`]/, // 代码特征
  /^[\s　]+$/ // 纯空白（含全角空格）
]

/** 允许的最大词长——更长的多半是整句，另走深度解释而非词典 */
const MAX_WORD_LEN = 40
/** 词组最多几个词 */
const MAX_WORDS = 4

export async function resolveSelection(raw: string): Promise<SelectionResult | null> {
  const text = raw.trim()
  if (!text) return null

  for (const re of JUNK) {
    if (re.test(text)) return null
  }

  // 含换行的长段落不查词典，交给「深度解释」
  if (text.includes('\n') && text.length > 120) return null

  const words = text.split(/\s+/)
  if (words.length > MAX_WORDS) return null
  if (text.length > MAX_WORD_LEN) return null

  // 必须至少含一个英文字母，否则中文选区不该走英文词典
  if (!/[A-Za-z]/.test(text)) return null

  // 词组取最长的那个词查词典（"baseline proximity" 里proximity 更有价值）
  const target = words
    .map((w) => w.replace(/[^A-Za-z'-]/g, ''))
    .filter((w) => w.length > 0)
    .sort((a, b) => b.length - a.length)[0]

  if (!target) return null

  const hit = await lookup(target)
  return { word: target, hit }
}

/** 取默认气泡尺寸（按内容长度估算，避免窗口过大或截断） */
export function bubbleSize(text: string): { width: number; height: number } {
  const len = text.length
  if (len <= 8) return { width: 300, height: 168 }
  if (len <= 20) return { width: 340, height: 208 }
  if (len <= 40) return { width: 380, height: 248 }
  return { width: 420, height: 280 }
}
