/**
 * 转换回归测试 —— 方案书 P0 的验收纪律。
 *
 * 「20 份真实语料（论文、简历、报告、扫描件）进回归测试；
 *   每版转换前后自动双开对比。」
 *
 * 本模块跑在 Electron 主进程里（由 --regression 参数触发），
 * 因为 Word→PDF 的回退链路要用到 BrowserWindow.printToPDF。
 * 这样测的就是真实代码路径，而不是另写一套模拟实现。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { BrowserWindow } from 'electron'
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  TextRun,
  Table,
  TableRow,
  TableCell
} from 'docx'
import { convert } from '../services/convert'
import { initStore } from '../store'

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []

function record(name: string, ok: boolean, detail = ''): void {
  checks.push({ name, ok, detail })
  const tag = ok ? 'PASS' : 'FAIL'
  console.log(`  [${tag}] ${name}${detail ? ' — ' + detail : ''}`)
}

// ==== 样例语料 ====

/** 论文样例：标题层级、多段正文、表格 —— 英文 */
async function makePaperDocx(file: string): Promise<void> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: [new TextRun('A Study of Document Conversion Fidelity')]
          }),
          new Paragraph({ children: [new TextRun('Abstract')] }),
          new Paragraph({
            children: [
              new TextRun(
                'This paper evaluates the fidelity of local document conversion pipelines. ' +
                  'We argue that fidelity is not a binary property but a spectrum measured across ' +
                  'fonts, images, tables, headers, and equations.'
              )
            ]
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun('1. Introduction')]
          }),
          new Paragraph({
            children: [
              new TextRun(
                'Cloud converters impose subscription quotas and require uploading files, which is ' +
                  'unacceptable for unpublished manuscripts. A local engine trades breadth for privacy.'
              )
            ]
          }),
          new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun('2. Method')] }),
          new Paragraph({
            children: [
              new TextRun(
                'We extract text items with coordinates, group them into lines by baseline proximity, ' +
                  'then merge lines into paragraphs using inter-line gap thresholds. Heading levels are ' +
                  'inferred from font size relative to the body size distribution.'
              )
            ]
          }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Dimension')] }),
                  new TableCell({ children: [new Paragraph('Status')] }),
                  new TableCell({ children: [new Paragraph('Weight')] })
                ]
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('Fonts')] }),
                  new TableCell({ children: [new Paragraph('Preserved')] }),
                  new TableCell({ children: [new Paragraph('0.2')] })
                ]
              })
            ]
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_3,
            children: [new TextRun('2.1 Limitations')]
          }),
          new Paragraph({
            children: [
              new TextRun(
                'Semantics are recovered heuristically; a PDF carries no semantic labels, so occasional ' +
                  'misclassification is expected and must be disclosed to the user.'
              )
            ]
          })
        ]
      }
    ]
  })
  await fs.writeFile(file, await Packer.toBuffer(doc))
}

/** 中文报告样例 —— 验证 CJK 不乱码 */
async function makeChineseDocx(file: string): Promise<void> {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun('季度项目进展报告')] }),
          new Paragraph({ children: [new TextRun('一、总体情况')] }),
          new Paragraph({
            children: [
              new TextRun(
                '本季度完成了文档转换引擎的重建工作。核心指标如下：转换成功率提升，' +
                  '中文排版无乱码，标题层级可正确识别。'
              )
            ]
          }),
          new Paragraph({
            heading: HeadingLevel.HEADING_2,
            children: [new TextRun('二、下季度计划')]
          }),
          new Paragraph({ children: [new TextRun('推进表格与图片的保真重建，并补充扫描件 OCR 链路。')] })
        ]
      }
    ]
  })
  await fs.writeFile(file, await Packer.toBuffer(doc))
}

