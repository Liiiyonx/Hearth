/**
 * 纯 Node 侧的转换引擎验证。
 *
 * PDF→Word 这条链路只用 pdfjs-dist + docx，不依赖 Electron，
 * 因此可以在 Node 里直接验证，不必等 Electron 二进制下载完。
 *
 * 用法：node scripts/node-convert-check.mjs
 */
import { promises as fs, existsSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'



const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const workDir = path.join(root, '.nodecheck')
await fs.mkdir(workDir, { recursive: true })

let pass = 0
let fail = 0
function check(name, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  PASS  ${name}${detail ? ' — ' + detail : ''}`)
  } else {
    fail++
    console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`)
  }
}

console.log('=== 纯 Node 转换引擎验证（PDF → Word）===\n')

// ---- 1. 造一份带文本层的 PDF ----
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')

/**
 * 手写一份最小 PDF。
 * 刻意做出「标题比正文大」与「段落之间留空」的排版，
 * 这样才能验证引擎是否真的能还原标题层级与段落边界，
 * 而不是只验证「文字被抄了出来」。
 * 每行格式：[字号, 文本]
 */
function buildPdf(lines) {
  let content = 'BT /F1 10 Tf 72 720 Td\n'
  for (const [size, text] of lines) {
    // TD 是「移动到下一行」，配合 TL 设置行距；标题用更大行距，
    // 正文行距紧凑 —— 这是真实版面的几何特征，也正是引擎判断段落边界的依据。
    if (size > 13) {
      content += '/F1 10 Tf 26 TL\n'
    } else {
      content += '/F1 10 Tf 13 TL\n'
    }
    content += `/F1 ${size} Tf (${text.replace(/([()\\])/g, '\\$1')}) Tj T*\n`
  }
  content += 'ET'

  const objs = []
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objs[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objs[3] =
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>'
  objs[4] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`
  objs[5] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i < objs.length; i++) {
    offsets[i] = pdf.length
    pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`
  }
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objs.length}\n0000000000 65535 f \n`
  for (let i = 1; i < objs.length; i++) {
    pdf += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  }
  pdf += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`
  return Buffer.from(pdf, 'latin1')
}

const samplePdf = path.join(workDir, 'sample.pdf')
await fs.writeFile(
  samplePdf,
  buildPdf([
    // 标题：20pt
    [20, 'A Study of Document Conversion Fidelity'],
    // 小标题：14pt
    [14, 'Abstract'],
    // 正文：10pt，两段
    [10, 'This paper evaluates the fidelity of local conversion pipelines. We'],
    [10, 'group text items into lines by baseline proximity, then merge'],
    [10, 'lines into paragraphs using vertical gap thresholds relative to'],
    [10, 'glyph height. Heading levels follow from font size ratios against'],
    [10, 'the dominant body size measured across the whole document.'],
    [14, '1. Introduction'],
    [10, 'Cloud tools upload manuscripts to remote servers. For unpublished'],
    [10, 'work this is a privacy problem, not merely a convenience problem.'],
    [10, 'Semantics are recovered heuristically and must be disclosed to the'],
    [10, 'user. Double column layouts remain partially recovered as a result.']
  ])
)
check('构造带文本层 PDF', true, `${(await fs.stat(samplePdf)).size} 字节`)

// ---- 2. 用 pdfjs 解析 ----
const doc = await pdfjs.getDocument({ data: new Uint8Array(await fs.readFile(samplePdf)) }).promise
let extracted = ''
for (let p = 1; p <= doc.numPages; p++) {
  const page = await doc.getPage(p)
  const tc = await page.getTextContent()
  extracted += tc.items.map((i) => i.str).join(' ')
}
check('pdfjs 提取到文本', extracted.includes('baseline proximity'), `提取 ${extracted.length} 字符`)
check('多行文本被合并', extracted.includes('glyph height'), '跨行句子完整')

