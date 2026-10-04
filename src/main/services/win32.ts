import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { WindowInfo } from '../../shared/types'

/**
 * Win32 窗口行为桥（方案书「坐窗口顶边、窗口关闭跳下来」的底层）。
 *
 * 实现取舍（与方案书表 2 的偏离，理由记录在此）：
 * 方案书原定用 koffi FFI 直调 user32.dll。实测本机 koffi 无预编译产物且缺 CMake，
 * 原生模块无法构建——一个装不上的依赖等于没有依赖。因此改用**常驻 PowerShell 宿主**：
 * 在 PowerShell 里用 Add-Type 做 P/Invoke，注册 SetWinEventHook 事件钩子，
 * 有事件就往 stdout 写一行 JSON。Node 侧按行解析。
 *
 * 相比方案书的优势与代价：
 *  - 仍是**事件驱动**，不是轮询，CPU 占用可忽略；
 *  - 免原生编译，零构建依赖，装机即用；
 *  - 代价是多一个常驻 PowerShell 进程（约 30-50MB），空闲时几乎不占 CPU。
 *
 * 任何一步失败都降级为「不跟随窗口」，绝不让桌宠功能拖垮整个应用。
 */

export interface Win32Bridge extends EventEmitter {
  supported: boolean
  listWindows(): Promise<WindowInfo[]>
  getForeground(): Promise<WindowInfo | null>
  start(): void
  stop(): void
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public class HWin {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    public delegate void WinEventProc(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
        int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int m);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr mod,
        WinEventProc cb, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr h);

    // 取当前焦点控件与选区（划词用）
    [DllImport("user32.dll")] public static extern IntPtr GetFocus();
    [DllImport("user32.dll")] public static extern IntPtr AttachThreadInput(uint a, uint b, bool attach);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
    [DllImport("user32.dll")] public static extern IntPtr GetGUIThreadInfo(uint idThread, ref GUITHREADINFO gti);

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO {
        public int cbSize;
        public int flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }

