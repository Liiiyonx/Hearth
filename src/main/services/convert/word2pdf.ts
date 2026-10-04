import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ConvertLane, FidelityCheck } from '../../../shared/types'

const exec = promisify(execFile)

export interface WordToPdfOptions {
  /** auto = 先试 COM 借力，失败降级；fallback = 强制走 HTML 打印链路 */
  prefer: 'auto' | 'fallback'
}

export interface WordToPdfOutcome {
  lane: ConvertLane
  fidelity: FidelityCheck[]
  degradedNotes: string[]
}

/**
 * Word → PDF。
 *
 * 方案书「借力 + 诚实」：
 *  - 借力：机器上装了 Office/WPS，就让排版引擎自己导出 PDF——
 *    没有第二个引擎比 Office 更懂 Word 的版式。
 *  - 诚实：回退链路只保证文本、图片、基础排版，公式与页眉页脚明确标注为缺失。
 */
export async function wordToPdf(
  inputPath: string,
  outputPath: string,
  options: WordToPdfOptions
): Promise<WordToPdfOutcome> {
  if (options.prefer === 'fallback') {
    return fallbackChain(inputPath, outputPath)
  }

  const engine = await detectOfficeEngine()
  if (!engine) {
    return fallbackChain(inputPath, outputPath)
  }

  try {
    await exportViaOffice(inputPath, outputPath, engine)
    return {
      lane: 'com-native',
      fidelity: nativeFidelity(),
      degradedNotes: []
    }
  } catch (e) {
    // COM 借力失败不应让用户卡住——降级并如实说明
    const msg = e instanceof Error ? e.message : String(e)
    const fb = await fallbackChain(inputPath, outputPath)
    return {
      ...fb,
      degradedNotes: [
        `${engine.name} 原生导出失败（${msg}），已降级到内置链路，版式保真度下降。`,
        ...fb.degradedNotes
      ]
    }
  }
}

// ==== 主路径：Office / WPS COM 借力导出 ====

type OfficeEngine = { name: 'Word' | 'WPS'; progId: string }

let cachedEngine: OfficeEngine | null | undefined

/** 探测本机是否有 Word 或 WPS（结果缓存） */
export async function detectOfficeEngine(): Promise<OfficeEngine | null> {
  if (cachedEngine !== undefined) return cachedEngine
  const candidates: OfficeEngine[] = [
    { name: 'Word', progId: 'Word.Application' },
    { name: 'WPS', progId: 'KWPS.Application' }
  ]

  for (const c of candidates) {
    const ok = await probeProgId(c.progId)
    if (ok) {
      cachedEngine = c
      return c
    }
  }
  cachedEngine = null
  return null
}

async function probeProgId(progId: string): Promise<boolean> {
  if (os.platform() !== 'win32') return false
  const script = `
$ErrorActionPreference = 'Stop'
try {
  $app = New-Object -ComObject ${progId}
  $app.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
  Write-Output 'OK'
} catch {
  Write-Output 'NO'
}
`
  try {
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 30_000, windowsHide: true }
    )
    return stdout.trim().includes('OK')
  } catch {
    return false
  }
}

/**
 * 通过 PowerShell 驱动 COM 导出 PDF。
 *
 * 关键点：
 *  - wdExportFormatPDF = 17
 *  - 关闭文档时不保存，避免改动用户的源文件
 *  - 结束后强制释放 COM 对象，防止 Word 残留进程
 */
async function exportViaOffice(
  inputPath: string,
  outputPath: string,
  engine: OfficeEngine
): Promise<void> {
  const src = inputPath.replace(/'/g, "''")
  const dst = outputPath.replace(/'/g, "''")

  const script = `
$ErrorActionPreference = 'Stop'
$app = $null
$doc = $null
try {
  $app = New-Object -ComObject ${engine.progId}
  $app.Visible = $false
  $app.DisplayAlerts = 0
  # WPS 的 ScreenUpdating 属性不通用，容错设置
  try { $app.ScreenUpdating = $false } catch {}

  $doc = $app.Documents.Open('${src}', $false, $true)

  # 更新域（目录、交叉引用、页码）后再导出，保证目录页码正确
  try {
    if ($doc.TablesOfContents.Count -gt 0) { $doc.TablesOfContents.Item(1).Update() }
  } catch {}
  try { $doc.Fields.Update() | Out-Null } catch {}

  # wdExportFormatPDF = 17
  $doc.ExportAsFixedFormat('${dst}', 17)
  $doc.Close($false)
  $doc = $null
  Write-Output 'OK'
} catch {
  Write-Output ('ERR: ' + $_.Exception.Message)
  exit 1
} finally {
  if ($doc -ne $null) { try { $doc.Close($false) } catch {} }
  if ($app -ne $null) { try { $app.Quit() } catch {} }
  try { [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null } catch {}
}
`
  const { stdout } = await exec(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 180_000, windowsHide: true, maxBuffer: 1024 * 1024 }
  )

  if (!stdout.includes('OK')) {
    const errLine = stdout.split('\n').find((l) => l.includes('ERR:'))
    throw new Error(errLine?.replace('ERR:', '').trim() ?? '未知错误')
  }

  // 校验产物真实落盘
  const st = await fs.stat(outputPath).catch(() => null)
  if (!st || st.size === 0) throw new Error('导出完成但文件为空')
}

/** 原生导出的保真清单——全部原生保真 */
function nativeFidelity(): FidelityCheck[] {
  return [
    { item: '字体', status: 'ok', note: '由 Word/WPS 排版引擎自行处理' },
    { item: '图片', status: 'ok' },
    { item: '表格', status: 'ok' },
    { item: '公式', status: 'ok', note: 'OMML 公式由原生引擎渲染' },
    { item: '页眉页脚', status: 'ok' },
    { item: '目录', status: 'ok', note: '导出前已更新域，页码正确' },
    { item: '分页与版式', status: 'ok' }
  ]
}

// ==== 回退链路：docx → HTML → Chromium 打印 ====

async function fallbackChain(inputPath: string, outputPath: string): Promise<WordToPdfOutcome> {
  const ext = path.extname(inputPath).toLowerCase()

  // .doc 等旧二进制格式 mammoth 无法解析，转 HTML 会得到空文档——直接报实话
  if (ext === '.doc') {
    throw new Error(
      '内置链路仅支持 .docx。.doc 旧格式请先在 Word/WPS 中另存为 .docx，或安装 Office/WPS 以走原生导出。'
    )
  }

  const { convertViaHtmlPrint } = await import('./htmlPrint')
  await convertViaHtmlPrint(inputPath, outputPath)

  return {
    lane: 'html-print',
    fidelity: [
      { item: '字体', status: 'partial', note: '使用系统字体回退，字形可能与原稿略有差异' },
      { item: '图片', status: 'ok' },
      { item: '表格', status: 'partial', note: '基础表格可还原，合并单元格与嵌套表格可能简化' },
      { item: '公式', status: 'missing', note: '内置链路不还原公式，请安装 Office/WPS 走原生导出' },
      { item: '页眉页脚', status: 'missing', note: '内置链路不还原页眉页脚' },
      { item: '目录', status: 'partial', note: '目录域被展开为静态文本' },
      { item: '分页与版式', status: 'partial', note: '按内容流重排，分页位置与原稿不同' }
    ],
    degradedNotes: [
      '本机未检测到 Office 或 WPS，已使用内置链路转换：文本、图片与基础排版可保留，公式、页眉页脚与原始分页无法保真。',
      '安装 Office 或 WPS 后重新转换可获得最高保真度。'
    ]
  }
}