/**
 * Windows 打包脚本 —— 当前**未跑通**，保留作为问题记录与后续尝试的起点。
 *
 * ## 目标产物
 *
 * 直接用 `npx electron-builder --win nsis` 就能打出 installer。
 * 本脚本是为了绕开一个环境问题（见下），不是必需。
 *
 * ## 障碍：winCodeSign 的 macOS 符号链接
 *
 * electron-builder 会解包 winCodeSign-2.6.0.7z，其中有
 * darwin/10.12/lib/{libssl,libcrypto}.dylib 两个**符号链接**。
 * 7za.exe 创建链接需要 SE_CREATE_SYMBOLIC_LINK 特权，
 * 非管理员会话下报「客户端没有所需的特权」，退出码 2，重试 3 次后中断。
 *
 * ## 已确认的事实（实测，非推测）
 *
 * 1. **解包其实成功了**：解包后 windows-10/x64/signtool.exe、
 *    rcedit-x64.exe 全部到位，只有那两个 macOS dylib 链接失败。
 *    也就是说文件层面零损失，**唯一问题是退出码非 0**。
 * 2. 归档的 **sha512 写死在 app-builder 二进制里**，所以不能重打包：
 *    替换符号链接后重打会得到 `checksum mismatch`。
 * 3. 镜像服务（ELECTRON_BUILDER_BINARIES_MIRROR）**有效**，
 *    能让下载走本地；但必须带尾斜杠，否则 Go 侧拼出的URL 解析失败。
 * 4. `DOWNLOAD_OVERRIDE_URL`、`SEVEN_ZIP_BIN_PATH`、改 PATH —— **都无效**，
 *    因为签名工具走的是 getBin("winCodeSign") 不传 url，
 *    且 app-builder 按**绝对路径**调用 node_modules 里的 7za.exe。
 * 5. 预置目标目录让其跳过解包 —— **不可行**：目录名是随机的，
 *    且预置文件会让 7za 弹出交互式覆盖询问（`? (Y)es / (N)o`），
 *    非交互环境下直接挂起或以 255 中止，比原问题更糟。
 *
 * ## 结论
 *
 * 这需要**管理员权限**或**开启 Windows 开发者模式**
 * （设置 → 系统 → 开发者选项 → 开发人员模式），
 * 让当前用户具备创建符号链接的权限。在此之前 installer 无法打出。
 *
 * 可用的替代方案：直接跑 `npx electron-builder --win portable`，
 * 它在 rcedit 之前就会中断，但**应用本体已完整打包**
 * （dist-portable/win-unpacked/，可直接运行 uninvited.exe）。
 *
 * 用法：node scripts/build-installer.mjs   （需管理员/开发者模式）
 */

import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  cpSync,
  statSync,
  createReadStream,
  readFileSync,
  writeFileSync,
  watch,
} from 'node:fs'
import http from 'node:http'
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
const mirrorDir = path.join(root, '.win-codesign-mirror')
const stagingDir = path.join(mirrorDir, '_staging')
const sevenZip = path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe')
const NAME = 'winCodeSign'
const VERSION = '2.6.0'
const ARCHIVE = `${NAME}-${VERSION}.7z`

/** 包内是符号链接、但 Windows 上用不到的文件；用同名实体文件补上 */
const DARWIN_LIB = 'darwin/10.12/lib'
const LINKS = [
  { link: `${DARWIN_LIB}/libssl.dylib`, real: `${DARWIN_LIB}/libssl.1.0.0.dylib` },
  { link: `${DARWIN_LIB}/libcrypto.dylib`, real: `${DARWIN_LIB}/libcrypto.1.0.0.dylib` }
]

/** 找一份未被改动的官方原包 */
function findOfficialArchive() {
  if (!existsSync(cacheRoot)) return null
  for (const name of readdirSync(cacheRoot)) {
    if (name.endsWith('.7z')) return path.join(cacheRoot, name)
  }
  return null
}

/** 预置解包内容：解开（跳过符号链接）后，把链接补成普通文件 */
function prepareStaging() {
  if (existsSync(path.join(stagingDir, 'windows-10', 'x64', 'signtool.exe'))) return true
  const archive = findOfficialArchive()
  if (!archive) {
    console.error('[codesign] 缓存里没有 winCodeSign 的 .7z，请先跑一次 electron-builder')
    return false
  }
  mkdirSync(stagingDir, { recursive: true })
  console.log('[codesign] 预置解包内容…')
  // 7za 对「跳过的符号链接」返回退出码 2，那只是警告，
  // 其余文件都正常解出——不能把非 0 当失败（这个坑踩过）。
  try {
    execFileSync(sevenZip, ['x', '-snld', '-bd', archive, `-o${stagingDir}`], {
      stdio: 'ignore'
    })
  } catch {
    /* 用下面的关键文件检查判定真实结果 */
  }
  for (const { link, real } of LINKS) {
    const lp = path.join(stagingDir, link)
    const rp = path.join(stagingDir, real)
    if (existsSync(rp) && !existsSync(lp)) cpSync(rp, lp)
  }
  if (!existsSync(path.join(stagingDir, 'windows-10', 'x64', 'signtool.exe'))) {
    console.error('[codesign] 预置失败：缺少 signtool.exe')
    return false
  }
  return true
}