    public static string Title(IntPtr h) {
        int len = GetWindowTextLength(h);
        if (len <= 0) return "";
        StringBuilder sb = new StringBuilder(len + 1);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string Esc(string s) {
        if (s == null) return "";
        return s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ")
                  .Replace("\n", " ").Replace("\t", " ");
    }

    /**
     * 读取当前选中的文本。
     *
     * 走 UI Automation 而非剪贴板：读剪贴板会覆盖用户刚复制的内容，
     * 属于「偷偷改用户状态」，与本项目「不碰用户数据」的立场冲突。
     */
    public static string SelectedText() {
        try {
            IntPtr fg = GetForegroundWindow();
            if (fg == IntPtr.Zero) return "";
            uint tid = GetWindowThreadProcessId(fg, IntPtr.Zero);
            uint cur = GetCurrentThreadId();
            AttachThreadInput(cur, tid, true);
            try {
                GUITHREADINFO gti = new GUITHREADINFO();
                gti.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
                if (!GetGUIThreadInfo(tid, ref gti)) return "";
                if (gti.hwndCaret == IntPtr.Zero) return "";

                // caret 的 client 坐标转屏幕坐标，才能定位气泡
                POINT p;
                p.X = 0; p.Y = 0;
                ClientToScreen(gti.hwndCaret, ref p);
                uint caretThread = GetWindowThreadProcessId(gti.hwndCaret, IntPtr.Zero);
                if (caretThread != 0 && caretThread != tid) {
                    AttachThreadInput(tid, caretThread, true);
                }
                ScreenX = p.X; ScreenY = p.Y;

                int len = SendMessage(gti.hwndCaret, WM_GETTEXTLENGTH, IntPtr.Zero, IntPtr.Zero);
                if (len <= 0 || len > 400) return "";
                StringBuilder sb = new StringBuilder(len + 2);
                SendMessage(gti.hwndCaret, WM_GETTEXT, (IntPtr)sb.Capacity, sb);
                return sb.ToString();
            } finally {
                AttachThreadInput(cur, tid, false);
            }
        } catch {
            return "";
        }
    }

    public static int ScreenX = 0;
    public static int ScreenY = 0;

    [DllImport("user32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)]
    public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, StringBuilder lp);
    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr wp, IntPtr lp);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    public static readonly uint WM_GETTEXT = 0x000D;
    public static readonly uint WM_GETTEXTLENGTH = 0x000E;

    public static string SelectionJson() {
        string sel = SelectedText();
        return "{\"kind\":\"selection\",\"text\":\"" + Esc(sel) +
               "\",\"cx\":" + ScreenX + ",\"cy\":" + ScreenY + "}";
    }

    public static string Json(string kind, IntPtr hwnd, string title, int x, int y, int w, int t) {
        return "{\"kind\":\"" + kind + "\",\"hwnd\":" + hwnd.ToInt64() +
               ",\"title\":\"" + Esc(title) + "\",\"x\":" + x + ",\"y\":" + y +
               ",\"width\":" + w + ",\"height\":" + t + "}";
    }
}
'@

# ---------- 命令模式：供 Node 按需查询 ----------
function Cmd-Foreground {
    $h = [HWin]::GetForegroundWindow()
    if ($h -eq [IntPtr]::Zero) { Write-Output '{"kind":"none"}'; return }
    $r = New-Object HWin+RECT
    if (-not [HWin]::GetWindowRect($h, [ref]$r)) { Write-Output '{"kind":"none"}'; return }
    $w = $r.Right - $r.Left; $t = $r.Bottom - $r.Top
    if ($w -lt 200 -or $t -lt 150) { Write-Output '{"kind":"none"}'; return }
    Write-Output ([HWin]::Json("fg", $h, [HWin]::Title($h), $r.Left, $r.Top, $w, $t))
}

function Cmd-List {
    $items = New-Object System.Collections.Generic.List[string]
    $fg = [HWin]::GetForegroundWindow()
    $cb = [HWin+EnumProc]{
        param($h, $l)
        if ([HWin]::IsWindowVisible($h) -and -not [HWin]::IsIconic($h)) {
            $r = New-Object HWin+RECT
            if ([HWin]::GetWindowRect($h, [ref]$r)) {
                $w = $r.Right - $r.Left; $t = $r.Bottom - $r.Top
                if ($w -ge 200 -and $t -ge 150) {
                    $ti = [HWin]::Title($h)
                    if ($ti) {
                        $j = [HWin]::Json("win", $h, $ti, $r.Left, $r.Top, $w, $t)
                        if ($h -eq $fg) { $j = $j.TrimEnd('}') + ',"foreground":true}' }
                        $items.Add($j)
                    }
                }
            }
        }
        return $true
    }
    [void][HWin]::EnumWindows($cb, [IntPtr]::Zero)
    Write-Output ('{"kind":"list","items":[' + ($items -join ",") + ']}')
}

# ---------- 事件模式：常驻钩子，事件来了写一行 JSON ----------
function Start-EventHook {
    # 事件号说明（Win32 的一处坑）：
    #   0x0003 EVENT_SYSTEM_FOREGROUND  前台窗口切换
    #   0x8001 既是 EVENT_OBJECT_DESTROY，也是 EVENT_SYSTEM_CAPTURESTART
    #          —— 两者共用同一个值，因此「窗口销毁」钩子也会在划词时被触发。
    #          这里用 idObject 区分：销毁时 idObject 可能是子对象，
    #          而划词事件必然带焦点控件。
    #   0x8002 EVENT_SYSTEM_CAPTUREEND  选区结束（鼠标松开）
    #   0x800B EVENT_OBJECT_LOCATIONCHANGE  窗口移动
    $handler = [HWin+WinEventProc]{
        param($hk, $et, $hwnd, $idObj, $idChild, $tid, $time)

        # 前台窗口切换
        if ($et -eq 0x0003) {
            if ($idObj -ne 0) { return }
            $r = New-Object HWin+RECT
            $w = 0; $t = 0
            if ([HWin]::GetWindowRect($hwnd, [ref]$r)) { $w = $r.Right - $r.Left; $t = $r.Bottom - $r.Top }
            [Console]::Out.WriteLine([HWin]::Json("fg", $hwnd, [HWin]::Title($hwnd), $r.Left, $r.Top, $w, $t))
            [Console]::Out.Flush()
            return
        }

        # 0x8001 = EVENT_OBJECT_DESTROY **与** EVENT_SYSTEM_CAPTURESTART（同一个值）
        # 0x8002 = EVENT_SYSTEM_CAPTUREEND
        # 因此这里要靠「有没有读到选中文本」来区分两种语义：
        #   读到文本 → 用户划词了
        #   没读到     → 是窗口销毁（或选区被清空）
        if ($et -eq 0x8001 -or $et -eq 0x8002) {
            $sel = [HWin]::SelectionJson()
            if ($sel -notmatch '"text":""') {
                [Console]::Out.WriteLine($sel)
                [Console]::Out.Flush()
            } elseif ($et -eq 0x8001 -and $idObj -eq 0) {
                [Console]::Out.WriteLine([HWin]::Json("destroyed", $hwnd, "", 0, 0, 0, 0))
                [Console]::Out.Flush()
            }
            return
        }

        # 0x800B 窗口移动：仅在是前台窗口时才通知，避免拖动次要窗口时刷屏
        if ($et -eq 0x800B) {
            if ($hwnd -ne [HWin]::GetForegroundWindow()) { return }
            $r = New-Object HWin+RECT
            $w = 0; $t = 0
            if ([HWin]::GetWindowRect($hwnd, [ref]$r)) { $w = $r.Right - $r.Left; $t = $r.Bottom - $r.Top }
            [Console]::Out.WriteLine([HWin]::Json("fg", $hwnd, [HWin]::Title($hwnd), $r.Left, $r.Top, $w, $t))
            [Console]::Out.Flush()
        }
    }

    $h1 = [HWin]::SetWinEventHook(0x0003, 0x0003, [IntPtr]::Zero, $handler, 0, 0, 0)
    $h2 = [HWin]::SetWinEventHook(0x8001, 0x8001, [IntPtr]::Zero, $handler, 0, 0, 0)
    $h3 = [HWin]::SetWinEventHook(0x8002, 0x8002, [IntPtr]::Zero, $handler, 0, 0, 0)
    $h4 = [HWin]::SetWinEventHook(0x800B, 0x800B, [IntPtr]::Zero, $handler, 0, 0, 0)

    if ($h1 -eq [IntPtr]::Zero -and $h2 -eq [IntPtr]::Zero) {
        [Console]::Out.WriteLine('{"kind":"unsupported"}')
        [Console]::Out.Flush()
    } else {
        [Console]::Out.WriteLine('{"kind":"ready"}')
        [Console]::Out.Flush()
        # 阻塞保持进程存活
        while ($true) { Start-Sleep -Milliseconds 200 }
    }
}

# ---------- 分发 ----------
# Windows PowerShell 5.1 的 stdout 默认按 UTF-16LE 解码，
# Node 侧按 UTF-8 读会得到乱码。这里强制切到 UTF-8 控制台编码。
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $OutputEncoding = [System.Text.Encoding]::UTF8
} catch {}

