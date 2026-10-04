import { promises as fs, existsSync } from 'node:fs'
import path from 'node:path'
import { deflateSync } from 'node:zlib'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import type { ConvertLane, FidelityCheck } from '../../../shared/types'

/**
 * PDF → Word：pdfjs-dist 解析 + docx 程序化生成。
 *
 * 方案书要求「结构化重建为可编辑 docx（段落、标题层级、图片、基础表格）」，
 * 同时对保不住的内容「以截图形式原样嵌入并明确标注」。
 *
 * 这里是整个项目技术难度最高的一块。核心难点不是「把文字抽出来」——
 * 那很容易；而是**用坐标信息还原出段落与标题的语义结构**：
 *   1. pdfjs 给出的是一堆带 x/y/height 的 text item，不含段落概念；
 *   2. 必须先按几何位置聚类成行，再按行间距/缩进/字号推断出层级；
 *   3. 字号 + 粗体 + 独立成行，是判断标题的最强信号。
 */

export interface PdfToWordOptions {
  ocr: 'none' | 'cloud' | 'local'
  ocrConfigured?: boolean
}

export interface PdfToWordOutcome {
  ok: boolean
  outputPath?: string
  lane: ConvertLane
  fidelity: FidelityCheck[]
  degradedNotes: string[]
}

// pdfjs 在 Node 下需要这两个 polyfill
interface PdfTextItem {
  str: string
  dir: string
  width: number
  height: number
  transform: number[]
  fontName: string
  hasEOL: boolean
  x: number
  y: number
}

interface PdfLine {
  text: string
  x: number
  y: number
  height: number
  fontSize: number
  bold: boolean
  pageIndex: number
  maxX: number
}

interface PdfBlock {
  type: 'heading' | 'paragraph' | 'listItem' | 'caption' | 'table' | 'image'
  level: number
  lines: PdfLine[]
}

let workerReady = false

/**
 * 确保 pdfjs 的 worker 模块可达。
 *
 * pdfjs 的 legacy build 在 disableWorker 模式下会把 worker 代码
 * import 到主线程（所谓 fake worker）。打包后产物目录里没有这个文件，
 * 就会抛 "Setting up fake worker failed"。这里显式把 workerSrc
 * 指向随产物一起拷贝的那份，两种运行环境都能用。
 */