/** 官方原包必须逐字节原样提供，放到「带版本号」的子目录里 */
function stageArchive() {
  const src = findOfficialArchive()
  if (!src) return null
  const versioned = path.join(mirrorDir, `${NAME}-${VERSION}`)
  mkdirSync(versioned, { recursive: true })
  const dst = path.join(versioned, ARCHIVE)
  writeFileSync(dst, readFileSync(src)) // 逐字节复制，保持 sha512
  return dst
}

/** 只服务 mirrorDir 的静态服务 */
function serve(dir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const name = decodeURIComponent((req.url || '/').replace(/^\//, ''))
      const file = path.join(dir, name)
      if (!file.startsWith(dir) || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('not found')
        return
      }
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': statSync(file).size
      })
      createReadStream(file).pipe(res)
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/**
 * 关键洞察：7za 解包**其实是成功的**。
 *
 * 实测：解包后windows-10/x64/signtool.exe、rcedit-x64.exe 全部到位，
 * 只有 darwin 下那两个 macOS 链接创建失败（退出码 2）。
 * 也就是说文件层面没有任何损失，**唯一的问题是退出码非 0**，
 * 而 app-builder 见非 0 就判定失败并重试 3 次后中断。
 *
 * 注意：app-builder 是按**绝对路径**调用 node_modules 里的 7za.exe，
 * 不走 PATH 查找，所以改 PATH 无效。
 * 但 electron-builder 支持用环境变量指定 7za 位置：
 *   SEVEN_ZIP_BIN_PATH —— 指定 7za 可执行文件
 * 所以做法是：写一个包装脚本，把它作为 SEVEN_ZIP_BIN_PATH 传下去。
 *
 * 包装脚本必须能顶替 .exe 的调用方式，所以用 .cmd；
 * app-builder 允许这里给 .cmd 路径（它只是 spawn 出来执行）。
 */
function makeShim() {
  const dir = path.join(mirrorDir, '_shim')
  mkdirSync(dir, { recursive: true })
  const shim = path.join(dir, 'sevenzip-shim.cmd')
  writeFileSync(
    shim,
    [
      '@echo off',
      'rem 7za 解包实际是成功的，只是 darwin 下两个 macOS 符号链接创建失败导致退出码为 2。',
      'rem 这里执行真实的 7za，然后强制返回 0，避免 app-builder 判定失败。',
      `"${sevenZip}" %*`,
      'exit /b 0',
      ''
    ].join('\r\n'),
    'ascii'
  )
  return shim
}

async function main() {
  if (!prepareStaging()) process.exit(1)
  const archive = stageArchive()
  if (!archive) process.exit(1)
  console.log(
    `[codesign] 官方原包已就位（${(statSync(archive).size / 1048576).toFixed(1)}MB，逐字节未改）`
  )

  // 造一个吞退出码的 7za 包装器
  const shim = makeShim()
  console.log(`[codesign] 7za 包装器：${shim}`)

  const { server, port } = await serve(mirrorDir)
  const base = `http://127.0.0.1:${port}`
  console.log(`[codesign] 镜像服务：${base}`)



  const outDir = process.env.BUILD_OUTPUT || 'dist-build'
  // 必须用 BINARIES_MIRROR 且带尾斜杠：Go 侧会直接拼
  // `<mirror>/<name>-<version>/<name>-<version>.7z`，
  // 少斜杠会拼成 `http://host:portwinCodeSign-2.6.0/...`。
  const env = {
    ...process.env,
    ELECTRON_BUILDER_BINARIES_MIRROR: `${base}/`,
    // 指定吞退出码的 7za 包装器（app-builder 认这个变量）
    SEVEN_ZIP_BIN_PATH: shim
  }

  console.log(`[build] 打包中，输出到 ${outDir}…`)
  const child = spawn(
    'npx',
    ['electron-builder', '--win', '--x64', `--config.directories.output=${outDir}`],
    { env, stdio: 'inherit', cwd: root, shell: true }
  )
  child.on('exit', (code) => {
    server.close()
    console.log(code === 0 ? `\n[build] 完成 → ${outDir}` : `\n[build] 失败（退出码 ${code}）`)
    process.exit(code ?? 1)
  })
}

main()
