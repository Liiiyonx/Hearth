import { promises as fs } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

/**
 * 自定义形象图处理。
 *
 * 用户上传的图千奇百怪：可能是白底截图、透明 PNG、甚至从网上存的 JPG。
 * 桌宠窗口要求透明背景 + 紧凑构图 + 合理尺寸，直接贴上去往往很丑。
 * 所以这里做三件与构建脚本 `prep-pet-art.mjs` 一致的事：
 *   1. 白底转透明（按与白色的距离，避免锯齿白边）
 *   2. 裁到内容包围盒
 *   3. 等比缩到桌宠尺寸
 *
 * 为什么不在渲染进程做：那样每次启动都要重算，且要读写文件。
 * 主进程预处理一次、存到 userData，启动直接用结果。
 */

/** 处理后保存的目录 */
function customArtDir(): string {
  return path.join(app.getPath('userData'), 'art')
}

/** 当前生效的自定义形象文件 */
export function customArtPath(): string {
  return path.join(customArtDir(), 'custom.png')
}

export interface ProcessResult {
  ok: boolean
  /** 处理后的宽高 */
  width: number
  height: number
  /** 输出路径 */
  outPath: string
  /** 原图尺寸，用于告知用户裁掉了多少 */
  sourceWidth: number
  sourceHeight: number
  error?: string
}

/** PNG 解码（zlib 是Node 内置，无需第三方依赖） */
async function decodePng(buf: Buffer): Promise<{
  width: number
  height: number
  data: Buffer
}> {
  const { inflateSync } = await import('node:zlib')
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件')

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat: Buffer[] = []

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
    } else if (type === 'IDAT') {
      idat.push(body)
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }

  if (bitDepth !== 8) throw new Error(`暂不支持 ${bitDepth} 位深`)
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (!channels) throw new Error(`暂不支持颜色类型 ${colorType}`)

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  // 逐行反滤波（PNG 的 Paeth/Sub/Up 预测）
  const out = Buffer.alloc(width * height * 4)
  const prev = Buffer.alloc(stride)
  const cur = Buffer.alloc(stride)

  let rp = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++]
    raw.copy(cur, 0, rp, rp + stride)
    rp += stride

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      let v = cur[i]
      switch (filter) {
        case 1: v += a; break
        case 2: v += b; break
        case 3: v += (a + b) >> 1; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          break
        }
      }
      cur[i] = v & 0xff
    }

    for (let x = 0; x < width; x++) {
      const si = x * channels
      const di = (y * width + x) * 4
      if (channels === 4) {
        out[di] = cur[si]
        out[di + 1] = cur[si + 1]
        out[di + 2] = cur[si + 2]
        out[di + 3] = cur[si + 3]
      } else {
        out[di] = cur[si]
        out[di + 1] = cur[si + 1]
        out[di + 2] = cur[si + 2]
        out[di + 3] = 255
      }
    }
    cur.copy(prev)
  }

  return { width, height, data: out }
}

/** 用 zlib 重新编码为 PNG（只写 IHDR/IDAT/IEND，够用且无依赖） */
function encodePng(width: number, height: number, data: Buffer): Buffer {
  const { deflateSync } = require('node:zlib') as typeof import('node:zlib')
  const chunks: Buffer[] = []

  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(body.length)
    const td = Buffer.concat([Buffer.from(type, 'ascii'), body])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  chunks.push(chunk('IHDR', ihdr))

  // 每行前置 filter 字节（0 = None）
  const stride = width * 4
  const rawLen = (stride + 1) * height
  const raw = Buffer.alloc(rawLen)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0
    data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  chunks.push(chunk('IDAT', deflateSync(raw, { level: 9 })))
  chunks.push(chunk('IEND', Buffer.alloc(0)))

  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ...chunks])
}