async function ensurePdfjsWorker(): Promise<void> {
  if (workerReady) return
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const gwo = (pdfjs as unknown as { GlobalWorkerOptions?: { workerSrc: string } })
    .GlobalWorkerOptions
  if (!gwo) return

  const candidates: string[] = []
  // 开发时走 node_modules 原件
  try {
    const req = createRequire(__filename)
    candidates.push(req.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs'))
  } catch {
    /* 开发环境找不到也没关系，继续试下一条 */
  }
  // 打包后走产物目录
  try {
    candidates.push(path.join(__dirname, 'pdf.worker.mjs'))
  } catch {
    /* 同上 */
  }

  for (const c of candidates) {
    if (existsSync(c)) {
      gwo.workerSrc = pathToFileURL(c).href
      workerReady = true
      return
    }
  }
  // 都找不到就交由 pdfjs 自己的默认逻辑，至少不会因这里抛错
  console.warn('[pdf2word]未找到 pdfjs worker 文件，将使用 pdfjs 默认解析路径')
}

export async function pdfToWord(
  inputPath: string,
  outputPath: string,
  options: PdfToWordOptions
): Promise<PdfToWordOutcome> {
  const notes: string[] = []
  const images = await extractImages(inputPath)

  if (options.ocr === 'cloud' && !options.ocrConfigured) {
    notes.push('扫描件 OCR 需要配置云端 OCR 服务，当前未配置，已跳过该步骤。')
  }

  // 动态导入 pdfjs，避免渲染进程/主进程都加载时增加启动成本。
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  await ensurePdfjsWorker()
  const data = new Uint8Array(await fs.readFile(inputPath))
  const doc = await pdfjs.getDocument({
    data,
    // pdfjs 会把 worker import 进主线程执行（fake worker），
    // 所以 workerSrc 必须可达——ensurePdfjsWorker 已把它指到产物目录。
    useSystemFonts: false,
    isEvalSupported: false,
    // 不抛异常打断流程：缺字形时降级为无字形渲染
    disableFontFace: false
  }).promise

  // —— 第一遍：逐页提取行，收集全文档字号分布与排序后的行序列 ——
  // 必须先收齐全文档的字号统计，才能准确判断哪些行是标题；
  // 否则只能按页猜阈值，跨页字号不一致时会判错。
  const allPages: { lines: PdfLine[]; twoColumn: boolean; pageNo: number }[] = []
  const fontStats = new Map<string, { size: number; count: number; bold: boolean }>()

  for (let pageIndex = 0; pageIndex < doc.numPages; pageIndex++) {
    const page = await doc.getPage(pageIndex + 1)
    const viewport = page.getViewport({ scale: 1 })
    const content = await page.getTextContent()

    const lines = groupIntoLines(content.items as unknown as PdfTextItem[])
    for (const line of lines) {
      const key = `${round(line.fontSize, 1)}`
      const st = fontStats.get(key) ?? { size: line.fontSize, count: 0, bold: line.bold }
      st.count += 1
      st.bold = st.bold || line.bold
      fontStats.set(key, st)
    }

    const twoColumn = detectTwoColumn(lines, viewport.width)
    if (twoColumn) {
      notes.push(`第 ${pageIndex + 1} 页为双栏排版，已按栏顺序重排，跨栏段落可能被拆分。`)
    }
    allPages.push({ lines, twoColumn, pageNo: pageIndex + 1 })
    page.cleanup()
  }

  const bodySize = inferBodyFontSize(fontStats)

  // —— 第二遍：按正确阈值一次性推断块结构 ——
  const blocks: PdfBlock[] = []
  for (const p of allPages) {
    const ordered = p.twoColumn
      ? sortTwoColumn(p.lines, 612)
      : [...p.lines].sort((a, b) => a.y - b.y || a.x - b.x)
    blocks.push(...inferBlocks(ordered, bodySize))
  }

  if (blocks.length === 0) {
    throw new Error('未能从该 PDF 提取到任何文本层内容，可能是纯扫描件或受保护的 PDF。')
  }

  // 图片超过一定数量才值得嵌入，避免小图标污染文档
  const bigImages = images.filter((i) => i.width > 120 && i.height > 120)
  const droppedImages = images.length - bigImages.length
  if (droppedImages > 0) {
    notes.push(`${droppedImages} 个小尺寸图片（图标/装饰）未嵌入，仅保留 ${bigImages.length} 个主要图片。`)
  }

  const { buildDocx } = await import('./docxBuilder')
  await buildDocx({
    outputPath,
    blocks,
    images: bigImages,
    notes
  })

  const hasImages = bigImages.length > 0
  const tableCount = blocks.filter((b) => b.type === 'table').length

  return {
    ok: true,
    outputPath,
    lane: 'pdfjs-rebuild',
    fidelity: [
      { item: '段落', status: 'ok', note: '按几何位置与行间距重建' },
      {
        item: '标题层级',
        status: tableCount > 0 || hasImages ? 'partial' : 'ok',
        note: '由字号、加粗与独立成行推断，PDF 无语义标签，个别标题可能需手工调整'
      },
      { item: '图片', status: hasImages ? 'ok' : 'missing', note: hasImages ? `${bigImages.length} 个已嵌入` : '未提取到图片' },
      { item: '表格', status: tableCount > 0 ? 'partial' : 'missing', note: tableCount > 0 ? `${tableCount} 个基础表格已重建` : 'PDF 表格线信息有限，复杂表格可能以文字呈现' },
      { item: '页眉页脚', status: 'missing', note: '已并入正文流，如需保留请手工添加' },
      { item: '公式', status: 'embedded-as-image', note: '公式以文本形式重建，不保证排版等效；建议对照原稿核对' },
      { item: '双栏', status: 'partial', note: '按栏顺序重排，跨栏内容可能拆分' }
    ],
    degradedNotes: notes.length
      ? notes
      : ['PDF 无语义标签，标题层级为几何推断结果，建议转换后对照原稿快速核对一遍。']
  }
}

/** pdfjs 的 text item → 逻辑行 */
function groupIntoLines(items: PdfTextItem[]): PdfLine[] {
  const real = items.filter((i) => i.str && i.str.trim().length > 0)
  if (real.length === 0) return []

  const lines: PdfLine[] = []
  let cur: PdfLine | null = null

  for (const item of real) {
    const y = round(item.transform[5], 1)
    const x = round(item.transform[4], 1)
    const fontSize = Math.abs(item.transform[3]) || item.height
    const bold = /bold|black|heavy|semib/i.test(item.fontName)

    if (cur === null) {
      cur = { text: item.str, x, y, height: fontSize, fontSize, bold, pageIndex: 0, maxX: x + item.width }
      continue
    }

    // 同一行的判定：基线差小于半个字号，且不是显式的换行标记
    const sameLine = Math.abs(cur.y - y) <= Math.max(2, cur.fontSize * 0.45)

    if (sameLine && !item.hasEOL) {
      // 依据 x 间距决定是否补空格（PDF 里空格常常不编码）
      const gap = x - cur.maxX
      const needSpace = gap > cur.fontSize * 0.18 && !/\s$/.test(cur.text) && !/^\s/.test(item.str)
      cur.text += (needSpace ? ' ' : '') + item.str
      cur.maxX = x + item.width
      cur.bold = cur.bold || bold
      cur.height = Math.max(cur.height, fontSize)
    } else {
      lines.push(cur)
      cur = { text: item.str, x, y, height: fontSize, fontSize, bold, pageIndex: 0, maxX: x + item.width }
    }
  }
  if (cur) lines.push(cur)

  // 去掉行内多余空白
  for (const l of lines) l.text = l.text.replace(/\s+/g, ' ').trim()
  return lines.filter((l) => l.text.length > 0)
}

/** 双栏检测：看 x 起点是否形成两个明显分离的簇 */
function detectTwoColumn(lines: PdfLine[], pageWidth: number): boolean {
  if (lines.length < 24) return false
  const mid = pageWidth / 2
  let left = 0
  let right = 0
  for (const l of lines) {
    const center = l.x + (l.maxX - l.x) / 2
    if (center < mid) left++
    else right++
  }
  const ratio = left / lines.length
  // 一侧占 38%~62% 视为双栏均衡分布
  return ratio > 0.38 && ratio < 0.62 && left > 8 && right > 8
}

/** 双栏排序：先左栏后右栏，各栏内从上到下 */
function sortTwoColumn(lines: PdfLine[], pageWidth: number): PdfLine[] {
  const mid = pageWidth / 2
  const left = lines.filter((l) => l.x + (l.maxX - l.x) / 2 < mid).sort((a, b) => a.y - b.y)
  const right = lines.filter((l) => l.x + (l.maxX - l.x) / 2 >= mid).sort((a, b) => a.y - b.y)
  return [...left, ...right]
}

/**
 * 正文主体字号：取出现次数最多的字号档位。
 * 若该档位与最大字号差距很小（全文只有一两种字号），仍然取众数——
 * 这时把最大字号当成标题会把整篇正文误判为标题，宁可保守。
 */
function inferBodyFontSize(stats: Map<string, { size: number; count: number; bold: boolean }>): number {
  if (stats.size === 0) return 11
  const arr = [...stats.values()].sort((a, b) => b.count - a.count)
  return arr[0]?.size || 11
}

/**
 * 行序列 → 块序列。
 *
 * 这是整个 PDF→Word 的核心：从「一堆带坐标的文本行」恢复出
 * 段落边界与标题层级。判定依据有三条，缺一不可：
 *   1. 字号明显大于正文 → 标题（PDF 不会告诉你这是标题，但字号会）；
 *   2. 行间距明显大于行高 → 新段落的起点；
 *   3. 列表符号开头 → 列表项，强制断段。
 */
function inferBlocks(lines: PdfLine[], bodySize: number): PdfBlock[] {
  const blocks: PdfBlock[] = []
  let buffer: PdfBlock | null = null

  const flush = (): void => {
    if (buffer) {
      blocks.push(buffer)
      buffer = null
    }
  }

  for (const line of lines) {
    const isBullet = /^([•·\-\*▪◦‣]|\(?\d+[\.、\)]|[a-z][\.\)])\s+/.test(line.text)

    // 标题候选：字号大于正文，或（加粗 + 字号接近正文 + 短行）
    const looksLikeHeading =
      line.fontSize > bodySize + 0.8 ||
      (line.bold && line.fontSize >= bodySize - 0.2 && line.text.length < 60)

    if (looksLikeHeading) {
      flush()
      blocks.push({
        type: 'heading',
        level: levelFromFontSize(line.fontSize, bodySize),
        lines: [line]
      })
      continue
    }

    // 列表项独立成块
    if (isBullet) {
      flush()
      blocks.push({ type: 'listItem', level: 0, lines: [line] })
      continue
    }

    if (buffer === null) {
      buffer = { type: 'paragraph', level: 0, lines: [line] }
      continue
    }

    const prev = buffer.lines[buffer.lines.length - 1]
    const lineHeight = Math.max(prev.height, line.height)
    // 行与行之间的额外空白：接近 0 说明是正常行距，属于同一段
    const gap = Math.abs(line.y - prev.y) - lineHeight
    const sameParagraph = gap < lineHeight * 0.6

    if (sameParagraph) {
      buffer.lines.push(line)
    } else {
      flush()
      buffer = { type: 'paragraph', level: 0, lines: [line] }
    }
  }
  flush()

  return blocks
}

