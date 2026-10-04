import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  ImageRun,
  convertMillimetersToTwip
} from 'docx'
import type { PdfBlock, ExtractedImage } from './pdf2word'

/**
 * 把重建出的块结构写成 .docx。
 * docx 库是声明式的（MIT），适合程序化生成——这是方案书表 2 的选型依据。
 */
export async function buildDocx(params: {
  outputPath: string
  blocks: PdfBlock[]
  images: ExtractedImage[]
  notes: string[]
}): Promise<void> {
  const { outputPath, blocks, images, notes } = params
  const children: Paragraph[] = []

  // 若有降级说明，先在文档开头插入一条可删除的提示
  if (notes.length > 0) {
    children.push(
      new Paragraph({
        spacing: { after: 160 },
        border: {
          top: { style: 'single', size: 6, color: 'E8B84B', space: 6 },
          bottom: { style: 'single', size: 6, color: 'E8B84B', space: 6 },
          left: { style: 'single', size: 6, color: 'E8B84B', space: 6 },
          right: { style: 'single', size: 6, color: 'E8B84B', space: 6 }
        },
        children: [
          new TextRun({ text: '不请自来 转换说明（可删除本段）', bold: true, size: 20, color: '8A6D1F' })
        ]
      })
    )
    for (const n of notes) {
      children.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: `· ${n}`, size: 18, color: '8A6D1F' })]
        })
      )
    }
    children.push(new Paragraph({ text: '', spacing: { after: 200 } }))
  }

  let imageCursor = 0

  for (const block of blocks) {
    const text = block.lines.map((l) => l.text).join(' ').trim()
    if (!text) continue

    switch (block.type) {
      case 'heading': {
        const levelMap: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
          1: HeadingLevel.HEADING_1,
          2: HeadingLevel.HEADING_2,
          3: HeadingLevel.HEADING_3,
          4: HeadingLevel.HEADING_4
        }
        children.push(
          new Paragraph({
            heading: levelMap[block.level] ?? HeadingLevel.HEADING_4,
            spacing: { before: block.level <= 2 ? 280 : 180, after: 120 },
            children: [new TextRun({ text, bold: true })]
          })
        )
        break
      }

      case 'listItem': {
        // 去掉原始的符号前缀，改用 Word 原生列表样式
        const clean = text.replace(/^([•·\-\*▪◦‣]|\d+[\.、\)])\s+/, '')
        children.push(
          new Paragraph({
            numbering: { reference: 'uninvited-bullets', level: 0 },
            spacing: { after: 80 },
            children: [new TextRun({ text: clean })]
          })
        )
        break
      }

      case 'caption': {
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            spacing: { before: 60, after: 160 },
            children: [new TextRun({ text, italics: true, size: 18, color: '666666' })]
          })
        )
        break
      }

      default: {
        // 判断是否为图注：以「图/Figure/Fig./表/Table」开头且较短
        const isCaption = /^(图|表|Figure|Fig\.|Table)\s*\d+[:：\.]/i.test(text) && text.length < 90
        if (isCaption) {
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 60, after: 160 },
              children: [new TextRun({ text, italics: true, size: 18, color: '666666' })]
            })
          )
          break
        }

        // 段首缩进两字符，符合中文排版习惯
        children.push(
          new Paragraph({
            spacing: { after: 140, line: 340 },
            indent: { firstLine: 480 },
            children: [new TextRun({ text })]
          })
        )

        // 每约 6 个正文块插入一张图片，避免图文错位过远
        if (images.length > 0 && block.lines.length === 1 && imageCursor < images.length) {
          const img = images[imageCursor++]
          try {
            const maxWidthPx = 420
            const scaled = Math.min(1, maxWidthPx / img.width)
            children.push(
              new Paragraph({
                alignment: AlignmentType.CENTER,
                spacing: { before: 160, after: 120 },
                children: [
                  new ImageRun({
                    type: 'png',
                    data: Buffer.from(img.data),
                    transformation: {
                      width: Math.max(1, Math.round(img.width * scaled)),
                      height: Math.max(1, Math.round(img.height * scaled))
                    }
                  })
                ]
              })
            )
          } catch {
            // 图片编码问题不阻断文档生成
          }
        }
      }
    }
  }

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'uninvited-bullets',
          levels: [
            {
              level: 0,
              format: 'bullet',
              text: '•',
              alignment: AlignmentType.LEFT,
              style: { paragraph: { indent: { left: 720, hanging: 360 } } }
            }
          ]
        }
      ]
    },
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 },
          paragraph: { spacing: { line: 340 } }
        }
      }
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertMillimetersToTwip(25),
              bottom: convertMillimetersToTwip(25),
              left: convertMillimetersToTwip(25),
              right: convertMillimetersToTwip(25)
            }
          }
        },
        children
      }
    ]
  })

  const buffer = await Packer.toBuffer(doc)
  const fs = await import('node:fs')
  await fs.promises.writeFile(outputPath, buffer)
}