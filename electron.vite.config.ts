import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { cpSync, mkdirSync } from 'fs'


/**
 * 把 pdfjs 的 worker 文件复制到主进程产物目录。
 *
 * 为什么必须这么做：pdfjs 即使在 disableWorker 模式下，
 * 也会去加载「fake worker」——它把 worker 模块 import 到主线程执行。
 * 打包后 worker 并不在 out/main/ 里，pdfjs 就报
 * “Setting up fake worker failed”。
 * 复制过去之后运行时无需依赖 node_modules，打包后也能用。
 */
function copyPdfjsWorker() {
  return {
    name: 'copy-pdfjs-worker',
    closeBundle() {
      const target = resolve('out/main')
      mkdirSync(target, { recursive: true })
      const src = resolve(
        'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs'
      )
      try {
        cpSync(src, resolve(target, 'pdf.worker.mjs'))
      } catch (e) {
        console.warn('[build] 复制 pdfjs worker 失败：', (e as Error).message)
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [copyPdfjsWorker()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      lib: {
        entry: resolve('src/main/index.ts'),
        // CommonJS 输出：Electron 主进程在 Windows 上对 ESM 的支持
        // 在部分版本上不可靠，而 CJS 稳定且与 preload 保持一致。
        formats: ['cjs'],
        fileName: () => 'index.js'
      },
      rollupOptions: {
        // 只外置 electron 本身；其余依赖打进产物，
        // 保证运行时不需要再解析 node_modules。
        external: ['electron', 'electron/main', 'electron/renderer']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts')
        },
        // 预加载必须保持 CJS：contextIsolation 下 preload 走 CommonJS 加载
        output: { format: 'cjs', entryFileNames: '[name].mjs' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          pet: resolve('src/renderer/pet.html'),
          panel: resolve('src/renderer/panel.html')
        }
      }
    }
  }
})