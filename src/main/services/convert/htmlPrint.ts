import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { BrowserWindow } from 'electron'
import mammoth from 'mammoth'

/**
 * 回退链路：docx → HTML → Chromium printToPDF。
 *
 * 方案书明确这是「保真度中」的一档，只在没有 Office/WPS 的机器上使用。
 * 用隐藏 BrowserWindow 加载 HTML 再打印，是 Electron 自带 Chromium 的
 * 一致性红利所在。
 */
export async function convertViaHtmlPrint(
  inputPath: string,
  outputPath: string
): Promise<void> {
  // mammoth 可通过 convertImage 把内嵌图片转成 data URI，
  // 使生成的 HTML 自包含，隐藏窗口加载时不依赖外部文件。
  const { value: html } = await mammoth.convertToHtml(
    { path: inputPath },
    {
      convertImage: mammoth.images.imgElement(async (image) => {
        const base64 = await image.read('base64')
        const anyImg = image as unknown as { contentType?: string }
        const contentType = anyImg.contentType || 'image/png'
        return { src: 'data:' + contentType + ';base64,' + base64 }
      }),
      styleMap: [
        "p[style-name='Title'] => h1:fresh",
        "p[style-name='Heading 1'] => h1:fresh",
        "p[style-name='Heading 2'] => h2:fresh",
        "p[style-name='Heading 3'] => h3:fresh",
        "p[style-name='Quote'] => blockquote:fresh"
      ],
      includeDefaultStyleMap: true
    }
  )

  const pageHtml = buildPage(html, path.basename(inputPath))

  // 写临时 HTML
  const tmpHtml = path.join(
    os.tmpdir(),
    'uninvited-print-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.html'
  )
  await fs.writeFile(tmpHtml, pageHtml, 'utf-8')

  const win = new BrowserWindow({
    show: false,
    webPreferences: { offscreen: true, javascript: false, images: true }
  })

  try {
    await win.loadFile(tmpHtml)
    // 等字体与布局稳定
    await new Promise((r) => setTimeout(r, 350))
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
      preferCSSPageSize: false
    })
    await fs.writeFile(outputPath, pdf)
  } finally {
    if (!win.isDestroyed()) win.destroy()
    await fs.unlink(tmpHtml).catch(() => {})
  }
}

function buildPage(bodyHtml: string, title: string): string {
  return [
    '<!DOCTYPE html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<title>' + escapeHtml(title) + '</title>',
    '<style>',
    '@page { size: A4; margin: 20mm 18mm; }',
    'body {',
    "  font-family: 'Microsoft YaHei', 'PingFang SC', 'SimSun', sans-serif;",
    '  font-size: 11.5pt; line-height: 1.75; color: #1a1a1a; margin: 0;',
    '}',
    'h1 { font-size: 17pt; margin: 1.2em 0 0.6em; }',
    'h2 { font-size: 14pt; margin: 1.1em 0 0.5em; }',
    'h3 { font-size: 12pt; margin: 1em 0 0.4em; }',
    'p { margin: 0.5em 0; text-align: justify; }',
    'img { max-width: 100%; height: auto; }',
    'table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }',
    'td, th { border: 1px solid #999; padding: 5px 8px; font-size: 10.5pt; }',
    'blockquote { margin: 0.8em 0; padding-left: 1em; border-left: 3px solid #ccc; color: #555; }',
    'pre { white-space: pre-wrap; font-family: Consolas, monospace; font-size: 10pt; }',
    '</style>',
    '</head>',
    '<body>' + bodyHtml + '</body>',
    '</html>'
  ].join('\n')
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => {
    if (c === '&') return '&amp;'
    if (c === '<') return '&lt;'
    if (c === '>') return '&gt;'
    return '&quot;'
  })
}