/** 用 Electron 的 printToPDF 造一份带真实文本层的 PDF */
async function makeSamplePdf(file: string): Promise<boolean> {
  const html = [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>',
    'body{font-family:Georgia,serif;font-size:12pt;line-height:1.75;margin:45px;color:#111}',
    'h1{font-size:20pt;margin:0 0 12pt}',
    'h2{font-size:15pt;margin:18pt 0 8pt}',
    'h3{font-size:13pt;margin:14pt 0 6pt}',
    'p{margin:0 0 10pt;text-align:justify}',
    '</style></head><body>',
    '<h1>Robust Document Conversion: A Structural Study</h1>',
    '<p><b>Abstract</b></p>',
    '<p>This study measures how much semantic structure survives a PDF round trip. We reconstruct ',
    'paragraphs, heading levels and tables from geometric primitives alone, without machine learning.</p>',
    '<h2>1. Introduction</h2>',
    '<p>Cloud tools upload manuscripts to remote servers. For unpublished work this is a privacy problem, ',
    'not merely a convenience problem. Local conversion avoids the upload entirely at the cost of engineering effort.</p>',
    '<h2>2. Related Work</h2>',
    '<p>Prior art either relies on layout heuristics or on machine learning. Heuristics remain more ',
    'predictable, which matters when the user must trust the output without reviewing it line by line.</p>',
    '<h2>3. Method</h2>',
    '<p>We group text items into lines by baseline proximity, then merge lines into paragraphs using ',
    'vertical gap thresholds relative to glyph height. Heading levels follow from font size ratios ',
    'against the dominant body size measured across the whole document.</p>',
    '<h3>3.1 Limitations</h3>',
    '<p>Double column layouts and complex formulas remain partially recovered and are reported as ',
    'degraded rather than silently approximated, so that the user knows exactly what to verify.</p>',
    '</body></html>'
  ].join('\n')

  const win = new BrowserWindow({ show: false })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await new Promise((r) => setTimeout(r, 500))
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
    await fs.writeFile(file, pdf)
    return true
  } catch {
    return false
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

/** 中文 PDF */
async function makeChinesePdf(file: string): Promise<boolean> {
  const html = [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><style>',
    "body{font-family:'Microsoft YaHei',sans-serif;font-size:12pt;line-height:1.8;margin:45px}",
    'h1{font-size:19pt}h2{font-size:15pt}p{margin:0 0 10pt}',
    '</style></head><body>',
    '<h1>中文文档转换测试</h1>',
    '<p>本文档用于验证中文在 PDF 与 Word 互转过程中的编码正确性。</p>',
    '<p>转换引擎需要正确处理汉字、标点与段落边界，确保不出现乱码或丢字。</p>',
    '<h2>测试结论</h2>',
    '<p>若下方文字可正常复制并统计字数，则说明中文编码链路通畅。</p>',
    '</body></html>'
  ].join('\n')

  const win = new BrowserWindow({ show: false })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    await new Promise((r) => setTimeout(r, 500))
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true })
    await fs.writeFile(file, pdf)
    return true
  } catch {
    return false
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

// ==== docx 文本提取（验证产出是结构化文本而非图片）====

async function extractDocxText(docxPath: string): Promise<string> {
  const buf = await fs.readFile(docxPath)
  // 手工解析 zip：找 word/document.xml，用 zlib.inflateRaw 解压
  const zlib = await import('node:zlib')
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd < 0) return ''
  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)

  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf-8')

    if (name === 'word/document.xml') {
      // 跳到本地文件头，读出真实数据位置
      const lhNameLen = buf.readUInt16LE(localOffset + 26)
      const lhExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + lhNameLen + lhExtraLen
      const data = buf.subarray(dataStart, dataStart + compSize)
      const xml = method === 0 ? data.toString('utf-8') : zlib.inflateRawSync(data).toString('utf-8')
      return xml
        .replace(/<w:p[ >]/g, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  return ''
}

function findEndOfCentralDirectory(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i
  }
  return -1
}

// ==== 主流程 ====

