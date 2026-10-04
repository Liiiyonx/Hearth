/**
 * electron-builder 配置。
 *
 * 与 vite 配置分开：前者管「怎么把产物打成安装包」，后者管「怎么构建产物」。
 * afterPack 钩子在这里用于裁剪 Electron 的多余语言包。
 */
const { rmSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'cn.hearth.desktop',
  productName: 'Hearth',
  directories: {
    output: 'dist'
  },
  // 主进程 bundle 已内联 docx / pdfjs / mammoth，
  // 所以不需要把依赖树打进 asar（那会多出约 50MB）。
  files: ['out/**/*', '!out/**/*.map', 'package.json'],
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    // 未配置代码签名证书时跳过签名步骤，
    // 否则会尝试解包 macOS 签名工具（需管理员权限）而失败。
    signAndEditExecutable: false
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Hearth 围炉'
  },
  /**
   * Electron 自带 55 个语言包约 41MB，本项目只面向中文用户。
   * 保留 zh-CN 与 en-US（后者是内置兜底，删掉会让英文报错出现方块字）。
   */
  afterPack: async (ctx) => {
    if (ctx.packager.platform.name !== 'win32') return
    const dir = join(ctx.appOutDir, 'locales')
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    const keep = new Set(['zh-CN.pak', 'en-US.pak'])
    let freed = 0
    for (const name of entries) {
      if (keep.has(name)) continue
      try {
        const p = join(dir, name)
        freed += statSync(p).size
        rmSync(p, { force: true })
      } catch {
        /* 单个文件删不掉不影响整体 */
      }
    }
    if (freed > 0) {
      console.log(`  • 语言包裁剪完成，释放 ${(freed / 1048576).toFixed(1)} MB`)
    }
  }
}