let crcTable: number[] | null = null
function crc32(buf: Buffer): number {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

/** 处理后形象的目标高度（像素） */
const TARGET_H = 512
/** 拒绝过小的图——放大后必然模糊 */
const MIN_SOURCE_SIZE = 64

/**
 * 处理用户上传的形象图。
 * 只处理 PNG；JPG 等格式需要额外解码器，暂不支持并明确报错。
 */
export async function processCustomArt(srcPath: string): Promise<ProcessResult> {
  const outPath = customArtPath()
  try {
    const buf = await fs.readFile(srcPath)

    // 非 PNG 直接给出明确理由，不静默失败
    if (buf.readUInt32BE(0) !== 0x89504e47) {
      const ext = path.extname(srcPath).toLowerCase()
      return {
        ok: false,
        width: 0,
        height: 0,
        outPath,
        sourceWidth: 0,
        sourceHeight: 0,
        error:
          ext === '.jpg' || ext === '.jpeg'
            ? '暂只支持 PNG 图片（JPG 需要额外解码器）。请另存为 PNG 后重试。'
            : `不支持的文件类型 ${ext || '(无扩展名)'}，请选择 PNG 图片。`
      }
    }

    const img = await decodePng(buf)
    const { width, height, data } = img

    if (width < MIN_SOURCE_SIZE || height < MIN_SOURCE_SIZE) {
      return {
        ok: false,
        width: 0,
        height: 0,
        outPath,
        sourceWidth: width,
        sourceHeight: height,
        error: `图片太小（${width}x${height}），至少需要 ${MIN_SOURCE_SIZE}x${MIN_SOURCE_SIZE}。`
      }
    }

    // —— 1. 白底转透明 ——
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]
      const g = data[i + 1]
      const b = data[i + 2]
      const min = Math.min(r, g, b)
      if (min > 242) {
        data[i + 3] = 0
      } else if (min > 200) {
        // 边缘按白度渐变，消除锯齿白边
        data[i + 3] = Math.round(255 * ((242 - min) / 42))
      }
    }

    // —— 2. 内容包围盒 ——
    let minX = width
    let minY = height
    let maxX = 0
    let maxY = 0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (data[(y * width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x
          if (x > maxX) maxX = x
          if (y < minY) minY = y
          if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < minX || maxY < minY) {
      return {
        ok: false,
        width: 0,
        height: 0,
        outPath,
        sourceWidth: width,
        sourceHeight: height,
        error: '这张图看起来是空白的（去掉白底后没有内容），换一张试试。'
      }
    }

    const cw = maxX - minX + 1
    const ch = maxY - minY + 1

    // —— 3. 等比缩放 ——
    const scale = Math.min(1, TARGET_H / ch) // 不放大小图
    const outW = Math.max(1, Math.round(cw * scale))
    const outH = Math.max(1, Math.round(ch * scale))

    const out = Buffer.alloc(outW * outH * 4)
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const sx = minX + Math.min(cw - 1, Math.floor((x + 0.5) / scale))
        const sy = minY + Math.min(ch - 1, Math.floor((y + 0.5) / scale))
        const si = (sy * width + sx) * 4
        const di = (y * outW + x) * 4
        out[di] = data[si]
        out[di + 1] = data[si + 1]
        out[di + 2] = data[si + 2]
        out[di + 3] = data[si + 3]
      }
    }

    await fs.mkdir(customArtDir(), { recursive: true })
    await fs.writeFile(outPath, encodePng(outW, outH, out))

    return {
      ok: true,
      width: outW,
      height: outH,
      outPath,
      sourceWidth: width,
      sourceHeight: height
    }
  } catch (e) {
    return {
      ok: false,
      width: 0,
      height: 0,
      outPath,
      sourceWidth: 0,
      sourceHeight: 0,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}

/** 自定义形象是否存在 */
export async function hasCustomArt(): Promise<boolean> {
  try {
    await fs.access(customArtPath())
    return true
  } catch {
    return false
  }
}

/** 删除自定义形象 */
export async function clearCustomArt(): Promise<void> {
  try {
    await fs.unlink(customArtPath())
  } catch {
    /* 不存在就算了 */
  }
}

/**
 * 自定义形象在桌宠窗口里的显示高度。
 * 按图片宽高比算：太宽的图压低高度，避免超出窗口。
 */
export function displayHeightFor(width: number, height: number): number {
  const ratio = width / height
  if (ratio > 1.2) return 150 // 很宽
  if (ratio > 0.95) return 170 // 略宽
  return 186 // 常规竖版
}