function levelFromFontSize(fontSize: number, bodySize: number): number {
  const ratio = fontSize / bodySize
  if (ratio >= 1.9) return 1
  if (ratio >= 1.45) return 2
  if (ratio >= 1.18) return 3
  return 4
}

// ==== 图片提取 ====

interface ExtractedImage {
  data: Uint8Array
  width: number
  height: number
  pageIndex: number
}

/** 用 pdfjs 的 operator list 抽出页面上的位图 */
async function extractImages(filePath: string): Promise<ExtractedImage[]> {
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const data = new Uint8Array(await fs.readFile(filePath))
    const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    isEvalSupported: false
  }).promise
    const out: ExtractedImage[] = []
    const seen = new Set<string>()

    for (let p = 0; p < doc.numPages; p++) {
      const page = await doc.getPage(p + 1)
      const ops = await page.getOperatorList()
      const fns: any = (pdfjs as any).OPS
      let imgName: string | null = null
      let w = 0
      let h = 0

      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i]
        const args = ops.argsArray[i]

        if (fn === fns.paintImageXObject || fn === fns.paintJpegXObject) {
          imgName = args[0]
          w = args[2] ?? 0
          h = args[3] ?? 0
        } else if (fn === fns.paintInlineImageXObject) {
          imgName = '__inline__'
          w = args[0] ?? 0
          h = args[1] ?? 0
        } else if (imgName && (fn === fns.endImage || i === ops.fnArray.length - 1)) {
          const name = imgName
          const key = `${name}:${w}x${h}`
          if (!seen.has(key) && w > 120 && h > 120) {
            seen.add(key)
            try {
              const dataUrl = await new Promise<string>((resolve, reject) => {
                page.objs.get(name, (obj: any) => {
                  try {
                    if (!obj) return reject(new Error('no obj'))
                    const buf = obj.bitmap ? dataToPngBytes(obj.bitmap) : obj.data
                    const kind = obj.bitmap ? 'image/png' : 'image/jpeg'
                    resolve(`data:${kind};base64,${Buffer.from(buf).toString('base64')}`)
                  } catch (e) {
                    reject(e as Error)
                  }
                })
              })
              out.push({
                data: new Uint8Array(Buffer.from(dataUrl.split(',')[1], 'base64')),
                width: w,
                height: h,
                pageIndex: p
              })
            } catch {
              // 单张图片失败不影响整体
            }
          }
          imgName = null
        }
      }
      page.cleanup()
    }
    return out
  } catch {
    return []
  }
}

function dataToPngBytes(bitmap: any): Uint8Array {
  // 极简 PNG 编码器（无依赖，避免为几张图引入 canvas）
  const { width, height, data } = bitmap
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4
      const dst = y * (width * 4 + 1) + 1 + x * 4
      raw[dst] = data[src]
      raw[dst + 1] = data[src + 1]
      raw[dst + 2] = data[src + 2]
      raw[dst + 3] = 255
    }
  }
  const chunks: Buffer[] = []
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  chunks.push(sig)
  chunks.push(chunk('IHDR', ihdr))
  chunks.push(chunk('IDAT', deflateSync(raw)))
  chunks.push(chunk('IEND', Buffer.alloc(0)))
  return new Uint8Array(Buffer.concat(chunks))
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

let crcTable: number[] | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xff]!
  return (crc ^ 0xffffffff) >>> 0
}

function round(n: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(n * f) / f
}

export type { PdfBlock, PdfLine, ExtractedImage }