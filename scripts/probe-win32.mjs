/**
 * 独立验证 PowerShell 版 Win32 钩子是否真的能工作。
 * 用法：node scripts/probe-win32.mjs
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', 'src', 'main', 'services', 'win32.ts'), 'utf-8')

// 从 win32.ts 里抽出 POWERSHELL_SCRIPT 字符串字面量
const m = src.match(/const POWERSHELL_SCRIPT = String\.raw`([\s\S]*?)`\n/)
if (!m) {
  console.error('FAIL: 无法从 win32.ts 中提取 POWERSHELL_SCRIPT')
  process.exit(1)
}
const script = m[1]

const mode = process.argv[2] ?? 'fg'

console.log(`[probe] 模式=${mode}`)

const p = spawn(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `$HMode = '${mode}'\n${script}`],
  { windowsHide: true }
)

let out = ''
let err = ''
p.stdout.setEncoding('utf-8')
p.stderr.setEncoding('utf-8')
p.stdout.on('data', (c) => {
  out += c
  process.stdout.write('[stdout] ' + c)
})
p.stderr.on('data', (c) => (err += c))

const timer = setTimeout(() => {
  console.log('\n[probe] 超时，主动结束')
  p.kill()
}, 8000)

p.on('close', (code) => {
  clearTimeout(timer)
  console.log(`\n[probe] 进程退出 code=${code}`)
  if (err.trim()) console.log('[stderr]\n' + err.slice(0, 1200))
  const last = out.trim().split('\n').filter(Boolean).pop()
  if (last) {
    try {
      const obj = JSON.parse(last)
      console.log('[probe] 解析成功:', JSON.stringify(obj).slice(0, 400))
    } catch {
      console.log('[probe] 解析失败:', last.slice(0, 400))
      process.exit(1)
    }
  } else {
    console.log('[probe] 无输出')
    process.exit(1)
  }
  process.exit(0)
})