/**
 * 在 Windows 上完成 electron-builder 的 winCodeSign 缓存预置。
 *
 * 问题：electron-builder 解包 winCodeSign 时，会在 macOS 的 darwin/ 目录下
 * 创建两个 dylib 符号链接。用 7za.exe 解包时这一步失败（非管理员会话），
 * 于是重试 3 次后打包中断，连 afterPack 都执行不到。
 *
 * 有意思的是：同一台机器上 Node 的 fs.symlinkSync 反而能成功
 * （当前 Windows 版本对同卷符号链接已放宽限制），7za 失败是因为它
 * 用的是较旧的 Win32 API 路径。
 *
 * 因此这里改用 7z 的「不含符号链接」模式解包，再用 Node 补建那两个链接，
 * 最后放成 electron-builder 期望的哈希目录。
 *
 * 另一处关键坑：electron-builder 每次都用随机名目录解压同一个包，
 * 预置固定目录无效。因此这里持续监听缓存目录，发现新包立即预置。
 *
 * 用法：node scripts/prepare-win-codesign.mjs
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, existsSync, cpSync, rmSync, symlinkSync, watch } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const cacheRoot = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'electron-builder',
  'Cache',
  'winCodeSign'
)

const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')

/** macOS dylib 在包内是相对链接，目标同目录下的真实文件 */
const DARWIN_LINKS = [
  ['libssl.1.1.dylib', 'libssl.dylib'],
  ['libcrypto.1.1.dylib', 'libcrypto.dylib']
]

/** 补建 7za 没能创建的那两个符号链接 */
function createDarwinLinks(dir) {
  const libDir = path.join(dir, 'darwin', '10.12', 'lib')
  if (!existsSync(libDir)) return
  for (const [target, link] of DARWIN_LINKS) {
    const linkPath = path.join(libDir, link)
    if (existsSync(linkPath)) continue
    try {
      if (existsSync(path.join(libDir, target))) {
        symlinkSync(target, linkPath, 'file')
      }
    } catch {
      // 补建失败也不影响：Windows 打包只用到 rcedit-x64.exe
    }
  }
}

function provision(archive) {
  const hash = path.basename(archive, '.7z')
  const target = path.join(cacheRoot, hash)
  if (existsSync(path.join(target, 'rcedit-x64.exe'))) return false

  const staging = path.join(cacheRoot, '__staging__' + hash)
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })

  // 先正常解包；符号链接失败不影响其它文件落地
  try {
    execFileSync(sevenZip, ['x', '-snld', '-bd', '-y', archive, '-o' + staging], {
      stdio: 'ignore',
      windowsHide: true
    })
  } catch {
    /* 预期内：那两个 dylib 链接会失败 */
  }

  if (!existsSync(path.join(staging, 'rcedit-x64.exe'))) {
    rmSync(staging, { recursive: true, force: true })
    return false
  }

  createDarwinLinks(staging)

  rmSync(target, { recursive: true, force: true })
  cpSync(staging, target, { recursive: true })
  rmSync(staging, { recursive: true, force: true })
  console.log(`[codesign] 已预置 ${hash}`)
  return true
}

function scan() {
  if (!existsSync(cacheRoot) || !existsSync(sevenZip)) return
  for (const n of readdirSync(cacheRoot)) {
    if (n.endsWith('.7z')) provision(path.join(cacheRoot, n))
  }
}

if (process.platform !== 'win32') {
  console.log('[codesign] 非 Windows，跳过')
  process.exit(0)
}

mkdirSync(cacheRoot, { recursive: true })
scan()

const watcher = watch(cacheRoot, () => scan(), { persistent: true })
setTimeout(
  () => {
    watcher.close()
    process.exit(0)
  },
  Number(process.env.CODESIGN_WATCH_MS || 120000)
)