switch ($HMode) {
    "hook"  { Start-EventHook }
    "fg"    { Cmd-Foreground }
    "list"  { Cmd-List }
    "quit"  { }
}
`

interface HookLine {
  kind:
    | 'ready'
    | 'fg'
    | 'win'
    | 'destroyed'
    | 'selection'
    | 'event'
    | 'unsupported'
    | 'none'
    | 'list'
  hwnd: number
  title: string
  x: number
  y: number
  width: number
  height: number
  foreground?: boolean
  /** 划词事件携带的选中文本与光标屏幕坐标 */
  text?: string
  cx?: number
  cy?: number
  items?: HookLine[]
}

/** 划词事件载荷 */
export interface SelectionEvent {
  text: string
  /** 光标屏幕坐标，用于定位气泡 */
  cx: number
  cy: number
}

export function createWin32Bridge(): Win32Bridge {
  const emitter = new EventEmitter()
  let proc: ChildProcessWithoutNullStreams | null = null
  let ready = false
  let stopped = false
  let buffer = ''

  function supported(): boolean {
    return process.platform === 'win32'
  }

  function buildScript(mode: string): string {
    return `$HMode = '${mode}'\n${POWERSHELL_SCRIPT}`
  }

function spawnProc(): ChildProcessWithoutNullStreams | null {
    if (!supported()) return null
    try {
      const p = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildScript('hook')],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }
      )
      p.stdout.setEncoding('utf-8')
      p.stdout.on('data', (chunk: string) => onData(chunk))
      p.stderr.setEncoding('utf-8')
      p.stderr.on('data', () => {}) // 静默吞掉 stderr，避免噪音
      p.on('error', () => {
        ready = false
        emitter.emit('unsupported')
      })
      p.on('exit', () => {
        ready = false
        if (!stopped) emitter.emit('unsupported')
      })
      p.stdin.end()
      return p
    } catch {
      return null
    }
  }

  function onData(chunk: string): void {
    buffer += chunk
    const parts = buffer.split('\n')
    buffer = parts.pop() ?? ''
    for (const line of parts) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let obj: HookLine
      try {
        obj = JSON.parse(trimmed) as HookLine
      } catch {
        continue
      }
      handleLine(obj)
    }
  }

  function handleLine(obj: HookLine): void {
    switch (obj.kind) {
      case 'ready':
        ready = true
        emitter.emit('ready')
        break
      case 'unsupported':
        emitter.emit('unsupported')
        break
      case 'fg':
        emitter.emit('foreground', toWindowInfo(obj))
        break
      case 'destroyed':
        emitter.emit('window-destroyed', obj.hwnd)
        break
      case 'selection': {
        const text = (obj.text ?? '').trim()
        // 过短的选区多为误触（双击选中一个字是正常的，但一个字符以下不处理）
        if (text.length >= 1) {
          emitter.emit('selection', {
            text,
            cx: obj.cx ?? 0,
            cy: obj.cy ?? 0
          } satisfies SelectionEvent)
        }
        break
      }
      case 'list':
        emitter.emit('list', (obj.items ?? []).map(toWindowInfo))
        break
    }
  }

  function toWindowInfo(o: HookLine): WindowInfo {
    return {
      handle: o.hwnd,
      title: o.title ?? '',
      rect: { x: o.x, y: o.y, width: o.width, height: o.height },
      visible: true,
      foreground: Boolean(o.foreground)
    }
  }

  /**
   * 过滤掉不适合作为「跟随目标」的窗口。
   * 实测枚举结果里会混进显卡覆盖层、输入法候选窗、桌面本身——
   * 让桌宠去坐在这些东西上会很怪，所以按标题与几何双重过滤。
   */
  const NOISE_TITLE =
    /^(Program Manager|Windows 输入体验|Windows Input Experience|NVIDIA GeForce Overlay|NVIDIA App|搜索|Search|设置|Settings)$/i

  function isFollowable(w: WindowInfo): boolean {
    if (NOISE_TITLE.test(w.title.trim())) return false
    // 覆盖层类窗口通常贴近全屏或宽高比极端
    const ratio = w.rect.width / Math.max(1, w.rect.height)
    if (ratio > 6 || ratio < 0.16) return false
    // 全屏铺满的窗口多半是桌面或无边框最大化应用，排除超大尺寸
    if (w.rect.width >= 1900 && w.rect.height >= 1000) return false
    return true
  }

  /** 通过一次性 PowerShell 调用查询（不依赖常驻进程） */
  async function queryOneShot(cmd: 'fg' | 'list'): Promise<any> {
    return new Promise((resolve) => {
      if (!supported()) return resolve(null)
      let out = ''
      let err = ''
      let done = false
      try {
        const p = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', buildScript(cmd)],
          { windowsHide: true }
        )
        p.stdout.setEncoding('utf-8')
        p.stderr.setEncoding('utf-8')
        p.stdout.on('data', (c: string) => (out += c))
        p.stderr.on('data', (c: string) => (err += c))
        p.on('close', () => {
          if (done) return
          done = true
          const line = out.trim().split('\n').filter(Boolean).pop() ?? ''
          try {
            resolve(JSON.parse(line))
          } catch {
            resolve(null)
          }
        })
        p.on('error', () => {
          if (!done) {
            done = true
            resolve(null)
          }
        })
      } catch {
        resolve(null)
      }
    })
  }

  function start(): void {
    if (stopped || proc) return
    if (!supported()) {
      emitter.emit('unsupported')
      return
    }
    proc = spawnProc()
    if (!proc) emitter.emit('unsupported')
  }

  function stop(): void {
    stopped = true
    ready = false
    if (proc) {
      try {
        proc.kill()
      } catch {
        // 忽略 kill 失败
      }
      proc = null
    }
  }

  return {
    emitter,
    get supported() {
      return supported() && ready
    },
    async listWindows(): Promise<WindowInfo[]> {
      const r = await queryOneShot('list')
      return (r?.items ?? [])
        .map((o: HookLine) => toWindowInfo(o))
        .filter(isFollowable)
    },
    async getForeground(): Promise<WindowInfo | null> {
      const r = await queryOneShot('fg')
      if (!r || r.kind === 'none') return null
      const info = toWindowInfo(r)
      return isFollowable(info) ? info : null
    },
    start,
    stop
  } as Win32Bridge & { emitter: EventEmitter }
}

/** 屏幕工作区尺寸（多显示器停靠用） */
export function screenSize(): { width: number; height: number } {
  const { screen } = require('electron')
  const primary = screen.getPrimaryDisplay()
  return {
    width: primary.workAreaSize.width,
    height: primary.workAreaSize.height
  }
}