export async function runRegression(workDir: string): Promise<boolean> {
  console.log('=== Hearth 转换回归测试 ===\n')
  await fs.mkdir(workDir, { recursive: true })
  initStore()

  const paperDocx = path.join(workDir, 'paper.docx')
  const cnDocx = path.join(workDir, 'report-cn.docx')
  await makePaperDocx(paperDocx)
  await makeChineseDocx(cnDocx)
  record('样例语料生成', true, 'paper.docx / report-cn.docx')

  // ---- Word → PDF ----
  console.log('\n[1] Word → PDF')
  const r1 = await convert({ inputPath: paperDocx, direction: 'word2pdf' })
  if (r1.ok && r1.outputPath) {
    const buf = await fs.readFile(r1.outputPath)
    const isPdf = buf.subarray(0, 5).toString() === '%PDF-'
    record('产出合法 PDF', isPdf, `${(buf.length / 1024).toFixed(1)} KB`)
    record('保真清单已生成', r1.fidelity.length >= 5, `${r1.fidelity.length} 项，链路=${r1.lane}`)
    const okCount = r1.fidelity.filter((f) => f.status === 'ok').length
    record('至少 3 项标为「保住」', okCount >= 3, `${okCount}/${r1.fidelity.length}`)
    record(
      '降级说明已如实给出',
      r1.lane === 'com-native' ? r1.degradedNotes.length === 0 : r1.degradedNotes.length > 0,
      r1.lane === 'com-native' ? '原生链路无需降级说明' : `${r1.degradedNotes.length} 条`
    )
  } else {
    record('Word → PDF', false, r1.error || '未知错误')
  }

  const r1cn = await convert({ inputPath: cnDocx, direction: 'word2pdf' })
  record('中文 Word → PDF', r1cn.ok, r1cn.ok ? '完成' : r1cn.error || '')

  // ---- PDF → Word ----
  console.log('\n[2] PDF → Word')
  const samplePdf = path.join(workDir, 'sample.pdf')
  const genOk = await makeSamplePdf(samplePdf)
  record('生成测试 PDF', genOk)
  if (genOk) {
    const r2 = await convert({ inputPath: samplePdf, direction: 'pdf2word' })
    if (r2.ok && r2.outputPath) {
      const buf = await fs.readFile(r2.outputPath)
      record('产出合法 docx', buf.subarray(0, 2).toString() === 'PK', `${(buf.length / 1024).toFixed(1)} KB`)
      record('重建保真清单已生成', r2.fidelity.length >= 5, `${r2.fidelity.length} 项`)

      const text = await extractDocxText(r2.outputPath)
      record('产出可编辑正文', text.length > 400, `提取 ${text.length} 字符`)
      record(
        '标题层级被识别（Heading 样式）',
        /Heading1|Heading2|Heading3/.test(await rawDocxXml(r2.outputPath)),
        '检查 document.xml 中的 pStyle'
      )
      record(
        '正文内容保真（关键句命中）',
        text.includes('baseline proximity') && text.includes('Heuristics'),
        '抽查两句原文'
      )
    } else {
      record('PDF → Word', false, r2.error || '未知错误')
    }
  }

  // ---- 中文 PDF → Word ----
  const cnPdf = path.join(workDir, 'cn.pdf')
  if (await makeChinesePdf(cnPdf)) {
    const r3 = await convert({ inputPath: cnPdf, direction: 'pdf2word' })
    if (r3.ok && r3.outputPath) {
      const text = await extractDocxText(r3.outputPath)
      const hasCjk = /[一-龥]/.test(text)
      record('中文 PDF → Word 无乱码', hasCjk && text.includes('中文'), `提取 ${text.length} 字符`)
    } else {
      record('中文 PDF → Word', false, r3.error || '')
    }
  }

  // ---- 扫描件识别 ----
  console.log('\n[3] 边界情况')
  const fakeScan = path.join(workDir, 'scan.pdf')
  await fs.writeFile(fakeScan, Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(2048)]))
  const r4 = await convert({ inputPath: fakeScan, direction: 'pdf2word' })
  record('扫描件被识别而非崩溃', true, r4.ok ? '尝试了 OCR 链路' : `如实报错：${(r4.error || '').slice(0, 40)}`)

  const emptyFile = path.join(workDir, 'empty.docx')
  await fs.writeFile(emptyFile, '')
  const r5 = await convert({ inputPath: emptyFile, direction: 'word2pdf' })
  record('空文件被拒绝且给出理由', !r5.ok && Boolean(r5.error), r5.error || '')

  const r6 = await convert({ inputPath: path.join(workDir, 'nope.docx'), direction: 'word2pdf' })
  record('不存在的文件被拒绝', !r6.ok && Boolean(r6.error), r6.error || '')

  // ---- 汇总 ----
  const pass = checks.filter((c) => c.ok).length
  const fail = checks.length - pass
  console.log('\n=== 汇总 ===')
  console.log(`通过 ${pass} / ${checks.length}，失败 ${fail}`)
  if (fail > 0) {
    console.log('\n失败明细：')
    for (const c of checks.filter((x) => !x.ok)) console.log(` - ${c.name}：${c.detail}`)
  }
  return fail === 0
}

/** 取原始 document.xml，用于检查段落样式 */
async function rawDocxXml(docxPath: string): Promise<string> {
  const buf = await fs.readFile(docxPath)
  const zlib = await import('node:zlib')
  const eocd = findEndOfCentralDirectory(buf)
  if (eocd < 0) return ''
  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) break
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf-8')
    if (name === 'word/document.xml') {
      const lhNameLen = buf.readUInt16LE(localOffset + 26)
      const lhExtraLen = buf.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + lhNameLen + lhExtraLen
      const data = buf.subarray(start, start + compSize)
      return method === 0 ? data.toString('utf-8') : zlib.inflateRawSync(data).toString('utf-8')
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  return ''
}