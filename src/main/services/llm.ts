import type { DeepExplainResult, ChatMessage, Persona } from '../../shared/types'
import { getSettings } from '../store'

/**
 * 云端大模型 / OCR 调用层。
 *
 * 方案书纪律：
 *  - 只走 OpenAI 兼容协议，DeepSeek / 千问 / 豆包随时可切换；
 *  - 支持用户填自有 Key；
 *  - **每次出网都要经过 egress() 上报**，让隐私状态灯如实亮起。
 */

type EgressKind = 'chat' | 'translate' | 'image-gen' | 'ocr'

let egressListener: ((kind: EgressKind, detail: string, provider?: string) => void) | null = null
export function setEgressListener(fn: typeof egressListener): void {
  egressListener = fn
}

function egress(kind: EgressKind, detail: string, provider?: string): void {
  egressListener?.(kind, detail, provider)
}

const PROVIDER_LABEL: Record<string, string> = {
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  doubao: '豆包',
  custom: '自定义'
}

async function chatCompletion(
  messages: { role: string; content: string }[],
  opts: { maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const s = await getSettings()
  if (!s.apiKey) {
    throw new Error('尚未配置 API Key。请在设置中填入自有 Key，或选择其他供应商。')
  }

  egress('chat', `${messages.length} 条消息（对话文本）`, PROVIDER_LABEL[s.provider] ?? s.provider)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 60_000)
  try {
    const res = await fetch(`${s.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`
      },
      body: JSON.stringify({
        model: s.model,
        messages,
        max_tokens: opts.maxTokens ?? 1024,
        temperature: opts.temperature ?? 0.7,
        stream: false
      }),
      signal: controller.signal
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`接口返回 ${res.status}：${body.slice(0, 200)}`)
    }
    const json = (await res.json()) as any
    return json?.choices?.[0]?.message?.content ?? ''
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new Error('请求超时（60 秒）')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** 组装 system prompt：人设 + 记忆 */
export function buildSystemPrompt(persona: Persona, memory: string[]): string {
  const base = [
    `你是「${persona.name}」，一个住在用户电脑桌面上、趴在窗边的小人。`,
    `人设：${persona.description}`,
    `语气：${persona.tone}`,
    `回答要求：默认控制在 3 句话以内；不说客套话；不确定就直说不确定。`
  ]
  if (memory.length > 0) {
    base.push(`你记得关于用户的事：${memory.slice(-8).join('；')}`)
  }
  return base.join('\n')
}

/** 气泡问答 */
export async function ask(question: string, history: ChatMessage[], persona: Persona): Promise<string> {
  const recent = history.slice(-8).map((m) => ({ role: m.role, content: m.content }))
  const answer = await chatCompletion(
    [{ role: 'system', content: buildSystemPrompt(persona, []) }, ...recent, { role: 'user', content: question }],
    { maxTokens: 800 }
  )
  return answer.trim()
}

/** 划词的深度解释：语境、搭配、近义词辨析 */
export async function deepExplain(word: string, context: string): Promise<DeepExplainResult> {
  const prompt = [
    '请解释这个单词在当前语境中的含义，用中文回答。',
    `单词：${word}`,
    context ? `上下文：${context}` : '（无上下文，请给出最常见的义项与常见搭配）',
    '',
    '严格按以下格式输出：',
    'SUMMARY: <一句话结论>',
    'DETAIL: <不超过 150 字的解释，包含语境义、常见搭配与易混词辨析>'
  ].join('\n')

  const text = await chatCompletion([{ role: 'user', content: prompt }], {
    maxTokens: 500,
    temperature: 0.3
  })
  egress('translate', `单词「${word}」的深度解释文本`, '云端 API')

  const summary = text.match(/SUMMARY:\s*(.+)/)?.[1]?.trim() ?? text.slice(0, 80)
  const detail = text.match(/DETAIL:\s*([\s\S]+)/)?.[1]?.trim() ?? text
  return { summary, detail, source: 'cloud-api' }
}

/**
 * 写作小工具（方案书原则四的保留项：在自己窗口内做通用写作辅助，
 * 不触碰任何第三方 IM 进程）。
 */
export async function polishText(text: string, style: 'concise' | 'formal' | 'friendly'): Promise<string> {
  const styleLabel = { concise: '更简洁', formal: '更正式', friendly: '更友好' }[style]
  const prompt = `把下面的文字改写得更${styleLabel}，保持原意与事实不变，只输出改写结果。\n\n${text}`
  const out = await chatCompletion([{ role: 'user', content: prompt }], { maxTokens: 1200, temperature: 0.4 })
  return out.trim()
}

/** 报告当前是否具备可用的云端能力 */
export async function cloudReady(): Promise<{ ready: boolean; label: string; model: string }> {
  const s = await getSettings()
  return {
    ready: Boolean(s.apiKey),
    label: PROVIDER_LABEL[s.provider] ?? s.provider,
    model: s.model
  }
}