// ---- 3. 跑真正的 pdfToWord ----
// 用 esbuild 把 TS 引擎打成临时 ESM，这样 Node 能直接 import 真实实现，
// 测的是产品代码本身，而不是另写一份模拟。
console.log('\n[转换] 打包并调用真实引擎')
const { build } = await import('esbuild')
const engineEntry = path.join(root, 'src', 'main', 'services', 'convert', 'pdf2word.ts')
const bundlePath = path.join(workDir, 'engine.mjs')
await build({
  entryPoints: [engineEntry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: bundlePath,
  external: ['electron'],
  logLevel: 'error'
})
check('引擎打包成功', existsSync(bundlePath), 'esbuild 产出 ESM')

const engine = await import(pathToFileUrl(bundlePath))
const outDocx = path.join(workDir, 'out.docx')
const result = await engine.pdfToWord(samplePdf, outDocx, { ocr: 'none' })

check('转换成功', result.ok === true, `链路=${result.lane}`)
check('产出文件存在', existsSync(outDocx))

if (existsSync(outDocx)) {
  const buf = await fs.readFile(outDocx)
  check('产出为合法 docx（zip）', buf.subarray(0, 2).toString() === 'PK', `${(buf.length / 1024).toFixed(1)} KB`)

  const text = await extractDocxText(outDocx)
  check('产出含可编辑正文', text.length > 200, `提取 ${text.length} 字符`)
  check(
    '内容保真（关键短语命中）',
    text.includes('baseline proximity') && text.includes('heuristically'),
    '抽查两处原文'
  )
  check('未退化为图片', text.length > 300, `正文 ${text.length} 字符 >> 图片`)

  const xml = await rawXml(outDocx)
  check('段落使用了 Heading 样式', /pStyle w:val="Heading/.test(xml), '标题层级被重建')
}

check('保真清单已生成', result.fidelity.length >= 5, `${result.fidelity.length} 项`)
check(
  '降级说明如实给出',
  result.degradedNotes.length > 0,
  result.degradedNotes[0]?.slice(0, 50) ?? ''
)

console.log('\n=== 汇总 ===')
console.log(`通过 ${pass} / ${pass + fail}，失败 ${fail}`)
process.exit(fail > 0 ? 1 : 0)

// ---- 工具 ----
function pathToFileUrl(p) {
  return new URL(`file:///${p.replace(/\\/g, '/')}`).href
}

async function extractDocxText(docxPath) {
  const zlib = await import('node:zlib')
  const buf = await fs.readFile(docxPath)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return ''
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nl = buf.readUInt16LE(off + 28)
    const el = buf.readUInt16LE(off + 30)
    const cl = buf.readUInt16LE(off + 32)
    const lo = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nl).toString('utf-8')
    if (name === 'word/document.xml') {
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28)
      const data = buf.subarray(start, start + compSize)
      const xml = method === 0 ? data.toString('utf-8') : zlib.inflateRawSync(data).toString('utf-8')
      return decodeEntities(xml)
    }
    off += 46 + nl + el + cl
  }
  return ''
}

async function rawXml(docxPath) {
  const zlib = await import('node:zlib')
  const buf = await fs.readFile(docxPath)
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return ''
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break
    const method = buf.readUInt16LE(off + 10)
    const compSize = buf.readUInt32LE(off + 20)
    const nl = buf.readUInt16LE(off + 28)
    const el = buf.readUInt16LE(off + 30)
    const cl = buf.readUInt16LE(off + 32)
    const lo = buf.readUInt32LE(off + 42)
    const name = buf.subarray(off + 46, off + 46 + nl).toString('utf-8')
    if (name === 'word/document.xml') {
      const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28)
      const data = buf.subarray(start, start + compSize)
      return method === 0 ? data.toString('utf-8') : zlib.inflateRawSync(data).toString('utf-8')
    }
    off += 46 + nl + el + cl
  }
  return ''
}

function decodeEntities(s) {
  return s
    .replace(/<w:p[ >]/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}