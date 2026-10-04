/**
 * 共享类型定义 —— 主进程 / 渲染进程 / 预加载脚本之间唯一的契约来源。
 * 方案书「架构分五层，层与层之间只通过明确定义的接口通信」的落地。
 */

// ==== 文档转换 ====

/** 转换方向 */
export type ConvertDirection = 'word2pdf' | 'pdf2word'

/** 转换实际走的链路（对应方案书表 3 转换引擎矩阵） */
export type ConvertLane =
  | 'com-native' // Office/WPS COM 原生导出，保真最高
  | 'html-print' // docx → HTML → Chromium 打印回退
  | 'pdfjs-rebuild' // pdfjs 解析 + docx 生成
  | 'ocr-rebuild' // OCR → 文本重建 → docx
  | 'manual-required' // 无法自动处理，需人工介入

/** 单个保真项的核对结果（方案书 P0「保真清单逐项打勾」） */
export interface FidelityCheck {
  item: string
  status: 'ok' | 'partial' | 'missing' | 'embedded-as-image'
  note?: string
}

/** 转换请求 */
export interface ConvertRequest {
  /** 输入文件绝对路径 */
  inputPath: string
  direction: ConvertDirection
  /** 输出目录，缺省为输入文件所在目录 */
  outputDir?: string
  /** 指定输出文件名（不含扩展名） */
  outputName?: string
  /** 是否在失败时自动降级到备用链路 */
  allowFallback?: boolean
}

/** 转换结果 */
export interface ConvertResult {
  ok: boolean
  inputPath: string
  outputPath?: string
  lane: ConvertLane
  direction: ConvertDirection
  durationMs: number
  fidelity: FidelityCheck[]
  /** 明确告知用户哪里没保住——方案书要求的「诚实」 */
  degradedNotes: string[]
  error?: string
}

/** 转换历史条目 */
export interface HistoryEntry {
  id: string
  inputPath: string
  outputPath?: string
  inputName: string
  direction: ConvertDirection
  lane: ConvertLane
  ok: boolean
  createdAt: number
  durationMs: number
  degradedNotes: string[]
}

// ==== 划词翻译 ====

export interface LookupResult {
  word: string
  /** 音标，如 /ˈæp.əl/ */
  phonetic?: string
  /** 词义列表 */
  meanings: string[]
  /** 例句 */
  examples: string[]
  /** 词频或标签 */
  labels?: string[]
  /** 数据来源：本地词典 or 云端 API */
  source: 'local-dict' | 'cloud-api'
}

export interface DeepExplainResult {
  summary: string
  detail: string
  source: 'cloud-api' | 'local-fallback'
}

// ==== 对话 ====

export interface Persona {
  name: string
  /** 人设描述，会注入到 system prompt */
  description: string
  /** 说话风格 */
  tone: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  createdAt: number
}

export interface ChatSession {
  id: string
  persona: Persona
  messages: ChatMessage[]
  updatedAt: number
}

// ==== 隐私状态灯（方案书原则二：设置页常亮一盏状态灯）====

/** 此刻是否有数据离开本机 */
export type EgressState = 'idle' | 'chat' | 'translate' | 'image-gen' | 'ocr'

export interface EgressStatus {
  state: EgressState
  /** 正在出网的数据类别描述 */
  detail: string
  /** 出网目标供应商名 */
  provider?: string
  since?: number
}

/** 出网三类内容的枚举——方案书明确「出网的内容只有三类且默认明示」 */
export const EGRESS_CATEGORIES = [
  { id: 'chat', label: '对话与翻译的文本片段', userTriggered: false },
  { id: 'image-gen', label: '照片生成形象时的图片', userTriggered: true },
  { id: 'ocr', label: '扫描件的 OCR', userTriggered: true }
] as const

// ==== 设置 ====

export interface AppSettings {
  /** 云端供应商：OpenAI 兼容协议 */
  provider: 'deepseek' | 'qwen' | 'doubao' | 'custom'
  apiKey: string
  baseUrl: string
  model: string
  /** OCR 引擎选择 */
  ocrEngine: 'cloud' | 'local'
  /** 开机自启（延迟 30 秒） */
  autoLaunch: boolean
  /** 桌宠置顶 */
  alwaysOnTop: boolean
  /** 鼠标穿透 */
  clickThrough: boolean
  /** 空闲降帧目标 */
  idleFps: number
  /** 免费档每日转换额度 */
  dailyFreeQuota: number
  /** 划词监听开关 */
  enableSelectionLookup: boolean
  /** 全局快捷键：截图提问 */
  screenshotShortcut: string
  /** 桌宠形象主题——形象可自定义，这里存的是主题 id */
  petTheme: PetThemeId
}

/** 桌宠形象主题标识（与渲染进程 themes.ts 保持一致） */
export type PetThemeId = 'hearth' | 'spider' | 'dusk' | 'ember' | 'mint' | 'custom'

export const DEFAULT_SETTINGS: AppSettings = {
  provider: 'deepseek',
  apiKey: '',
  baseUrl: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  ocrEngine: 'cloud',
  autoLaunch: false,
  alwaysOnTop: true,
  clickThrough: false,
  idleFps: 8,
  dailyFreeQuota: 5,
  enableSelectionLookup: true,
  screenshotShortcut: 'Alt+A',
  petTheme: 'spider'
}

/** 形象主题的中文名与说明，供设置面板展示 */
export const THEME_OPTIONS: { id: PetThemeId; name: string; desc: string }[] = [
  { id: 'custom', name: '我的形象', desc: '用你自己的图片当桌宠' },
  { id: 'spider', name: '蛛网', desc: '原创卡通蜘蛛侠风格：红蓝配色、蛛网纹理、胸口蜘蛛徽记' },
  { id: 'hearth', name: '围炉', desc: '最初的青绿色小团子' },
  { id: 'dusk', name: '夜色', desc: '安静的深蓝' },
  { id: 'ember', name: '暖阳', desc: '暖色调，适合白天' },
  { id: 'mint', name: '薄荷', desc: '清爽的浅绿' }
]

/** 性能预算（方案书表 4，超标即修） */
export const PERF_BUDGET = {
  idleMemoryMB: 250,
  idleCpuPercent: 2,
  installerMB: 80
} as const

// ==== 窗口行为 ====

export interface WindowInfo {
  handle: number
  title: string
  rect: { x: number; y: number; width: number; height: number }
  visible: boolean
  foreground: boolean
}

// ==== 拖放 ====

export interface DroppedFile {
  path: string
  name: string
  size: number
}