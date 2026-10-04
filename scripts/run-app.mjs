/**
 * 启动器。
 *
 * 本机（以及部分 CI / 沙箱环境）设置了 ELECTRON_RUN_AS_NODE=1，
 * 这会让 Electron 以纯 Node 模式启动：没有 GUI 运行时，
 * require('electron') 拿到的是 npm 包里的路径字符串而不是内置模块，
 * 于是 app / BrowserWindow 全部为 undefined。
 *
 * 这个脚本在启动前清掉该变量，让 Electron 以正常桌面应用模式运行。
 * 在没有该变量的普通终端里直接 `electron .` 也一样能跑，这里只是更保险。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const passthrough = process.argv.slice(2)

const electronPath = require('electron') // 在纯 Node 下这返回 exe 路径字符串

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(electronPath, [root, ...passthrough], {
  env,
  stdio: 'inherit',
  cwd: root
})

child.on('exit', (code) => process.exit(code ?? 0))