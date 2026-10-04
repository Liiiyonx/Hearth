import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  ConvertRequest,
  ConvertResult,
  ConvertDirection
} from '../../../shared/types'
import { wordToPdf } from './word2pdf'
import { pdfToWord } from './pdf2word'
import { addHistory } from '../../store'

/** 由方向推断默认输出文件名（不含扩展名） */
function defaultOutputName(inputPath: string, direction: ConvertDirection): string {
  const base = path.basename(inputPath, path.extname(inputPath))
  return `${base}.${direction === 'word2pdf' ? 'hearth-pdf' : 'hearth-docx'}`
}

/** 探测文件类型：判断 PDF 是文本型还是扫描型 */
export async function detectPdfKind(
  filePath: string
): Promise<'text' | 'scanned' | 'unknown'> {
  try {
    const buf = await fs.readFile(filePath)
    // PDF 文本通常包含 BT/ET 文本块操作符与 Tj/TJ 显示操作符
    const head = buf.subarray(0, Math.min(buf.length, 8 * 1024 * 1024)).toString('latin1')
    const hasTextOps = /BT[\s\S]{0,2000}?ET/.test(head) && /\bT[jJ]\b/.test(head)
    // 扫描件特征：/Image XObject 占比高且几乎无文本操作符
    const imageCount = (head.match(/\/Subtype\s*\/Image/g) || []).length
    if (hasTextOps && imageCount < 40) return 'text'
    if (!hasTextOps && imageCount > 0) return 'scanned'
    return hasTextOps ? 'text' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/**
 * 转换总入口。
 *
 * 方案书「转换质量是 P0 的全部」——这里的策略是：
 *   1. 主路径先走，失败或质量不达标才降级；
 *   2. 任何降级都必须诚实告知用户，不硬充。
 */
export async function convert(req: ConvertRequest): Promise<ConvertResult> {
  const started = Date.now()
  const inputPath = req.inputPath
  const direction = req.direction
  const outputDir = req.outputDir ?? path.dirname(inputPath)
  const outputName = req.outputName ?? defaultOutputName(inputPath, direction)
  const outputExt = direction === 'word2pdf' ? '.pdf' : '.docx'
  const outputPath = path.join(outputDir, `${outputName}${outputExt}`)

  const base: Omit<ConvertResult, 'ok' | 'lane' | 'durationMs'> = {
    inputPath,
    direction,
    fidelity: [],
    degradedNotes: []
  }

  // 入参校验
  try {
    const st = await fs.stat(inputPath)
    if (!st.isFile()) throw new Error('不是文件')
    if (st.size === 0) throw new Error('文件为空')
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return finish({ ...base, ok: false, lane: 'manual-required', durationMs: Date.now() - started, error: `无法读取输入文件：${msg}` })
  }

  try {
    const result =
      direction === 'word2pdf'
        ? await runWordToPdf(inputPath, outputPath, req.allowFallback !== false)
        : await runPdfToWord(inputPath, outputPath, req.allowFallback !== false)

    return finish({ ...result, durationMs: Date.now() - started })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return finish({ ...base, ok: false, lane: 'manual-required', durationMs: Date.now() - started, error: msg })
  }
}

async function runWordToPdf(
  inputPath: string,
  outputPath: string,
  allowFallback: boolean
): Promise<Omit<ConvertResult, 'durationMs'>> {
  const errors: string[] = []

  // —— 主路径：Office / WPS COM 原生导出 ——
  try {
    const r = await wordToPdf(inputPath, outputPath, { prefer: 'auto' })
    return {
      ok: true,
      inputPath,
      outputPath,
      lane: r.lane,
      direction: 'word2pdf',
      fidelity: r.fidelity,
      degradedNotes: r.degradedNotes
    }
  } catch (e) {
    errors.push(`原生导出失败：${e instanceof Error ? e.message : String(e)}`)
  }

  if (!allowFallback) {
    return {
      ok: false,
      inputPath,
      lane: 'manual-required',
      direction: 'word2pdf',
      fidelity: [],
      degradedNotes: errors,
      error: errors.join('；')
    }
  }

  // —— 回退链路：docx → HTML → Chromium 打印 ——
  try {
    const r = await wordToPdf(inputPath, outputPath, { prefer: 'fallback' })
    return {
      ok: true,
      inputPath,
      outputPath,
      lane: r.lane,
      direction: 'word2pdf',
      fidelity: r.fidelity,
      degradedNotes: [...errors, ...r.degradedNotes]
    }
  } catch (e) {
    errors.push(`回退链路失败：${e instanceof Error ? e.message : String(e)}`)
    return {
      ok: false,
      inputPath,
      lane: 'manual-required',
      direction: 'word2pdf',
      fidelity: [],
      degradedNotes: errors,
      error: errors.join('；')
    }
  }
}

async function runPdfToWord(
  inputPath: string,
  outputPath: string,
  allowFallback: boolean
): Promise<Omit<ConvertResult, 'durationMs'>> {
  // 先判断 PDF 是电子版还是扫描件
  const kind = await detectPdfKind(inputPath)
  const notes: string[] = []

  if (kind === 'scanned') {
    notes.push('检测到该 PDF 缺少文本层，判定为扫描件；当前版本未内置 OCR 引擎。')
    if (!allowFallback) {
      return {
        ok: false,
        inputPath,
        lane: 'manual-required',
        direction: 'pdf2word',
        fidelity: [],
        degradedNotes: notes,
        error: '扫描件 PDF 需要 OCR 引擎，v0.1 暂未内置'
      }
    }
    try {
      const r = await pdfToWord(inputPath, outputPath, { ocr: 'cloud', ocrConfigured: hasCloudOcr() })
      return {
        ok: r.ok,
        inputPath,
        outputPath: r.outputPath,
        lane: r.lane,
        direction: 'pdf2word',
        fidelity: r.fidelity,
        degradedNotes: [...notes, ...r.degradedNotes]
      }
    } catch (e) {
      return {
        ok: false,
        inputPath,
        lane: 'manual-required',
        direction: 'pdf2word',
        fidelity: [],
        degradedNotes: notes,
        error: `OCR 链路失败：${e instanceof Error ? e.message : String(e)}`
      }
    }
  }

  // —— 文本型 PDF：pdfjs 提取 + docx 重建 ——
  try {
    const r = await pdfToWord(inputPath, outputPath, { ocr: 'none' })
    return {
      ok: true,
      inputPath,
      outputPath: r.outputPath,
      lane: r.lane,
      direction: 'pdf2word',
      fidelity: r.fidelity,
      degradedNotes: r.degradedNotes
    }
  } catch (e) {
    return {
      ok: false,
      inputPath,
      lane: 'manual-required',
      direction: 'pdf2word',
      fidelity: [],
      degradedNotes: notes,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

function hasCloudOcr(): boolean {
  // 云 OCR 需要用户配置；v0.1 未内置引擎，故默认未配置
  return false
}

/** 记录历史并返回最终结果 */
async function finish(
  r: ConvertResult & { outputPath?: string }
): Promise<ConvertResult> {
  const final: ConvertResult = { ...r }
  if (final.ok && final.outputPath) {
    try {
      const st = await fs.stat(final.outputPath)
      if (!st.isFile() || st.size === 0) {
        final.ok = false
        final.error = '转换流程结束但未产出有效文件'
      }
    } catch {
      final.ok = false
      final.error = '转换流程结束但未产出文件'
    }
  }
  if (final.ok) {
    final.degradedNotes = [...new Set(final.degradedNotes)]
  }
  void addHistory({
    id: randomUUID(),
    inputPath: final.inputPath,
    outputPath: final.outputPath,
    inputName: path.basename(final.inputPath),
    direction: final.direction,
    lane: final.lane,
    ok: final.ok,
    createdAt: Date.now(),
    durationMs: final.durationMs,
    degradedNotes: final.degradedNotes
  })
  return final
}

/** 批量转换（方案书 P0「支持批量」） */
export async function convertBatch(
  inputs: string[],
  direction: ConvertDirection,
  outputDir?: string
): Promise<ConvertResult[]> {
  const results: ConvertResult[] = []
  for (const input of inputs) {
    results.push(await convert({ inputPath: input, direction, outputDir }))
  }
  return results
}

/** 由文件扩展名推断转换方向 */
export function inferDirection(filePath: string): ConvertDirection | null {
  const ext = path.extname(filePath).toLowerCase()
  if (ext === '.docx' || ext === '.doc' || ext === '.rtf' || ext === '.odt') return 'word2pdf'
  if (ext === '.pdf') return 'pdf2word'
  return null
}