/**
 * dsh-tokenrhythm-bill host half: a plain Cordis plugin running in the host
 * process. It reads the provider roster from ~/.dsh/settings.yaml
 * (llm-pi-ai.providers, flow and block layouts alike) plus API keys from
 * ~/.dsh/.credentials.yaml / environment variables, then answers the browser
 * half's JSON calls over the webServer:
 *
 *   /manifest   provider roster + session status (masked)
 *   /models     proxied GET {baseURL}/v1/models (60s cache, 1 retry on 5xx gw)
 *   /balance    proxied tokenrhythm usage-summary + me (web session cookie)
 *   /creds      local credential pool (API key + web cookie): list / add / remove / use
 *   /accounts   tokenrhythm account+password pool (auto re-login on expiry)
 *   /prefs      panel geometry persistence
 *
 * Security boundary: API keys and the session cookie live only in host memory
 * and ~/.dsh/tokenrhythm-bill-state.json (mode 0600); every response to the
 * browser carries masked hints only (e.g. "sk_tr…(49)"), never the secret.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, realpathSync, lstatSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as zc from './zcode.js'
import { fileURLToPath } from 'node:url'
import * as os from 'node:os'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const PKG_VERSION = (() => {
  try { return String(require('../package.json').version || '') } catch { return '' }
})()

// ---- upstreams ----
// 余额只支持基元律动（其控制台在 tokenrhythm.studio）：网页会话 Cookie 才能查
// 余额（API Key 实测 401），模型清单则各提供商都能用各自 Key 查 /v1/models。
const TOKENRHYTHM_BASE = 'https://tokenrhythm.studio'
const MODELS_TTL_MS = 60 * 1000
const UPSTREAM_TIMEOUT_MS = 15 * 1000
const RETRYABLE_STATUS = new Set([502, 503, 504])

// =====================================================================
// 纯函数（导出供 node:test 单测）：YAML 解析 / 归一化 / 掩码
// =====================================================================

// 去掉 YAML 注释：逐字符扫描，字符串（'…" / "…"）内的 # 不算注释；
// # 只有出现在行首或前一个字符是空白时才开启注释。
export function stripYamlComments(text) {
  const s = String(text)
  let out = ''
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') {
      out += c
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; out += c; continue }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) {
      const nl = s.indexOf('\n', i)
      if (nl === -1) break
      i = nl - 1 // keep the newline itself
      continue
    }
    out += c
  }
  return out
}

// 按 sep 切分，但只在深度 0（不在 {} / [] 内、不在字符串内）处切。
function splitTopLevel(s, sep) {
  const parts = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; continue }
    if (c === '{' || c === '[') { depth++; continue }
    if (c === '}' || c === ']') { depth--; continue }
    if (c === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1 }
  }
  parts.push(s.slice(start))
  return parts
}

// 从 from 起找与之配对的右括号，返回 { end, inner }；找不到返回 null。
function matchBracket(text, from, open, close) {
  let depth = 0
  let quote = ''
  for (let i = from; i < text.length; i++) {
    const c = text[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; continue }
    if (c === open) depth++
    else if (c === close) {
      depth--
      if (depth === 0) return { end: i, inner: text.slice(from + 1, i) }
    }
  }
  return null
}

function unquote(v) {
  const s = String(v).trim()
  if (s.length >= 2 && ((s[0] === '\'' && s[s.length - 1] === '\'') || (s[0] === '"' && s[s.length - 1] === '"'))) {
    return s.slice(1, -1)
  }
  return s
}

// 解析 flow 标量 / {map} / [array]。只求能用：标量保留字符串（数字由调用方按需转换）。
function parseFlowValue(s) {
  const t = String(s).trim()
  if (t.startsWith('{')) {
    const m = matchBracket(t, 0, '{', '}')
    return m ? parseFlowMap(m.inner) : null
  }
  if (t.startsWith('[')) {
    const m = matchBracket(t, 0, '[', ']')
    return m ? parseFlowArray(m.inner) : null
  }
  return unquote(t)
}

function parseFlowMap(inner) {
  const out = {}
  for (const raw of splitTopLevel(inner, ',')) {
    const entry = raw.trim()
    if (entry === '') continue
    const i = indexOfTopLevelColon(entry)
    if (i === -1) continue
    const key = unquote(entry.slice(0, i))
    if (key === '') continue
    out[key] = parseFlowValue(entry.slice(i + 1))
  }
  return out
}

function parseFlowArray(inner) {
  const out = []
  for (const raw of splitTopLevel(inner, ',')) {
    const t = raw.trim()
    if (t === '') continue
    out.push(parseFlowValue(t))
  }
  return out
}

// 首个深度 0 的 `: `（key 后必须紧跟值，兼容 "key:" 换行写法——此时返回首个冒号）。
function indexOfTopLevelColon(s) {
  let depth = 0
  let quote = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote !== '') {
      if (c === quote) quote = ''
      continue
    }
    if (c === '\'' || c === '"') { quote = c; continue }
    if (c === '{' || c === '[') { depth++; continue }
    if (c === '}' || c === ']') { depth--; continue }
    if (c === ':' && depth === 0) {
      const next = s[i + 1]
      if (next === undefined || next === ' ' || next === '\t' || next === '\n') return i
    }
  }
  return -1
}

// 把多行文本折成 [{indent, text}]（已去注释、去空行）。tab 按 2 空格折算防呆。
function toLines(text) {
  const lines = []
  for (const raw of String(text).split(/\r?\n/)) {
    const expanded = raw.replace(/\t/g, '  ')
    const t = expanded.trim()
    if (t === '') continue
    lines.push({ indent: expanded.length - expanded.trimStart().length, text: t })
  }
  return lines
}

// block 布局解析：从 lines[i]（缩进 indent 的映射）开始解析嵌套 map / list。
// 返回 { value, next }；next 为该块之后的第一行下标。
function parseBlockMap(lines, i, indent) {
  const out = {}
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.indent < indent) break
    if (ln.indent > indent) { i++; continue } // 容忍意外深缩进：跳过
    const ci = indexOfTopLevelColon(ln.text)
    if (ci === -1) { i++; continue }
    const key = unquote(ln.text.slice(0, ci))
    const rest = ln.text.slice(ci + 1).trim()
    i++
    if (rest === '') {
      // 嵌套块：map 或 list，由下一行是否以 "- " 开头决定。
      if (i < lines.length && lines[i].indent > indent && /^-(\s|$)/.test(lines[i].text)) {
        const lst = parseBlockList(lines, i, lines[i].indent)
        out[key] = lst.value
        i = lst.next
      } else if (i < lines.length && lines[i].indent > indent) {
        const sub = parseBlockMap(lines, i, lines[i].indent)
        out[key] = sub.value
        i = sub.next
      } else {
        out[key] = null
      }
    } else {
      out[key] = parseFlowValue(rest)
    }
  }
  return { value: out, next: i }
}

function parseBlockList(lines, i, indent) {
  const out = []
  while (i < lines.length) {
    const ln = lines[i]
    if (ln.indent !== indent || !/^-(\s|$)/.test(ln.text)) {
      if (ln.indent < indent || (ln.indent === indent && !/^-(\s|$)/.test(ln.text))) break
      i++
      continue
    }
    let item = ln.text.replace(/^-\s*/, '')
    i++
    if (item === '') {
      // "- " 后换行的块项（"- id: x" 不属于这种）。
      if (i < lines.length && lines[i].indent > indent) {
        const sub = parseBlockMap(lines, i, lines[i].indent)
        out.push(sub.value)
        i = sub.next
      } else {
        out.push(null)
      }
    } else if (item.startsWith('{') || item.startsWith('[')) {
      out.push(parseFlowValue(item))
    } else {
      // "- id: x" 形式：首键在 item 里，后续键在更深缩进的行里。
      const ci = indexOfTopLevelColon(item)
      if (ci >= 0 && i < lines.length && lines[i].indent > ln.indent) {
        const firstKey = unquote(item.slice(0, ci))
        const sub = parseBlockMap(lines, i, lines[i].indent)
        out.push({ [firstKey]: parseFlowValue(item.slice(ci + 1)), ...sub.value })
        i = sub.next
      } else if (ci >= 0) {
        const firstKey = unquote(item.slice(0, ci))
        out.push({ [firstKey]: parseFlowValue(item.slice(ci + 1)) })
      } else {
        out.push(parseFlowValue(item))
      }
    }
  }
  return { value: out, next: i }
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const asStr = (v) => (v === undefined || v === null ? '' : String(v)).trim()

function normalizeProviderEntry(id, entry) {
  if (!isObj(entry)) return null
  const modelsRaw = entry.models
  const models = (Array.isArray(modelsRaw) ? modelsRaw : [])
    .map((m) => isObj(m)
      ? { id: asStr(m.id || m.name), name: asStr(m.name || m.id), contextWindow: toNum(m.contextWindow ?? m.context_window) }
      : null)
    .filter((m) => m !== null && m.id !== '')
  const baseURL = asStr(entry.baseURL || entry.base_url)
  return {
    id: asStr(id),
    displayName: asStr(entry.displayName || entry.display_name) || asStr(id),
    apiKeyEnv: asStr(entry.apiKeyEnv || entry.api_key_env),
    baseURL,
    models,
    balanceCapable: /tokenrhythm/i.test(baseURL),
  }
}

/**
 * 解析 settings.yaml 的 llm-pi-ai.providers 段。同时支持 flow（带大括号，本机实际
 * 布局）与 block（缩进式）两种写法；models 支持 { id, name, contextWindow } flow 项
 * 与 `- id:` block 项。解析失败/缺段返回空数组，绝不抛错（面板按「无提供商」展示）。
 * 返回 [{id, displayName, apiKeyEnv, baseURL, models, balanceCapable}]。
 */
export function parseSettingsProviders(text) {
  const clean = stripYamlComments(String(text == null ? '' : text).replace(/\t/g, '  '))
  const lines = toLines(clean)
  // 每个保留行在 clean 里的起始偏移（flow 提取需要精确到字符；与 lines 下标对齐）。
  const offsets = []
  {
    let offset = 0
    for (const raw of clean.split('\n')) {
      if (raw.trim() !== '') offsets.push(offset)
      offset += raw.length + 1
    }
  }
  // 找 providers: 键（任意缩进——真实文件在 llm-pi-ai: 之下）。
  let idx = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^providers\s*:/.test(lines[i].text)) { idx = i; break }
  }
  if (idx === -1) return []
  const rest = lines[idx].text.replace(/^providers\s*:/, '').trim()

  // 判别 flow / block：`providers:` 之后（同行或下一保留行）第一个非空白字符
  // 是 `{` → 外层 flow map；否则按 block 缩进布局解析。
  let valueAt = -1
  if (rest !== '') {
    if (rest.startsWith('{')) valueAt = offsets[idx] + clean.slice(offsets[idx]).indexOf(rest)
  } else if (idx + 1 < lines.length) {
    const start = offsets[idx + 1]
    const tail = clean.slice(start)
    valueAt = start + (tail.length - tail.trimStart().length)
  }
  if (valueAt !== -1 && clean[valueAt] === '{') {
    const m = matchBracket(clean, valueAt, '{', '}')
    if (m === null) return []
    const map = parseFlowMap(m.inner)
    const out = []
    for (const key of Object.keys(map)) {
      const p = normalizeProviderEntry(key, map[key])
      if (p !== null) out.push(p)
    }
    return out
  }

  // block 布局：providers: 换行 + 更深缩进。
  if (idx + 1 < lines.length && lines[idx + 1].indent > lines[idx].indent) {
    const sub = parseBlockMap(lines, idx + 1, lines[idx + 1].indent)
    const out = []
    for (const key of Object.keys(sub.value)) {
      const p = normalizeProviderEntry(key, sub.value[key])
      if (p !== null) out.push(p)
    }
    return out
  }
  return []
}

/**
 * 从 .credentials.yaml 文本里取 envName 对应的键值。行级正则优先（兼容 refs:
 * 嵌套与旧平铺两种布局），再退化为全文内的键值搜索（单行 flow 布局）。
 * 匹配不到返回 null；绝不抛错。
 */
export function extractCredentialFromText(envName, text) {
  const name = String(envName || '').trim()
  if (name === '' || text == null) return null
  const clean = stripYamlComments(String(text))
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '')
    if (/^\s*#/.test(line)) continue
    const m = new RegExp('^\\s*-?\\s*' + esc + '\\s*:\\s*(.*?)\\s*$').exec(line)
    if (m !== null) {
      const v = unquote(m[1].replace(/,\s*$/, ''))
      if (v !== '') return v
    }
  }
  const flow = new RegExp('[,{\\s]' + esc + '\\s*:\\s*([^\\s,}\\]]+)')
  const fm = flow.exec(clean)
  if (fm !== null) {
    const v = unquote(fm[1])
    if (v !== '') return v
  }
  return null
}

const toNum = (v) => {
  if (v === undefined || v === null || v === '') return null
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
const toBool = (v) => {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === 'object') return true
  const s = String(v).trim().toLowerCase()
  if (s === 'true' || s === '1' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'no' || s === '') return false
  return null
}
// 依次尝试候选键，返回第一个可用的数值/布尔。
function pickNum(obj, keys) {
  for (const k of keys) { const n = toNum(obj[k]); if (n !== null) return n }
  return null
}
function pickBool(obj, keys) {
  for (const k of keys) { const b = toBool(obj[k]); if (b !== null) return b }
  return null
}

/**
 * 归一化 /v1/models 返回：容忍 {data:[…]} 信封或裸数组；字段名多候选兼容，
 * 数值解析失败记 null 不抛错。字段见实施文档 §5.1 Model。
 */
export function normalizeModels(json) {
  const list = Array.isArray(json)
    ? json
    : (isObj(json) && Array.isArray(json.data) ? json.data : [])
  const out = []
  for (const raw of list) {
    if (!isObj(raw)) continue
    const id = asStr(raw.id || raw.model || raw.name)
    if (id === '') continue
    const rc = isObj(raw.responses_capabilities) ? raw.responses_capabilities : {}
    const inPrice = pickNum(raw, ['input_price_per_million', 'inputPricePerMillion', 'input_price', 'prompt_price_per_million'])
    const outPrice = pickNum(raw, ['output_price_per_million', 'outputPricePerMillion', 'output_price', 'completion_price_per_million'])
    const cachePrice = pickNum(raw, ['cache_price_per_million', 'cachePricePerMillion', 'cache_read_price_per_million', 'cached_input_price_per_million', 'cache_read_input_price_per_million'])
    const effIn = pickNum(raw, ['effective_input_price_per_million', 'effectiveInputPricePerMillion', 'effective_input_price', 'discount_input_price_per_million'])
    const effOut = pickNum(raw, ['effective_output_price_per_million', 'effectiveOutputPricePerMillion', 'effective_output_price', 'discount_output_price_per_million'])
    const effCache = pickNum(raw, ['effective_cache_price_per_million', 'effectiveCachePricePerMillion', 'effective_cache_read_price_per_million', 'effective_cache_price', 'discount_cache_read_price_per_million'])
    const responses = (() => {
      const direct = toBool(raw.supports_responses)
      if (direct !== null) return direct
      return Object.keys(rc).length > 0
    })()
    out.push({
      id,
      contextLength: pickNum(raw, ['context_length', 'contextLength', 'context_window', 'max_context_tokens']),
      maxOutput: pickNum(raw, ['max_output_tokens', 'maxOutput', 'max_completion_tokens', 'max_tokens', 'output_token_limit']),
      currency: asStr(raw.currency) || 'CNY',
      inPrice,
      outPrice,
      cachePrice,
      effInPrice: effIn,
      effOutPrice: effOut,
      effCachePrice: effCache,
      hasDiscount: toBool(raw.has_discount) ?? (() => {
        const pairs = [[effIn, inPrice], [effOut, outPrice], [effCache, cachePrice]]
        let any = false
        for (const [eff, base] of pairs) {
          if (eff !== null && base !== null && eff < base) any = true
        }
        return any
      })(),
      tools: pickBool(raw, ['supports_tools', 'tool_call', 'function_calling']) ?? toBool(raw.tools) ?? false,
      reasoning: pickBool(raw, ['supports_reasoning', 'reasoning', 'thinking']) ?? false,
      vision: pickBool(raw, ['supports_vision', 'vision', 'multimodal']) ?? false,
      responses,
      webSearch: toBool(rc.webSearch) ?? toBool(rc.web_search) ?? false,
    })
  }
  return out
}

// 解 {data:{…}} 信封；非对象原样返回。
function unwrapEnvelope(json) {
  return isObj(json) && isObj(json.data) ? json.data : json
}

/**
 * 归一化平台「模型列表」页接口（/api/models，会话 Cookie）：比 /v1/models 多出
 * 显示名 / 类型（chat|image）/ 模态 / 图片单价。分类口径与平台一致：
 *   文本 = type chat、图像 = type image、视频/音频/向量 = capabilities 对应位。
 * 返回与 normalizeModels 同构的 Model（多 name / perImagePrice / categories）。
 */
export function normalizePlatformModels(json) {
  // 信封形态：[数组] / {data:[数组]} / {data:{list:[数组]}}。
  let list = []
  if (Array.isArray(json)) list = json
  else if (isObj(json) && Array.isArray(json.data)) list = json.data
  else if (isObj(json) && isObj(json.data) && Array.isArray(json.data.list)) list = json.data.list
  const out = []
  for (const raw of list) {
    if (!isObj(raw)) continue
    const id = asStr(raw.id)
    if (id === '') continue
    const caps = isObj(raw.capabilities) ? raw.capabilities : {}
    const modalities = Array.isArray(raw.modalities) ? raw.modalities.map(asStr) : []
    const kind = asStr(raw.type) || 'chat'
    const categories = []
    if (kind === 'chat') categories.push('text')
    if (kind === 'image') categories.push('image')
    if (modalities.includes('video') || toBool(caps.video) === true) categories.push('video')
    if (toBool(caps.audio) === true) categories.push('audio')
    if (toBool(caps.embeddings) === true) categories.push('vector')
    const inPrice = toNum(raw.inputPrice)
    const outPrice = toNum(raw.outputPrice)
    const cachePrice = toNum(raw.cacheReadPrice)
    const effIn = toNum(raw.effectiveInputPrice)
    const effOut = toNum(raw.effectiveOutputPrice)
    const effCache = toNum(raw.effectiveCacheReadPrice)
    out.push({
      id,
      name: asStr(raw.name) || id,
      // 来源（无问 / DeepSeek / 阿里云…）：取平台 providerBrands 品牌名列表——
      // 同一模型可能经多个上游提供（如 deepseek 同时标 DeepSeek/阿里云/无问），
      // 缺失时回退 providerDisplayName → provider 键。
      provider: (Array.isArray(raw.providerBrands) && raw.providerBrands.length > 0
        ? [...new Set(raw.providerBrands
            .map((b) => (isObj(b) ? asStr(b.providerBrandName) : ''))
            .filter((s) => s !== ''))].join(' / ')
        : '') || asStr(raw.providerDisplayName) || asStr(raw.provider),
      platformStatus: asStr(raw.status) || null,
      kind,
      categories,
      contextLength: toNum(raw.contextWindow),
      maxOutput: toNum(raw.maxOutputTokens),
      currency: asStr(raw.currency) || 'CNY',
      inPrice,
      outPrice,
      cachePrice,
      effInPrice: effIn,
      effOutPrice: effOut,
      effCachePrice: effCache,
      hasDiscount: toBool(raw.hasDiscount) ?? ([effIn, effOut, effCache].some((eff, i) => {
        const base = [inPrice, outPrice, cachePrice][i]
        return eff !== null && base !== null && eff < base
      })),
      tools: toBool(caps.tools) ?? false,
      reasoning: toBool(caps.reasoning) ?? false,
      vision: toBool(caps.vision) ?? false,
      responses: toBool(caps.responses) ?? false,
      webSearch: false,
      perImagePrice: toNum(raw.pricePerImage),
    })
  }
  return out
}

/** 分类计数（全部/文本/图像/音频/视频/向量），与平台「模型列表」页口径一致。 */
export function categoryCounts(models) {
  const counts = { all: 0, text: 0, image: 0, audio: 0, video: 0, vector: 0 }
  for (const m of models) {
    counts.all++
    for (const c of m.categories || []) {
      if (counts[c] !== undefined) counts[c]++
    }
  }
  return counts
}

/**
 * 归一化余额：/api/usage-summary + /api/me。容忍 {data:{…}} 信封与 snake_case
 * 变体；字段缺失记 null。字段含义（平台实测）：
 *   balanceCny 账户余额 / availableBalanceCny 可用 / frozenBalanceCny 冻结 /
 *   expiringBalanceCny 限时额度（到期失效部分）/ nextExpiryAt 最近到期时间
 */
/**
 * 从 /api/me 响应提取账户名（name > nickname > username > email > id）。
 * 容忍 {data:{…}} 信封与脏数据；全部缺失返回空串。Cookie 模式下
 * manifest / session 路由用它标注「数据账号」。
 */
export function accountNameFromMe(meJson) {
  const me = isObj(meJson) ? unwrapEnvelope(meJson) : {}
  return [me.name, me.nickname, me.username, me.email, me.id]
    .map(asStr).find((v) => v !== '') || ''
}

export function normalizeBalance(summaryJson, meJson, expiringJson) {
  const s = unwrapEnvelope(summaryJson) || {}
  const account = accountNameFromMe(meJson)
  return {
    balanceCny: pickNum(s, ['balanceCny', 'balance', 'availableBalanceCny', 'available_balance_cny']),
    availableBalanceCny: pickNum(s, ['availableBalanceCny', 'available_balance_cny']),
    frozenBalanceCny: pickNum(s, ['frozenBalanceCny', 'frozen_balance_cny']),
    expiringBalanceCny: pickNum(s, ['expiringBalanceCny', 'expiring_balance_cny']),
    nextExpiryAt: asStr(s.nextExpiryAt || s.next_expiry_at) || null,
    // 逐笔限时额度以 /api/wallet/expiring-credits 为权威（expiringJson），
    // 该接口请求失败（null/undefined）时回退 usage-summary 深扫兜底。
    expiringItems: normalizeExpiringCredits(expiringJson) ?? extractExpiringItems(summaryJson),
    inputTokens: pickNum(s, ['inputTokens', 'input_tokens']),
    outputTokens: pickNum(s, ['outputTokens', 'output_tokens']),
    costCny: pickNum(s, ['totalCostCny', 'total_cost_cny', 'costCny', 'cost_cny', 'cost']),
    calls: pickNum(s, ['calls']),
    successCalls: pickNum(s, ['successCalls', 'success_calls']),
    currency: asStr(s.currency) || 'CNY',
    account,
    fetchedAt: Date.now(),
  }
}

// ---- 逐笔限时额度提取 ----
// 平台字段名未长期稳定：先试已知候选键，再深度扫描兜底——数组中每项同时含
// 「金额字段」与「到期时间字段」即认。按到期时间升序；缺失/为空返回 []。
const EXPIRING_LIST_KEYS = [
  'expiringItems', 'expiring_items', 'expiringList', 'expiring_list',
  'gifts', 'giftList', 'gift_list', 'grants', 'promotions', 'promotionList',
  'quotaList', 'quota_list', 'quotas', 'presentList', 'present_list', 'rewards',
]
const MONEY_KEY_RE = /(amount|balance|quota|money|cny|price|value)/i
const TIME_KEY_RE = /(expire|expiry|expir|deadline|end.?time|end.?at|valid|due|until)/i
const NAME_KEY_RE = /(name|title|label|remark|desc|source|note)/i

const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v)
// 金额容错直接复用上方 toNum（数字 / 带千分位的数字串都认）
// 时间形态：ISO/日期串、秒或毫秒时间戳
const isTimeLike = (v) => (typeof v === 'string' && /\d{4}-\d{2}-\d{2}/.test(v))
  || (isFiniteNum(v) && v > 1e9)

function toExpireAtMs(v) {
  if (isFiniteNum(v)) return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const t = Date.parse(v)
    return Number.isFinite(t) ? t : null
  }
  return null
}

/** 从单个明细对象里抠出 { name?, amountCny, expireAt(ISO) }；缺金额或时间则丢弃。 */
function parseExpiringItem(item) {
  if (!isObj(item)) return null
  let amountCny = null
  let expireMs = null
  let name = ''
  for (const [key, value] of Object.entries(item)) {
    if (amountCny === null && !TIME_KEY_RE.test(key) && MONEY_KEY_RE.test(key)) {
      const n = toNum(value)
      if (n !== null) amountCny = n
    }
    if (expireMs === null && isTimeLike(value) && TIME_KEY_RE.test(key)) expireMs = toExpireAtMs(value)
    if (name === '' && typeof value === 'string' && NAME_KEY_RE.test(key) && !TIME_KEY_RE.test(value)) name = value
  }
  if (amountCny === null || expireMs === null || !Number.isFinite(expireMs)) return null
  const out = { amountCny, expireAt: new Date(expireMs).toISOString() }
  if (name !== '') out.name = name
  return out
}

const sortByExpire = (items) => items.slice().sort((a, b) => Date.parse(a.expireAt) - Date.parse(b.expireAt))

/** 深度扫描（≤4 层）：找到第一个「每项都能抠出金额+时间」的数组即收工。 */
function deepScanExpiring(node, depth) {
  if (depth > 4 || !isObj(node) && !Array.isArray(node)) return []
  if (Array.isArray(node)) {
    const items = node.map(parseExpiringItem).filter(Boolean)
    if (items.length > 0 && items.length >= Math.ceil(node.length / 2)) return sortByExpire(items)
    return []
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value) || isObj(value)) {
      const hit = deepScanExpiring(value, depth + 1)
      if (hit.length > 0) return hit
    }
  }
  return []
}

/**
 * 从 /api/usage-summary 提取逐笔限时额度 [{name?, amountCny, expireAt(ISO)}]。
 * 候选键直取 → 深度扫描兜底；任何形态都取不到时返回 []（UI 侧据此不渲染悬浮卡）。
 */
export function extractExpiringItems(summaryJson) {
  const s = summaryJson && isObj(summaryJson) ? unwrapEnvelope(summaryJson) : null
  if (!s) return []
  for (const key of EXPIRING_LIST_KEYS) {
    const arr = s[key]
    if (!Array.isArray(arr) || arr.length === 0) continue
    const items = arr.map(parseExpiringItem).filter(Boolean)
    if (items.length > 0) return sortByExpire(items)
  }
  return deepScanExpiring(s, 0)
}

/**
 * 归一化 /api/wallet/expiring-credits 响应（逐笔限时额度的权威来源，平台实测形态：
 * data.list[] = {id, source, sourceLabel, grantedCny, remainingCny, grantedAt, expiresAt}，
 * data.summary = {expiringBalanceCny, nextExpiryAt}）。
 * 映射为 [{name?, amountCny(剩余), expireAt}] 按到期升序；响应不可用（非对象信封 /
 * 无 list 数组）返回 null，调用方回退 usage-summary 深扫；剩余 ≤0 的条目丢弃。
 */
export function normalizeExpiringCredits(expiringJson) {
  const d = expiringJson && isObj(expiringJson) ? unwrapEnvelope(expiringJson) : null
  if (!d || !Array.isArray(d.list)) return null
  const items = []
  for (const raw of d.list) {
    if (!isObj(raw)) continue
    const amountCny = toNum(raw.remainingCny ?? raw.remaining_cny)
    const expireMs = Date.parse(asStr(raw.expiresAt || raw.expires_at))
    if (amountCny === null || amountCny <= 0 || !Number.isFinite(expireMs)) continue
    const name = asStr(raw.sourceLabel || raw.source_label || raw.source)
    const item = { amountCny, expireAt: new Date(expireMs).toISOString() }
    if (name !== '') item.name = name
    items.push(item)
  }
  return sortByExpire(items)
}

// ---- 更新检测（npm dist-tags 比对）----

/** 解析 v?x.y.z[-prerelease] 的数字三元组；不可解析返回 null。 */
const parseVersionTriple = (value) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value || '').trim())
  return m === null ? null : [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** remote 是否比 local 新（仅比较三元组，忽略 prerelease 后缀）；任一不可解析返回 false。 */
export function isNewerVersion(local, remote) {
  const a = parseVersionTriple(local)
  const b = parseVersionTriple(remote)
  if (a === null || b === null) return false
  for (let i = 0; i < 3; i++) {
    if (b[i] !== a[i]) return b[i] > a[i]
  }
  return false
}

/** 从 registry dist-tags 响应提取 latest 版本串；兼容 {latest} 与 {dist-tags:{latest}} 两形态，无合法版本返回 null。 */
export function normalizeDistTags(json) {
  const d = isObj(json) ? json : {}
  const tags = isObj(d['dist-tags']) ? d['dist-tags'] : d
  const latest = asStr(tags.latest)
  return parseVersionTriple(latest) !== null ? latest : null
}

/** 更新状态持久化字段清洗：只留合法键（版本串必须可解析，时间必须为正数）。 */
export function sanitizeUpdate(raw) {
  if (!isObj(raw)) return {}
  const out = {}
  const latest = asStr(raw.latestVersion)
  if (parseVersionTriple(latest) !== null) out.latestVersion = latest
  const checkedAt = toNum(raw.checkedAt)
  if (checkedAt !== null && checkedAt > 0) out.checkedAt = checkedAt
  const current = asStr(raw.currentAtCheck)
  if (parseVersionTriple(current) !== null) out.currentAtCheck = current
  const ignored = asStr(raw.ignoredVersion)
  if (parseVersionTriple(ignored) !== null) out.ignoredVersion = ignored
  return out
}

/** 入口胶囊余额模式清洗：只认 total（总余额）/ expiring（限时总余额），其余返回 null。 */
export function sanitizeEntryBalance(v) {
  return v === 'total' || v === 'expiring' ? v : null
}

/** 安装模式：检查各 profile 的 node_modules 安装项——是符号链接（junction）且指向本包 → 'local'，
 * 否则 npm 副本。不能用 import.meta.url 的 realpath 比较：Node 解析默认 realpath，
 * 经 junction 加载时模块路径已是真实路径，跟谁比都相等。 */
export function detectInstallMode(home = (process.env.DSH_HOME && String(process.env.DSH_HOME)) || join(os.homedir(), '.dsh')) {
  try {
    const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)))
    const profiles = join(home, 'profiles')
    for (const name of existsSync(profiles) ? readdirSync(profiles) : []) {
      const entry = join(profiles, name, 'node_modules', 'dsh-tokenrhythm-bill')
      try {
        if (!lstatSync(entry).isSymbolicLink()) continue
        if (realpathSync(entry) === root) return 'local'
      } catch { /* 跳过坏条目 */ }
    }
  } catch { return 'npm' }
  return 'npm'
}

/** 掩码：前 5 位…(长度)，如 "sk_tr…(49)"；空值返回空串。 */
export function maskSecret(value) {
  const s = String(value || '')
  if (s === '') return ''
  return s.slice(0, 5) + '…(' + s.length + ')'
}

// 从粘贴内容里提取 tr_session 的值：兼容整段 Cookie / "tr_session=sess_x" / 裸 sess_x。
export function extractSessionCookie(input) {
  const s = String(input || '').trim()
  if (s === '') return ''
  const m = /tr_session\s*=\s*([A-Za-z0-9._-]+)/.exec(s)
  if (m !== null) return m[1]
  if (/^[A-Za-z0-9._-]+$/.test(s)) return s
  return ''
}

// 从粘贴内容里提取 tr_csrf 的值（CSRF 双提交令牌，与 tr_session 同源下发）；
// 仅当用户粘贴整段 Cookie 时可能带上，裸 session 粘贴则没有（走自愈补取）。
export function extractCsrfCookie(input) {
  const s = String(input || '').trim()
  if (s === '') return ''
  const m = /tr_csrf\s*=\s*([A-Za-z0-9._-]+)/.exec(s)
  return m !== null ? m[1] : ''
}

/**
 * 账号列表净化（宿主持久化用）：只接受 {account, password}，去掉空项与超长值。
 * 明文密码按用户要求保存在本机 state 文件（0600），供面板内查看与一键登录。
 */
export function sanitizeAccounts(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (!isObj(raw)) continue
    const account = asStr(raw.account)
    const password = typeof raw.password === 'string' ? raw.password : ''
    if (account === '' || account.length > 64 || password.length > 256) continue
    const key = account.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ account, password, addedAt: toNum(raw.addedAt) ?? Date.now() })
  }
  return out
}

/**
 * 已存账号里挑选自动重登凭据（「cookie 即身份」的保守守卫）：
 * 仅当 activeAccount 非空且命中（大小写不敏感）且有密码时返回该条目；
 * activeAccount 为空（纯 cookie 粘贴 / 身份未知 / 未命中）一律 null ——
 * 宁可不自动重登，也绝不把 A 账号重登到 B 的会话上。
 */
export function pickReloginAccount(state) {
  if (!isObj(state)) return null
  const active = typeof state.activeAccount === 'string' ? state.activeAccount.trim().toLowerCase() : ''
  if (active === '' || !Array.isArray(state.accounts)) return null
  for (const a of state.accounts) {
    if (isObj(a) && typeof a.account === 'string' && a.account.toLowerCase() === active
      && typeof a.password === 'string' && a.password !== '') return a
  }
  return null
}

// =====================================================================
// 本机凭据池（密钥页录入的 API Key + 会话 Cookie）
// =====================================================================

/**
 * 凭据池净化：每条 = { id, apiKey, cookie, cookieRaw, csrf, addedAt }。
 * cookie 按 tr_session 提取（整段 Cookie / "tr_session=…" / 裸值都认）；cookieRaw 保留用户粘贴的
 * 原文（整段 Cookie 照原样留着，列表要完整展示并可一键复制）；csrf 仅整段 Cookie 时才有，
 * 缺了也能用（写操作时平台会下发新配对）。
 * 最多 20 条；id 去重；apiKey 与 cookie 至少一项非空才算有效条目。
 */
export function sanitizeCreds(input) {
  if (!Array.isArray(input)) return []
  const seen = new Set()
  const out = []
  for (const raw of input) {
    if (!isObj(raw)) continue
    const id = asStr(raw.id).trim()
    const apiKey = asStr(raw.apiKey).trim()
    const cookieRaw = typeof raw.cookieRaw === 'string' ? raw.cookieRaw
      : (typeof raw.cookie === 'string' ? raw.cookie : '')
    const cookie = extractSessionCookie(cookieRaw)
    if (id === '' || seen.has(id) || (apiKey === '' && cookie === '')) continue
    seen.add(id)
    out.push({
      id,
      apiKey,
      cookie,
      cookieRaw: cookieRaw.trim().slice(0, 4096),
      csrf: extractCsrfCookie(cookieRaw),
      addedAt: toNum(raw.addedAt) ?? Date.now(),
    })
    if (out.length >= 20) break
  }
  return out
}

/** 当前选中的凭据条目（activeCred 命中池中 id 时返回，否则 null——绝不返回悬空凭据）。 */
export function activeCredOf(state) {
  if (!isObj(state) || !Array.isArray(state.creds)) return null
  const id = asStr(state.activeCred).trim()
  if (id === '') return null
  for (const c of state.creds) {
    if (isObj(c) && asStr(c.id) === id) return c
  }
  return null
}

/**
 * 凭据余额快照净化：{ [credId]: { cny, avail, at } }（密钥页列表上的「最近余额」）。
 * 只保留凭据池里仍存在的 id；金额/时间非法即丢弃——宁可显示「尚未查询」也不虚构数字。
 */
export function sanitizeCredBalances(input, creds) {
  const out = {}
  if (!isObj(input)) return out
  const alive = new Set((Array.isArray(creds) ? creds : []).map((c) => asStr(c && c.id)))
  for (const id of Object.keys(input)) {
    const v = input[id]
    if (!alive.has(id) || !isObj(v)) continue
    const cny = toNum(v.cny)
    const at = toNum(v.at)
    if (cny === null || at === null || at <= 0) continue
    const avail = toNum(v.avail)
    out[id] = { cny, avail: avail === null ? null : avail, at }
  }
  return out
}

// =====================================================================
// Cordis 插件半区：路由注册（全部包在 effect 里，卸载即回收）
// =====================================================================

export const name = 'dsh-tokenrhythm-bill'

export const inject = ['webServer']

export function apply(ctx) {
  // ---- DSH 目录与文件 ----
  const dshDir = () => (process.env.DSH_HOME && String(process.env.DSH_HOME))
    || (typeof os !== 'undefined' && os.homedir ? join(os.homedir(), '.dsh') : null)
  const settingsPath = () => { const d = dshDir(); return d === null ? null : join(d, 'settings.yaml') }
  const credentialsPath = () => { const d = dshDir(); return d === null ? null : join(d, '.credentials.yaml') }
  // 会话 Cookie + 面板几何都存这个文件（0600），不进浏览器、不进 settings。
  const statePath = () => { const d = dshDir(); return d === null ? null : join(d, 'tokenrhythm-bill-state.json') }
  // 旧项目名（dsh-model-balance）时代的 state 文件：新文件缺失时读它做一次性迁移。
  const legacyStatePath = () => { const d = dshDir(); return d === null ? null : join(d, 'model-balance-state.json') }

  const readTextSafe = (file) => {
    if (file === null) return ''
    try { return existsSync(file) ? readFileSync(file, 'utf8') : '' } catch { return '' }
  }

  // ---- 持久化状态（cookie / 账号列表 / 凭据池 / prefs）：读写都 best-effort ----
  // creds = 本机凭据池（密钥页录入的 API Key + 会话 Cookie）；activeCred = 当前选中凭据的 id。
  let stateLoaded = false
  let state = { cookie: '', csrf: '', prefs: {}, accounts: [], activeAccount: '', update: {}, creds: [], activeCred: '', credBalances: {} }

  const loadState = () => {
    if (stateLoaded) return state
    stateLoaded = true
    const file = statePath()
    if (file === null) return state
    let text = readTextSafe(file)
    if (text.trim() === '') text = readTextSafe(legacyStatePath()) // 迁移：旧名 state 兜底
    try {
      const data = JSON.parse(text)
      if (isObj(data)) {
        if (typeof data.cookie === 'string') state.cookie = data.cookie
        if (typeof data.csrf === 'string') state.csrf = data.csrf
        if (typeof data.activeAccount === 'string') state.activeAccount = data.activeAccount
        if (isObj(data.prefs)) state.prefs = data.prefs
        state.accounts = sanitizeAccounts(data.accounts)
        state.update = sanitizeUpdate(data.update)
        state.creds = sanitizeCreds(data.creds)
        if (typeof data.activeCred === 'string') state.activeCred = data.activeCred
        // 选中的凭据已不在池里（例如手工改过 state 文件）→ 视为未选中，不留悬空 id。
        if (activeCredOf(state) === null) state.activeCred = ''
        // 每条凭据「最后一次查询到的余额」（密钥页列表展示用）。
        state.credBalances = sanitizeCredBalances(data.credBalances, state.creds)
      }
    } catch { /* 不可读 → 空状态 */ }
    return state
  }
  const saveState = () => {
    const file = statePath()
    if (file === null) return
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ cookie: state.cookie, csrf: state.csrf, prefs: state.prefs, accounts: state.accounts, activeAccount: state.activeAccount, update: state.update, creds: state.creds, activeCred: state.activeCred, credBalances: state.credBalances, savedAt: Date.now() }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
    } catch { /* best-effort：丢持久化不丢功能 */ }
  }

  const sanitizePrefs = (input) => {
    const out = {}
    if (!isObj(input)) return out
    if (isObj(input.panel)) {
      const p = input.panel
      const panel = {}
      for (const k of ['x', 'y', 'w', 'h']) {
        const n = toNum(p[k])
        if (n !== null) panel[k] = n
      }
      if (Object.keys(panel).length > 0) out.panel = panel
    }
    const eb = sanitizeEntryBalance(input.entryBalance)
    if (eb !== null) out.entryBalance = eb
    // ZCode 集成总开关（默认关闭——插件面向所有用户，读 ~/.zcode/v2 凭证必须显式
    // 开启）。只在请求显式携带时才写入：面板几何等其它 prefs POST 不覆盖此开关。
    if (input.zcode !== undefined) out.zcode = input.zcode === true
    return out
  }

  // ---- provider / 凭据解析（每次现读，改 settings 即时生效）----
  const readProviders = () => {
    const file = settingsPath()
    const text = readTextSafe(file)
    if (text.trim() === '') return { providers: [], error: (file === null ? '无法定位 DSH 目录' : 'settings.yaml 为空或不可读') }
    try {
      return { providers: parseSettingsProviders(text), error: null }
    } catch (err) {
      return { providers: [], error: 'settings.yaml 解析失败: ' + String((err && err.message) || err) }
    }
  }
  // env 变量优先（同音乐插件 readCredential 的次序），其次凭据文件 refs。
  const resolveKey = (provider) => {
    if (!provider || provider.apiKeyEnv === '') return ''
    try {
      const fromEnv = process.env && process.env[provider.apiKeyEnv]
      if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
    } catch { /* env 不可用 → 落到文件 */ }
    return extractCredentialFromText(provider.apiKeyEnv, readTextSafe(credentialsPath())) || ''
  }
  // 生效 API Key：密钥页选中的凭据优先（有 Key 就用它），否则回落 settings/env 解析出的 Key。
  const effectiveKey = (provider) => {
    const cred = activeCredOf(state)
    if (cred !== null && cred.apiKey !== '') return cred.apiKey
    return resolveKey(provider)
  }
  // 凭据池状态摘要（给面板的轻量信息）：active = 当前选用条目 id，null = 未选用。
  const activeCredSummary = () => {
    const cur = activeCredOf(state)
    return {
      active: cur === null ? null : cur.id,
      hasKey: cur !== null && cur.apiKey !== '',
      hasCookie: cur !== null && cur.cookie !== '',
      count: Array.isArray(state.creds) ? state.creds.length : 0,
    }
  }

  // ---- /models 上游代理（60s 缓存 + 5xx 网关错重试 1 次）----
  const modelsCache = new Map() // providerId -> { models, ts }
  const fetchWithTimeout = async (url, init) => {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS)
    try {
      return await fetch(url, { ...init, signal: ac.signal })
    } finally {
      clearTimeout(timer)
    }
  }
  const fetchUpstreamModels = async (provider, key) => {
    // baseURL 已以 /v1 等版本段结尾（settings 实际布局）时直接接 /models，
    // 否则补 /v1/models —— 避免拼出 /v1/v1/models。
    const base = provider.baseURL.replace(/\/+$/, '')
    const url = /\/v\d+$/.test(base) ? base + '/models' : base + '/v1/models'
    const init = { headers: { Authorization: 'Bearer ' + key } }
    let res = await fetchWithTimeout(url, init)
    if (RETRYABLE_STATUS.has(res.status)) res = await fetchWithTimeout(url, init)
    const bodyText = await res.text()
    let json = null
    try { json = JSON.parse(bodyText) } catch { /* 非 JSON → 按状态码报错 */ }
    if (!res.ok) {
      const detail = isObj(json) && json.error ? String(json.error.message || json.error) : bodyText.slice(0, 200)
      const err = new Error('上游 ' + res.status + ': ' + detail)
      err.status = res.status
      throw err
    }
    return normalizeModels(json)
  }

  // ---- /balance 上游代理（网页会话 Cookie）----
  // 当日使用与花费趋势共用同一份 call-logs 分页（见 fetchUsageTrend），不再各自翻页——
  // 旧实现当日卡最多串行 10 页、趋势图又把今天的页重拉一遍，同样的日志每次刷新
  // 被平台吐两遍，且当日卡封顶 1000 次与趋势图数字对不上。
  const DAILY_LOG_PAGE_SIZE = 100

  // ---- 花费趋势：最近 7 个有调用记录的日子（本地日分桶 + 按模型细分）----
  // 口径（用户指定）：不是最近 7 个日历日，而是「最近 7 个有使用记录的日子」——无调用
  // 的日子不留痕、也不占柱位，与用量页 7 日图同语义。取数自适应早停：最新优先翻页，
  // 已凑满 7 个有记录日、且最老一条记录早于第 7 新有记录日的 0 点（该日已完整）即停；
  // 90 天窗口内仍凑不满或触顶，则如实标注 truncated，不装准。
  // 当日使用卡片直接取今天的分桶（分页最新优先，今天的记录天然在最新几页且完整）。
  // 实测：pageSize 被服务端锁死 100（500 直接 400），但响应带 total。
  const TREND_TTL_MS = 5 * 60 * 1000 // 全量重翻间隔
  const TREND_TOPUP_TTL_MS = 60 * 1000 // 60s 内直接吃缓存；60s~5min 只补拉今天（1~2 页）
  const TREND_DAYS = 7
  const TREND_WINDOW_DAYS = 90
  const TREND_MAX_PAGES = 60
  const TREND_BATCH = 6
  const TREND_TOP_MODELS = 6
  // 缓存按账号隔离（state.activeAccount）：切换账号后旧账号的缓存不会被发给新账号，
  // 切回原账号也能立刻命中它自己的缓存，而不是看到别的账号的 ¥0。
  const trendCaches = new Map() // activeAccount -> { data, ts, buckets }

  const makeBucket = (dayStart) => ({
    key: dayStart.toDateString(),
    t: dayStart.getTime(),
    date: (dayStart.getMonth() + 1) + '-' + dayStart.getDate(),
    costCny: 0,
    calls: 0,
    successCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    models: new Map(),
  })

  // 把一页日志灌进分桶（toDateString 即本地时区日期）；字段口径：snake_case 兜底、
  // 非法数值按 0。返回本批已见最老记录的时间戳（无有效记录返回 Infinity）。
  const ingestInto = (buckets, list) => {
    let oldest = Infinity
    for (const item of list) {
      if (!isObj(item)) continue
      const t = new Date(item.requestAt || item.time || '')
      if (Number.isNaN(t.getTime())) continue
      const ts = t.getTime()
      if (ts < oldest) oldest = ts
      const dayStart = new Date(t)
      dayStart.setHours(0, 0, 0, 0)
      const key = dayStart.toDateString()
      let b = buckets.get(key)
      if (!b) {
        b = makeBucket(dayStart)
        buckets.set(key, b)
      }
      const cost = toNum(item.costCny) ?? 0
      b.costCny += cost
      b.calls++
      if (toNum(item.status) === 200) b.successCalls++
      b.inputTokens += toNum(item.inputTokens ?? item.input_tokens) ?? 0
      b.outputTokens += toNum(item.outputTokens ?? item.output_tokens) ?? 0
      b.cacheReadTokens += toNum(item.cacheReadTokens ?? item.cache_read_tokens) ?? 0
      const name = asStr(item.model || item.requestModelId) || '未知模型'
      const m = b.models.get(name) || { costCny: 0, calls: 0 }
      m.costCny += cost
      m.calls++
      b.models.set(name, m)
    }
    return oldest
  }

  // 桶 → 图数据：只取最近 7 个有调用记录的日子（无记录日不留痕、不占柱位），按时间
  // 升序给图；模型明细按花费降序只保留 Top N，尾部聚合成「其他」行控制 payload 体积。
  const buildTrendDays = (buckets) => [...buckets.values()]
    .filter((b) => b.calls > 0)
    .sort((a, b) => b.t - a.t)
    .slice(0, TREND_DAYS)
    .sort((a, b) => a.t - b.t)
    .map((b) => {
      const ranked = [...b.models.entries()]
        .map(([model, m]) => ({ model, costCny: Math.round(m.costCny * 1e4) / 1e4, calls: m.calls }))
        .sort((x, y) => y.costCny - x.costCny)
      let models = ranked
      if (ranked.length > TREND_TOP_MODELS) {
        const tail = ranked.slice(TREND_TOP_MODELS)
        models = ranked.slice(0, TREND_TOP_MODELS)
        models.push({
          model: '其他 ' + tail.length + ' 个模型',
          costCny: Math.round(tail.reduce((acc, m) => acc + m.costCny, 0) * 1e4) / 1e4,
          calls: tail.reduce((acc, m) => acc + m.calls, 0),
        })
      }
      return { date: b.date, costCny: Math.round(b.costCny * 1000) / 1000, calls: b.calls, models }
    })

  // 当日使用卡片数据：今天的桶直读。旧实现当日卡封顶 10 页=1000 次、趋势图却拉全，
  // 同一面板两个「今天」数字互相矛盾；现在同源同数。
  const dailyFromBuckets = (buckets, todayStart) => {
    const b = buckets.get(todayStart.toDateString())
    return {
      inputTokens: b ? b.inputTokens : 0,
      outputTokens: b ? b.outputTokens : 0,
      cacheReadTokens: b ? b.cacheReadTokens : 0,
      costCny: b ? Math.round(b.costCny * 1e6) / 1e6 : 0,
      calls: b ? b.calls : 0,
      successCalls: b ? b.successCalls : 0,
      fetched: b ? b.calls : 0,
      since: todayStart.toISOString(),
    }
  }

  const fetchLogPage = async (cookie, page, startIso, endIso) => {
    const headers = trHeaders(cookie)
    const qs = 'startAt=' + encodeURIComponent(startIso) + '&endAt=' + encodeURIComponent(endIso)
      + '&page=' + page + '&pageSize=' + DAILY_LOG_PAGE_SIZE
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        let res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/call-logs/page?' + qs, { headers })
        // 5xx 网关错重试 1 次（与 /models 代理同口径）。
        if (RETRYABLE_STATUS.has(res.status)) res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/call-logs/page?' + qs, { headers })
        if (!res.ok) return null
        return await res.json().catch(() => null)
      } catch { if (attempt > 0) return null }
    }
    return null
  }

  // 只补拉今天：余额面板 60s 自动刷新，全量重翻不必跟着这么勤——缓存 60s~5min 之间
  // 只拉 1~2 页把今天的桶换新（页数按缓存里今天的调用量估）。覆盖判据：补拉页里
  // 最老一条记录早于今天 0 点（翻过了午夜线，今天必已完整），或整个窗口本就无记录。
  // 翻不过去（今天调用暴涨超出估计）或拉页失败 → 返回 null，走全量重翻。
  const topupToday = async (cookie, hit) => {
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const start = new Date(todayStart)
    start.setDate(start.getDate() - TREND_WINDOW_DAYS)
    const startIso = start.toISOString()
    const endIso = new Date().toISOString()
    const pages = Math.min(TREND_MAX_PAGES, Math.ceil((hit.data.daily ? hit.data.daily.calls : 0) / DAILY_LOG_PAGE_SIZE) + 1)
    const temp = new Map()
    let oldest = Infinity
    let ok = true
    for (let p = 1; p <= pages; p++) {
      const j = await fetchLogPage(cookie, p, startIso, endIso)
      if (j === null) { ok = false; break }
      const d = unwrapEnvelope(j)
      const list = isObj(d) && Array.isArray(d.list) ? d.list : []
      oldest = Math.min(oldest, ingestInto(temp, list))
      if (list.length < DAILY_LOG_PAGE_SIZE) break
    }
    if (!ok) return null
    const todayKey = todayStart.toDateString()
    if (oldest === Infinity || oldest < todayStart.getTime()) {
      // 已越过今天 0 点（或窗口内根本没有记录）：今天的桶可信，直接换新；
      // 今天的调用/花费由此恢复完整，dailyPartial 解除。
      const tb = temp.get(todayKey)
      if (tb) hit.buckets.set(todayKey, tb)
      else hit.buckets.delete(todayKey)
    } else {
      return null
    }
    hit.data = {
      ...hit.data,
      days: buildTrendDays(hit.buckets),
      daily: dailyFromBuckets(hit.buckets, todayStart),
      dailyPartial: false,
    }
    hit.ts = Date.now()
    return hit.data
  }

  const fetchUsageTrendFull = async (cookie, cacheKey) => {
    const start = new Date()
    start.setDate(start.getDate() - TREND_WINDOW_DAYS)
    start.setHours(0, 0, 0, 0)
    const end = new Date()
    const startIso = start.toISOString()
    const endIso = end.toISOString()
    // 按需建桶（有记录的日子才有桶）；models 供柱状图悬停明细。
    const buckets = new Map()
    let oldestSeen = Infinity
    let fetchedCount = 0 // 只当计数用：不把最多 6000 条原始记录整个攥在内存里
    let pageFailed = false
    // 第一页失败不可静默：最新的 100 条（通常就是今天）缺了、更早的页面照常灌桶，
    // 早停判据照样成立——会得到一张「完整却缺了今天」的趋势图。宁可整体失败，
    // 让当日卡显示 —、趋势图整块缺席，也不装完整。
    const first = await fetchLogPage(cookie, 1, startIso, endIso)
    if (first === null) throw new Error('call-logs 第一页拉取失败')
    const firstData = unwrapEnvelope(first)
    const firstList = isObj(firstData) && Array.isArray(firstData.list) ? firstData.list : []
    const total = isObj(firstData) && Number.isFinite(Number(firstData.total)) ? Number(firstData.total) : 0
    fetchedCount += firstList.length
    oldestSeen = Math.min(oldestSeen, ingestInto(buckets, firstList))
    // 完整性判据：非空日凑满 7 个、且已见最老记录早于第 7 新有记录日的 0 点（该日已完整）；
    // 或 90 天窗口内记录已全部拉取（本来就凑不满 7 天，有多少展示多少）；
    // 或窗口内本就无记录（第一页成功且空、total=0，不算截断）。
    // 任一页拉取失败则永不判完整：缺页的数据不能冒充全量。
    const emptyWindow = firstList.length === 0 && total === 0
    const completenessNeed = () => {
      const active = [...buckets.values()].filter((b) => b.calls > 0).sort((a, b) => b.t - a.t)
      return active.length >= TREND_DAYS ? active[TREND_DAYS - 1].t : null
    }
    const complete = () => {
      if (pageFailed) return false
      if (emptyWindow) return true
      const need = completenessNeed()
      if (need !== null && oldestSeen < need) return true
      return total > 0 && fetchedCount >= total
    }
    for (let p = 2; p <= TREND_MAX_PAGES && !complete(); p += TREND_BATCH) {
      const batch = []
      for (let q = p; q < p + TREND_BATCH && q <= TREND_MAX_PAGES; q++) batch.push(q)
      const parts = await Promise.all(batch.map((pg) => fetchLogPage(cookie, pg, startIso, endIso)))
      let any = false
      for (const j of parts) {
        if (j === null) { pageFailed = true; continue }
        const d = unwrapEnvelope(j)
        if (isObj(d) && Array.isArray(d.list) && d.list.length > 0) {
          fetchedCount += d.list.length
          oldestSeen = Math.min(oldestSeen, ingestInto(buckets, d.list))
          any = true
        }
      }
      if (pageFailed || !any) break // 缺页要如实截断；整批无数据=越界/异常，后续页不会再有新记录
    }
    const todayStart = new Date()
    todayStart.setHours(0, 0, 0, 0)
    const result = {
      days: buildTrendDays(buckets),
      daily: dailyFromBuckets(buckets, todayStart),
      truncated: !complete(),
      dailyPartial: pageFailed,
      fetched: fetchedCount,
      total,
    }
    trendCaches.set(cacheKey, { data: result, ts: Date.now(), buckets })
    // 简单防膨胀：账号数远小于上限，超限清理最旧的一个即可。
    if (trendCaches.size > 12) {
      let oldestKey = null
      let oldestTs = Infinity
      for (const [k, v] of trendCaches) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k }
      }
      if (oldestKey !== null) trendCaches.delete(oldestKey)
    }
    return result
  }

  // 入口：60s 内直接吃缓存；60s~5min 只补拉今天；超 5min（或补拉失败）全量重翻。
  const fetchUsageTrend = async (cookie) => {
    // 缓存按「当前凭据 / 账号」隔离：切换凭据或账号后旧缓存不会被发给新身份，
    // 切回原身份也能立刻命中它自己的缓存，而不是看到别人的 ¥0。
    const cacheKey = activeCredOf(state) !== null ? 'cred:' + state.activeCred : (state.activeAccount || '_')
    const hit = trendCaches.get(cacheKey)
    if (hit) {
      const age = Date.now() - hit.ts
      if (age < TREND_TOPUP_TTL_MS) return hit.data
      if (age < TREND_TTL_MS) {
        const topped = await topupToday(cookie, hit).catch(() => null)
        if (topped !== null) return topped
      }
    }
    return fetchUsageTrendFull(cookie, cacheKey)
  }

  // ---- 最近调用（24h 内最新 10 条，给面板的「最近调用」折叠列表）----
  const fetchRecentCalls = async (cookie) => {
    const end = new Date()
    const start = new Date(end.getTime() - 24 * 3600 * 1000)
    const qs = 'startAt=' + encodeURIComponent(start.toISOString()) + '&endAt=' + encodeURIComponent(end.toISOString())
      + '&page=1&pageSize=10'
    const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/call-logs/page?' + qs, { headers: trHeaders(cookie) })
    if (!res.ok) return []
    const json = await res.json().catch(() => null)
    const data = unwrapEnvelope(json)
    const list = isObj(data) && Array.isArray(data.list) ? data.list : []
    return list.slice(0, 10).map((item) => ({
      model: asStr(item.model || item.requestModelId),
      status: toNum(item.status),
      latencyMs: toNum(item.latencyMs),
      costCny: toNum(item.costCny),
      inputTokens: toNum(item.inputTokens),
      outputTokens: toNum(item.outputTokens),
      t: asStr(item.requestAt || item.time || ''),
    }))
  }

  // ---- 平台请求统一头：实测网关对无 UA 的请求偶发 504，带上浏览器式头更稳。
  // 变更请求（POST/DELETE…）平台还做 CSRF 双提交 + fetch-metadata 校验：
  // 需 Origin/Sec-Fetch-*（浏览器自动带，node fetch 必须手动补）与
  // X-CSRF-Token（值 = tr_csrf cookie，随会话下发），缺失即 403 CSRF_INVALID。----
  const trHeaders = (cookie, csrf) => ({
    Cookie: csrf ? 'tr_session=' + cookie + '; tr_csrf=' + csrf : 'tr_session=' + cookie,
    Accept: 'application/json',
    'Content-Type': 'application/json', // 变更类请求 body 是 JSON 串；缺它平台按 text/plain 解析 → 400 请求参数类型错误
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Referer: TOKENRHYTHM_BASE + '/account',
    Origin: TOKENRHYTHM_BASE,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
  })

  // ---- 账号密码登录平台（密码只在本次请求内存中出现）----
  const loginOnPlatform = async (account, password) => {
    let res
    try {
      res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ account, password }),
      })
    } catch (err) {
      return { ok: false, error: '登录请求失败：' + String((err && err.message) || err) }
    }
    if (res.status === 401) return { ok: false, error: '账号或密码错误' }
    if (!res.ok) {
      let detail = ''
      try {
        const j = await res.json()
        if (isObj(j) && typeof j.message === 'string') detail = j.message
      } catch { /* 非 JSON 错误体 */ }
      return { ok: false, error: '登录失败（平台 ' + res.status + '）' + (detail ? '：' + detail : '') }
    }
    let cookie = ''
    let csrf = ''
    try {
      const cookies = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/)
      for (const line of cookies) {
        const m = /tr_session=([^;\s]+)/.exec(line)
        if (m !== null) cookie = m[1]
        const c = /tr_csrf=([^;\s]+)/.exec(line)
        if (c !== null) csrf = c[1]
      }
    } catch { /* 取不到 Set-Cookie → 按失败处理 */ }
    if (cookie === '') return { ok: false, error: '登录成功但未返回会话，请改用粘贴方式' }
    return { ok: true, cookie, csrf }
  }

  // ---- 逐笔限时额度（/api/wallet/expiring-credits，page/pageSize 分页）。----
  // 任一页失败按「首页前失败 → null（回退深扫）/ 中途失败 → 已得条目」降级，
  // 不阻塞余额主数据。
  const EXPIRING_PAGE_SIZE = 50
  const EXPIRING_MAX_PAGES = 5
  const fetchExpiringCredits = async (cookie) => {
    const headers = trHeaders(cookie)
    const merged = []
    for (let page = 1; page <= EXPIRING_MAX_PAGES; page++) {
      const res = await fetchWithTimeout(
        TOKENRHYTHM_BASE + '/api/wallet/expiring-credits?page=' + page + '&pageSize=' + EXPIRING_PAGE_SIZE,
        { headers },
      ).catch(() => null)
      const body = res !== null && res.ok ? await res.json().catch(() => null) : null
      const list = body && isObj(body.data) && Array.isArray(body.data.list) ? body.data.list : []
      if (res === null || !res.ok) return page === 1 ? null : { data: { list: merged } }
      merged.push(...list)
      const total = isObj(body.data) && Number.isFinite(Number(body.data.total)) ? Number(body.data.total) : 0
      if (list.length === 0 || merged.length >= total) break
    }
    return { data: { list: merged } }
  }

  const fetchUpstreamBalance = async (cookie, retried) => {
    const headers = trHeaders(cookie)
    const [summaryRes, meRes, expiring] = await Promise.all([
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/usage-summary', { headers }),
      fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers }).catch(() => null),
      fetchExpiringCredits(cookie),
    ])
    if (summaryRes.status === 401 || (meRes !== null && meRes.status === 401)) {
      // 会话过期：用当前绑定账号自动重登一次（无绑定/重登失败 → 维持原报错），
      // 成功后用新 cookie 整体重试（retried 防递归）。
      if (retried !== true && (await reloginActive())) return fetchUpstreamBalance(state.cookie, true)
      const err = new Error('session expired')
      err.code = 'SESSION_EXPIRED'
      throw err
    }
    if (!summaryRes.ok) {
      const err = new Error('usage-summary 上游 ' + summaryRes.status)
      err.status = summaryRes.status
      throw err
    }
    const summary = await summaryRes.json().catch(() => null)
    const me = meRes !== null && meRes.ok ? await meRes.json().catch(() => null) : null
    const [trendAll, recent] = await Promise.all([
      fetchUsageTrend(cookie).catch(() => null),
      fetchRecentCalls(cookie).catch(() => null),
    ])
    return {
      ...normalizeBalance(summary, me, expiring),
      daily: trendAll ? trendAll.daily : null,
      trend: trendAll && Array.isArray(trendAll.days) ? trendAll.days : [],
      trendMeta: trendAll ? {
        truncated: !!trendAll.truncated,
        dailyPartial: !!trendAll.dailyPartial,
        fetched: trendAll.fetched || 0,
        total: trendAll.total || 0,
      } : null,
      recent,
    }
  }

  // Cookie 模式账户名缓存：manifest / session 路由标注「数据账号」用。
  // 以 cookie 为键（换会话自动失效），TTL 10 分钟；请求失败静默返回 null，
  // 前端回退「未登录（Cookie 模式）」文案——标注用途，宁可缺不阻塞。
  const meAccount = { cookie: '', name: null, ts: 0 }
  const ME_ACCOUNT_TTL_MS = 10 * 60 * 1000
  const fetchMeAccountName = async (cookie) => {
    if (cookie === '') return null
    if (meAccount.cookie === cookie && meAccount.name && Date.now() - meAccount.ts < ME_ACCOUNT_TTL_MS) return meAccount.name
    try {
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers: trHeaders(cookie) })
      if (!res.ok) return null
      const name = accountNameFromMe(await res.json().catch(() => null))
      if (name === '') return null
      meAccount.cookie = cookie
      meAccount.name = name
      meAccount.ts = Date.now()
      return name
    } catch { return null }
  }

  // ---- 会话验活（区别于 fetchMeAccountName 的名字缓存：只认实时 200）。
  // 成功结果缓存 60 秒，manifest 每次打开不必都打平台；失败不缓存，可立即重试。----
  let sessionProbeCache = { cookie: '', valid: false, name: null, ts: 0 }
  const PROBE_TTL_MS = 60 * 1000
  const probeSession = async (cookie) => {
    if (cookie === '') return { valid: false, name: null }
    if (sessionProbeCache.cookie === cookie && Date.now() - sessionProbeCache.ts < PROBE_TTL_MS) {
      return { valid: sessionProbeCache.valid, name: sessionProbeCache.name }
    }
    try {
      const res = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/me', { headers: trHeaders(cookie) })
      if (res.status !== 200) return { valid: false, name: null }
      const name = accountNameFromMe(await res.json().catch(() => null))
      const out = { valid: name !== '', name: name || null }
      if (out.valid) sessionProbeCache = { cookie, valid: true, name: out.name, ts: Date.now() }
      return out
    } catch { return { valid: false, name: null } }
  }

  // ---- 会话自动续期：cookie 失效（401）时用「当前绑定账号」的已存密码重登一次。
  // 绑定只由账号密码登录写入（/auth/login、/accounts/add、/accounts/login）；密钥页选用的
  // 凭据会话不绑账号（activeAccount 为空），不存在绑定绝不自动重登；
  // 30 秒冷却防平台故障时反复打登录接口。成功更新 cookie/csrf/activeAccount 并落盘。----
  let lastReloginAt = 0
  const RELOGIN_COOLDOWN_MS = 30 * 1000
  const reloginActive = async () => {
    loadState()
    if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) return false
    const acc = pickReloginAccount(state)
    if (acc === null) return false
    lastReloginAt = Date.now()
    const r = await loginOnPlatform(acc.account, acc.password)
    if (!r.ok) return false
    state.cookie = r.cookie
    if (r.csrf) state.csrf = r.csrf
    state.activeAccount = acc.account
    saveState()
    return true
  }



  // ================= ZCode 桌面端（额度展示 + 活动领取） =================
  // 移植自 zcode-switch v1.5.4（MIT）：读 ~/.zcode/v2 的凭证文件、按 ZCode 桌面端
  // 同款请求头直连官方接口。凭据/token/user_id 只在 host 内存，浏览器只见掩码；
  // 领取的验证码在 host 伺服的弹窗页完成（CSP 拦截时回退 127.0.0.1 一次性端口）。
  // 注意：.zcode 属于 ZCode 客户端，与 DSH 目录无关，永远用真实 HOME。
  // ZCode 集成总开关：prefs.zcode === true 才允许读 ~/.zcode/v2 凭证/发上游请求。
  // 插件面向所有用户发放，默认关闭，设置弹窗里显式开启。
  const zcodeEnabled = () => {
    loadState()
    return isObj(state.prefs) && state.prefs.zcode === true
  }
  const zcodeDisabledResponse = () => ({ ok: false, code: 'ZCODE_DISABLED', error: 'ZCode 集成未开启（设置 → ZCode 集成）' })
  const zcodeHomeDir = () => (typeof process.env.HOME === 'string' && process.env.HOME !== '' ? process.env.HOME : os.homedir())
  const zcodeV2File = (name) => join(zcodeHomeDir(), '.zcode', 'v2', name)
  const readZcodeJson = (name) => {
    const text = readTextSafe(zcodeV2File(name))
    if (text.trim() === '') return null
    try { return JSON.parse(text) } catch { return null }
  }
  const zcodeDeviceMid = () => {
    const t = readZcodeJson('telemetry-state.json')
    return t !== null && isObj(t) && typeof t.deviceMid === 'string' && t.deviceMid !== '' ? t.deviceMid : null
  }
  // 统一上游请求：按 URL 域选头（z.ai = 桌面端九件套伪装，bigmodel = 精简三件套）。
  // noAuth: 事件上报 Rust 版只带 Content-Type；emptyAuth: 验证码配置带空 Bearer。
  const zcFetchJson = async (url, token, mid, opts) => {
    const o = opts || {}
    const base = o.noAuth === true ? [] : (url.includes('zcode.z.ai') ? zc.zaiHeaders(token, mid) : zc.bigmodelHeaders(token))
    const headers = { ...Object.fromEntries(base), ...(o.headers || {}) }
    if (o.noAuth === true) headers['Content-Type'] = 'application/json'
    const res = await fetchWithTimeout(url, {
      method: o.method || 'GET',
      headers,
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
    })
    const text = await res.text().catch(() => '')
    let json = null
    if (text !== '') { try { json = JSON.parse(text) } catch { json = null } }
    return { status: res.status, json }
  }
  const zcodeErrMsg = (r, fallback) => {
    if (r !== null && isObj(r.json)) {
      const code = typeof r.json.code === 'number' ? r.json.code : null
      const msg = ['msg', 'message', 'error'].map((k) => (typeof r.json[k] === 'string' ? r.json[k] : '')).find((s) => s !== '') || ''
      if (code === 401) return 'Token 已过期或无效'
      if (msg !== '') return msg
      if (code !== null) return '上游业务错误 ' + code
    }
    return fallback
  }
  // 额度查询：单 token 双通道（bigmodel monitor → 失败回退 z.ai billing），
  // 与 zcode-switch query_with_token 同构。
  const zcodeQueryWithToken = async (token, mid) => {
    let bestErr = null
    try {
      const limit = await zcFetchJson(zc.QUOTA_LIMIT_URL, token, mid)
      if (limit.json !== null && zc.businessOk(limit.json)) {
        const sub = await zcFetchJson(zc.SUBSCRIPTION_URL, token, mid).catch(() => null)
        const ov = zc.normalizeQuotaLimit(limit.json, sub !== null ? sub.json : null)
        ov.source = 'bigmodel.cn/api/monitor'
        return ov
      }
      bestErr = zcodeErrMsg(limit, 'bigmodel 额度接口返回不可解析')
    } catch (err) {
      bestErr = String((err && err.message) || err)
    }
    try {
      const bal = await zcFetchJson(zc.BILLING_BALANCE_URL + '?app_version=' + encodeURIComponent(zc.zcodeAppVersion()), token, mid)
      if (bal.json !== null && zc.businessOk(bal.json)) {
        const ov = zc.normalizeBalance(bal.json)
        ov.source = 'zcode.z.ai/billing'
        return ov
      }
      // 端点不匹配的 401 不应掩盖 bigmodel 侧的业务错（对齐 zcode-switch 用例）：
      // z.ai 侧只有在还没拿到任何错误时才补位。
      if (bestErr === null) {
        bestErr = zcodeErrMsg(bal, 'z.ai 余额接口返回不可解析')
      }
    } catch (err) {
      if (bestErr === null) bestErr = String((err && err.message) || err)
    }
    throw new Error(bestErr || '额度查询失败')
  }
  // 多通道合并（mergeParts 简化版）：跨源同 tier+name 的切片去重，顶层取最高档切片。
  const zcodeMergeParts = (parts) => {
    if (parts.length === 1) return parts[0]
    const slots = []
    const slotSrc = []
    const sources = []
    for (const p of parts) {
      if (!sources.includes(p.source)) sources.push(p.source)
      for (const s of (Array.isArray(p.slots) ? p.slots : [])) {
        const dup = slots.some((t, i) => slotSrc[i] !== p.source && t.tier === s.tier && t.name === s.name
          && (t.items || []).length > 0 && (s.items || []).length > 0)
        if (!dup) { slots.push(s); slotSrc.push(p.source) }
      }
    }
    const items = slots.flatMap((s) => s.items || [])
    let pri = null
    for (const s of slots) {
      const has = s.tier !== null || (s.items || []).length > 0 || s.total !== null
      if (!has) continue
      if (pri === null || zc.tierRankOf(s.tier) > zc.tierRankOf(pri.tier)) pri = s
    }
    return {
      source: sources.join(' + '),
      planTier: pri ? pri.tier : null,
      planExpire: pri ? pri.expire : null,
      total: pri ? pri.total : null,
      used: pri ? pri.used : null,
      remaining: pri ? pri.remaining : null,
      percentUsed: pri ? pri.percentUsed : null,
      isEmpty: slots.length === 0,
      items,
      slots,
    }
  }
  const ZCODE_QUOTA_TTL_MS = 60 * 1000
  let zcodeQuotaCache = null
  let zcodeQuotaBusy = null
  // 全量额度：优先按 config 的 provider 段建双通道（start-plan → z.ai billing，
  // coding-plan → bigmodel monitor），没有通道再退 candidate tokens 逐个试。
  const fetchZcodeQuota = async (force) => {
    if (!force && zcodeQuotaCache !== null && Date.now() - zcodeQuotaCache.ts < ZCODE_QUOTA_TTL_MS) {
      return { ok: true, ...zcodeQuotaCache.data, cached: true }
    }
    if (zcodeQuotaBusy !== null) return zcodeQuotaBusy
    zcodeQuotaBusy = (async () => {
      const creds = readZcodeJson('credentials.json')
      if (creds === null || !isObj(creds)) {
        return { ok: false, code: 'NO_CREDENTIALS', error: '未找到 ZCode 登录凭证（~/.zcode/v2/credentials.json 不存在或不可读）' }
      }
      const config = readZcodeJson('config.json')
      const mid = zcodeDeviceMid()
      const secret = zc.defaultSecret(zcodeHomeDir())
      const identity = zc.identityFromCredentials(creds, secret)
      const parts = []
      let sawNoPlan = false
      let bestErr = null
      const tryOnce = async (fn) => {
        try { parts.push(await fn()) } catch (err) {
          const msg = String((err && err.message) || err)
          if (msg.includes('不存在coding plan') || msg.includes('没有资格')) sawNoPlan = true
          else if (bestErr === null) bestErr = msg
        }
      }
      // 通道构造（pick_channels 移植）：enabled 优先排序。
      if (config !== null && isObj(config) && isObj(config.provider)) {
        const ordered = Object.entries(config.provider)
          .sort(([, a], [, b]) => (isObj(b) && b.enabled === true ? 0 : 1) - (isObj(a) && a.enabled === true ? 0 : 1))
        for (const [pid, p] of ordered) {
          const apiKey = isObj(p) && isObj(p.options) && typeof p.options.apiKey === 'string'
            && !p.options.apiKey.startsWith('enc:') && zc.looksLikeToken(p.options.apiKey) ? p.options.apiKey : null
          if (pid.includes('start-plan')) {
            const jwt = zc.decryptCredential(creds.zcodejwttoken, secret)
            const active = zc.decryptCredential(creds['oauth:active_provider'], secret)
            const useJwt = pid.startsWith('builtin:zai') ? jwt !== null : (jwt !== null && active === 'bigmodel')
            const tok = (useJwt ? jwt : null) || apiKey
            if (tok !== null) await tryOnce(() => zcodeQueryWithToken(tok, mid))
          } else if (pid.includes('coding-plan') && apiKey !== null) {
            await tryOnce(() => zcodeQueryWithToken(apiKey, mid))
          }
        }
      }
      if (parts.length === 0) {
        const tokens = zc.candidateTokens(creds, config, secret)
        for (const tok of tokens) {
          const before = parts.length
          await tryOnce(() => zcodeQueryWithToken(tok, mid))
          if (parts.length > before) break
        }
      }
      if (parts.length === 0) {
        if (sawNoPlan) return { ok: true, source: 'no_plan', planTier: null, planExpire: null, total: null, used: null, remaining: null, percentUsed: null, isEmpty: true, items: [], slots: [], fetchedAt: Date.now() }
        return { ok: false, code: 'QUOTA_FAIL', error: bestErr || '额度查询失败（没有可用的 token 候选）' }
      }
      const data = zcodeMergeParts(parts)
      data.fetchedAt = Date.now()
      data.identity = {
        provider: identity.provider,
        name: identity.displayName || identity.username || identity.email || null,
      }
      data.deviceLinked = mid !== null
      zcodeQuotaCache = { data, ts: Date.now() }
      return { ok: true, ...data }
    })()
    try { return await zcodeQuotaBusy } finally { zcodeQuotaBusy = null }
  }
  // ---- 活动领取：激活埋点（软失败，不阻塞 preview）→ preview → 验证码 → claim ----
  const zcodeLoadClaimContext = () => {
    const creds = readZcodeJson('credentials.json')
    if (creds === null || !isObj(creds)) return { error: '未找到 ZCode 登录凭证（~/.zcode/v2/credentials.json 不存在或不可读）', code: 'NO_CREDENTIALS' }
    const config = readZcodeJson('config.json')
    const mid = zcodeDeviceMid()
    const secret = zc.defaultSecret(zcodeHomeDir())
    const token = zc.claimToken(creds, config, secret)
    if (token === null || !zc.looksLikeToken(token)) {
      return { error: '该账号缺少可用的领取凭证（zcodejwttoken），请先在 ZCode 客户端登录一次刷新', code: 'NO_TOKEN' }
    }
    return { creds, config, mid, secret, token }
  }
  const zcodeReportActivation = async (token, mid) => {
    const creds = readZcodeJson('credentials.json')
    const userId = creds !== null ? zc.telemetryUserId(creds, zc.defaultSecret(zcodeHomeDir())) : null
    if (userId === null || mid === null) return { activated: false, activationError: null }
    for (const element of zc.ACTIVATION_EVENTS) {
      try {
        const r = await zcFetchJson(zc.EVENT_REPORT_URL, token, mid, {
          method: 'POST', noAuth: true, body: zc.activationEventBody(element, randomUUID(), userId, mid),
        })
        if (r.json === null || r.json.code !== 0) {
          return { activated: false, activationError: zcodeErrMsg(r, '激活上报失败') }
        }
      } catch (err) {
        return { activated: false, activationError: '激活上报失败：' + String((err && err.message) || err) }
      }
    }
    return { activated: true, activationError: null }
  }
  const zcodeCaptchaConfig = async (mid) => {
    const r = await zcFetchJson(zc.CLIENT_CONFIGS_URL, '', mid)
    return zc.parseCaptchaConfig(r.json)
  }
  const zcodeSubmitClaim = async (planId, captchaParam, captchaRegion) => {
    if (captchaParam === '') return { ok: false, code: -1, message: '验证码参数为空，请重试' }
    planId = String(planId || '').replace(/[^\w.-]/g, '').slice(0, 80)
    if (planId === '') return { ok: false, code: -1, message: '缺少套餐参数' }
    const ctx = zcodeLoadClaimContext()
    if (ctx.error !== undefined) return { ok: false, code: -1, message: ctx.error }
    const headers = { 'X-Aliyun-Captcha-Verify-Param': captchaParam }
    if (captchaRegion !== '') headers['X-Aliyun-Captcha-Verify-Region'] = captchaRegion
    let r
    try {
      r = await zcFetchJson(zc.BILLING_CLAIM_URL, ctx.token, ctx.mid, { method: 'POST', body: { plan_id: planId }, headers })
    } catch (err) {
      return { ok: false, code: -1, message: '领取请求失败：' + String((err && err.message) || err) }
    }
    if (r.json !== null && r.json.code === 0) {
      const plan = isObj(r.json.data) && isObj(r.json.data.plan) ? r.json.data.plan : {}
      const sec = (v) => (typeof v === 'number' ? v * 1000 : null)
      return {
        ok: true,
        planName: typeof plan.plan_name === 'string' ? plan.plan_name : (typeof plan.name === 'string' ? plan.name : ''),
        startsAt: sec(plan.starts_at),
        endsAt: sec(plan.ends_at),
        serverTime: sec(plan.server_time ?? plan.serverTime),
      }
    }
    const code = r.json !== null && typeof r.json.code === 'number' ? r.json.code : -1
    const errP = code === -1
      ? { code: -1, message: r.json === null ? '领取响应不可解析（HTTP ' + r.status + '）' : zcodeErrMsg(r, '领取失败'), nextAt: null }
      : zc.claimErrorPayload(code, r.json)
    return { ok: false, ...errP }
  }
  // ---- 验证码弹窗页（host 伺服）：apiBase 决定接口走同源路由还是本地回退服务器。
  // 无感验证 8s 超时后转交互式滑块；securitypolicyviolation 监听给出 CSP 提示。
  // 验证码弹窗页。planId 做白名单净化（允许 [\w.-]）：它来自 URL query，会被内嵌进
  // <script> 字面量，不净化就是同源 XSS 注入点。localToken 仅回退服务器模式传入，
  // 页面请求会以 ?t= 附上，与 127.0.0.1 服务器的门禁配对。
  const zcodeCaptchaHtml = (apiBase, planId, localToken) => {
  const safePlanId = String(planId || '').replace(/[^\w.-]/g, '').slice(0, 80)
  const t = typeof localToken === 'string' && localToken !== '' ? localToken : ''
  const jsUrl = apiBase + '/captcha.js?planId=' + encodeURIComponent(safePlanId)
    + (t !== '' ? '&t=' + encodeURIComponent(t) : '')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>领取验证</title>
<style>
 html,body{margin:0;background:#10131a;color:#e8eaf0;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',PingFang SC,sans-serif}
 #app{max-width:420px;margin:0 auto;padding:28px 20px;display:flex;flex-direction:column;gap:12px;min-height:100vh;box-sizing:border-box}
 .cap-status{display:flex;align-items:center;gap:10px;font-weight:600}
 .cap-dot{width:10px;height:10px;border-radius:50%;background:#f0b429;flex:none}
 .cap-dot.ok{background:#34c77b}.cap-dot.err{background:#e5484d}
 .cap-detail{font-size:12px;color:#98a0b3;word-break:break-all;min-height:18px}
 #holder{min-height:80px}
 #cap-btn{cursor:pointer;border:none;border-radius:16px;height:34px;padding:0 18px;font-size:13px;font-weight:600;
   background:#3b82f6;color:#fff;font-family:inherit}
 .cap-foot{margin-top:auto;font-size:11px;color:#5b6478;text-align:center}
 .cap-result{border-radius:10px;padding:12px 14px;font-size:13px}
 .cap-result.ok{background:rgba(52,199,123,.12);border:1px solid rgba(52,199,123,.4)}
 .cap-result.err{background:rgba(229,72,77,.1);border:1px solid rgba(229,72,77,.4)}
</style></head>
<body><div id="app">
 <div class="cap-status"><span id="cap-dot" class="cap-dot"></span><span id="cap-text">准备中…</span></div>
 <div id="cap-detail" class="cap-detail"></div>
 <div id="result"></div>
 <div id="holder"></div>
 <button id="cap-btn" type="button" hidden>点击完成验证</button>
 <div class="cap-foot">验证由阿里云验证码服务提供 · 完成后自动提交领取</div>
</div>
<script src="${jsUrl}"></script></body></html>`
  }
  // 验证码页脚本（与 HTML 分离伺服）：宿主页若设了禁 inline-script 的 CSP，内联写法
  // 会整页静默失效；外链同源脚本只需 script-src 'self'，多覆盖一整类环境。
  const zcodeCaptchaScript = (safePlanId, apiBase, t) => `(function(){
  var planId = ${JSON.stringify(safePlanId)};
  var API = ${JSON.stringify(apiBase)};
  var TOKEN = ${JSON.stringify(t)};
  function withToken(path){ return TOKEN ? path + (path.indexOf('?') === -1 ? '?' : '&') + 't=' + encodeURIComponent(TOKEN) : path }
  var SDK = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';
  var $text = document.getElementById('cap-text');
  var $detail = document.getElementById('cap-detail');
  var $dot = document.getElementById('cap-dot');
  var $btn = document.getElementById('cap-btn');
  var $result = document.getElementById('result');
  var submitted = false, region = null, tracelessTimer = 0;
  function status(t, tone){ $text.textContent = t; $dot.className = 'cap-dot' + (tone === 'ok' ? ' ok' : tone === 'err' ? ' err' : '') }
  function detail(t){ $detail.textContent = t || '' }
  document.addEventListener('securitypolicyviolation', function(e){
    detail('内容安全策略拦截了 ' + e.violatedDirective + '（' + String(e.blockedURI).slice(0, 70) + '）');
  });
  function getJson(path){
    return fetch(API + withToken(path), { cache: 'no-store' }).then(function(r){ return r.json() }).catch(function(){ return null });
  }
  function postJson(path, body){
    return fetch(API + withToken(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ return r.json() }).catch(function(){ return null });
  }
  function notifyOpener(payload){
    try { if (window.opener) window.opener.postMessage(Object.assign({ source: 'dsh-tokenrhythm-bill', kind: 'zcode-claim' }, payload), '*') } catch (e) {}
  }
  function showResult(payload){
    var el = document.createElement('div');
    el.className = 'cap-result ' + (payload.ok ? 'ok' : 'err');
    el.textContent = payload.ok ? '🎉 领取成功' + (payload.planName ? '：' + payload.planName : '') : '领取失败：' + (payload.message || '未知错误');
    $result.appendChild(el);
    notifyOpener(payload);
  }
  function submit(param){
    if (submitted || !param || !String(param).trim()) return;
    submitted = true;
    clearTimeout(tracelessTimer);
    status('验证通过，提交领取…');
    postJson('/zcode/claim', { planId: planId, captchaParam: String(param).trim(), captchaRegion: region || '' }).then(function(r){
      if (r === null) { status('领取请求失败', 'err'); detail('网络错误或插件后台不可达'); submitted = false; return }
      if (r.ok) { status('已完成', 'ok'); detail(''); showResult(r) }
      else { status('未完成', 'err'); showResult(r); submitted = false }
    });
  }
  function interactive(why){
    clearTimeout(tracelessTimer);
    status('请完成滑块验证');
    $btn.hidden = false;
    $btn.focus();
    if (why) detail(typeof why === 'string' ? why.slice(0, 120) : JSON.stringify(why).slice(0, 120));
  }
  function loadSdk(){
    return new Promise(function(resolve, reject){
      if (typeof window.initAliyunCaptcha === 'function') return resolve();
      var s = document.createElement('script');
      s.src = SDK;
      s.onload = function(){ resolve() };
      s.onerror = function(){ reject(new Error('验证码 SDK 加载失败（可能被内容安全策略拦截）')) };
      document.head.appendChild(s);
    });
  }
  if (planId === '') { status('缺少套餐参数', 'err'); return }
  status('准备中…');
  getJson('/zcode/captcha-config').then(function(cfg){
    if (cfg === null) { status('验证码配置不可用', 'err'); return }
    if (!cfg.enabled || !cfg.sceneId) { status('验证码配置不可用', 'err'); detail('平台未开启验证码或配置缺失'); return }
    region = cfg.region || null;
    loadSdk().then(function(){
      window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix };
      status('无感验证中…');
      try {
        window.initAliyunCaptcha({
          SceneId: cfg.sceneId,
          mode: 'popup',
          language: 'zh-CN',
          showErrorTip: false,
          element: '#holder',
          button: '#cap-btn',
          getInstance: function(instance){
            if (instance && typeof instance.startTracelessVerification === 'function') {
              instance.startTracelessVerification();
              tracelessTimer = setTimeout(function(){ interactive() }, 8000);
            } else interactive();
          },
          success: function(param){ submit(typeof param === 'string' ? param : param && param.captchaVerifyParam) },
          fail: function(p){ interactive(p) },
          onError: function(p){ interactive(p) },
        });
      } catch (e) { status('验证码初始化失败', 'err'); detail(String(e)) }
    }, function(e){ status(e.message, 'err'); detail('');
      // 同源页被 CSP 拦 SDK → 请求 host 起回退服务器并跳转过去再试一次。
      if (API !== '') {
        getJson('/zcode/captcha-fallback?planId=' + encodeURIComponent(planId)).then(function(fb){
          if (fb && fb.ok && fb.url) { location.href = fb.url } else notifyOpener({ ok: false, message: e.message })
        });
      } else notifyOpener({ ok: false, message: e.message });
    });
  });
})();`

  // CSP 回退：验证码 SDK 被宿主页 CSP 拦时，起一个 127.0.0.1 一次性端口把弹窗页
  // （连同 config/claim 代理端点）搬出去。5 分钟自动回收；token 防本地其它进程滥用。
  let zcodeCaptchaFallback = null // { server, url, token, timer }
  const zcodeStopCaptchaFallback = () => {
    if (zcodeCaptchaFallback === null) return
    const f = zcodeCaptchaFallback
    zcodeCaptchaFallback = null
    clearTimeout(f.timer)
    try { f.server.close() } catch { /* 已关闭 */ }
  }
  let zcodeCaptchaFallbackBusy = null // 并发启动单飞：两个弹窗同刻触发只起一个服务器
  const zcodeStartCaptchaFallback = async () => {
    if (zcodeCaptchaFallback !== null) return zcodeCaptchaFallback.url
    if (zcodeCaptchaFallbackBusy !== null) return zcodeCaptchaFallbackBusy
    zcodeCaptchaFallbackBusy = zcodeStartCaptchaFallbackInner().finally(() => { zcodeCaptchaFallbackBusy = null })
    return zcodeCaptchaFallbackBusy
  }
  const zcodeStartCaptchaFallbackInner = async () => {
    const token = randomUUID().replace(/-/g, '')
    const server = createServer(async (req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1')
        if (u.searchParams.get('t') !== token) { res.writeHead(403); res.end('forbidden'); return }
        const readBodyText = async () => {
          let text = ''
          for await (const chunk of req) text += chunk
          return text
        }
        if (u.pathname === '/captcha' && req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(zcodeCaptchaHtml('', u.searchParams.get('planId') || '', token))
          return
        }
        if (u.pathname === '/captcha.js' && req.method === 'GET') {
          const safePlanId = String(u.searchParams.get('planId') || '').replace(/[^\w.-]/g, '').slice(0, 80)
          res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
          res.end(zcodeCaptchaScript(safePlanId, '', token))
          return
        }
        if (u.pathname === '/zcode/captcha-config' && req.method === 'GET') {
          const cfg = await zcodeCaptchaConfig(zcodeDeviceMid())
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(cfg))
          return
        }
        if (u.pathname === '/zcode/claim' && req.method === 'POST') {
          if (!zcodeEnabled()) { res.writeHead(403); res.end('forbidden'); return }
          let body = {}
          try { body = JSON.parse(await readBodyText()) } catch { body = {} }
          const r = await zcodeSubmitClaim(String(body.planId || ''), String(body.captchaParam || '').trim(), String(body.captchaRegion || '').trim())
          if (r.ok) setTimeout(zcodeStopCaptchaFallback, 30 * 1000)
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(r))
          return
        }
        res.writeHead(404); res.end('not found')
      } catch {
        try { res.writeHead(500); res.end('error') } catch { /* socket 已断 */ }
      }
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const port = server.address().port
    zcodeCaptchaFallback = { server, token, url: 'http://127.0.0.1:' + port + '/captcha?t=' + token, timer: null }
    zcodeCaptchaFallback.timer = setTimeout(zcodeStopCaptchaFallback, 5 * 60 * 1000)
    return zcodeCaptchaFallback.url
  }

  // ---- shared HTTP helpers（同音乐插件）----
  const writeJson = (res, value, status) => {
    res.writeHead(status || 200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(value))
  }
  async function readBody(req) {
    let text = ''
    for await (const chunk of req) text += chunk
    if (text === '') return {}
    try { return JSON.parse(text) } catch { return {} }
  }

  const serve = async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://x')
      const pathname = url.pathname

      if (pathname === '/dsh-tokenrhythm-bill/manifest' && req.method === 'GET') {
        loadState()
        const { providers, error } = readProviders()
        // 用户指定：面板只保留基元律动（tokenrhythm）的内容。
        const visible = providers.filter((p) => p.balanceCapable)
        // 数据账号标注：账号密码模式 activeAccount 是登录手机号，界面上应显示
        // 平台用户名，因此有会话 Cookie 时两种模式都取带缓存的 /api/me 账户名
        // （accountName；失败静默 → 前端回退 account / Cookie 模式文案）。
        // account 保留登录标识（手机号）：设置页账号列表的「当前」徽标靠它比对。
        const meName = state.cookie !== '' ? await fetchMeAccountName(state.cookie) : null
        const sessionAccount = state.activeAccount || meName || null
        // 会话验活：401 先按绑定账号自动重登再验（打开面板即自愈）。
        let probe = state.cookie !== '' ? await probeSession(state.cookie) : { valid: false, name: null }
        if (state.cookie !== '' && !probe.valid && (await reloginActive())) probe = await probeSession(state.cookie)
        writeJson(res, {
          ok: true,
          version: PKG_VERSION,
          providers: visible.map((p) => {
            const key = effectiveKey(p)
            return {
              id: p.id,
              displayName: p.displayName,
              baseURL: p.baseURL,
              apiKeyEnv: p.apiKeyEnv,
              hasKey: key !== '',
              keyHint: maskSecret(key),
              balanceCapable: p.balanceCapable,
              modelCount: p.models.length,
            }
          }),
          session: { configured: state.cookie !== '', valid: probe.valid, hint: maskSecret(state.cookie), account: sessionAccount || null, accountName: meName || null },
          cred: activeCredSummary(),
          error,
        })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/models' && req.method === 'GET') {
        const providerId = url.searchParams.get('provider') || ''
        const { providers } = readProviders()
        const provider = providers.find((p) => p.id === providerId)
        if (!provider) { writeJson(res, { ok: false, code: 'NO_PROVIDER', error: '未找到提供商: ' + providerId }, 404); return }
        if (provider.baseURL === '') { writeJson(res, { ok: false, code: 'NO_BASE_URL', error: '该提供商未配置 baseURL' }, 409); return }

        // 首选平台模型列表（/api/models，会话 Cookie）：带分类/模态/显示名。
        // 401（会话过期）或失败时静默回退到网关 /v1/models（API Key，无分类）。
        loadState()
        const activeCred = activeCredOf(state)
        // 缓存键带上凭据 id：切换凭据后不能命中另一把 Key 的清单。
        const cacheKey = provider.id + '|' + (activeCred !== null && activeCred.apiKey !== '' ? activeCred.id : 'default')
        // 选中凭据带 API Key 时以该 Key 的网关清单为准（用户指定：选择后模型列表换成该 Key 的）；
        // 否则有会话 Cookie 时先读平台清单（带分类与折扣），失败再回落网关。
        if (state.cookie !== '' && !(activeCred !== null && activeCred.apiKey !== '')) {
          const hit = modelsCache.get(cacheKey)
          if (hit !== undefined && hit.source === 'platform' && Date.now() - hit.ts < MODELS_TTL_MS) {
            writeJson(res, { ok: true, provider: provider.id, models: hit.models, cached: true, categories: hit.categories, source: 'platform' })
            return
          }
          try {
            const res2 = await fetchWithTimeout(TOKENRHYTHM_BASE + '/api/models', { headers: { Cookie: 'tr_session=' + state.cookie } })
            if (res2.ok) {
              const models = normalizePlatformModels(await res2.json().catch(() => null))
              const categories = categoryCounts(models)
              modelsCache.set(cacheKey, { models, categories, source: 'platform', ts: Date.now() })
              writeJson(res, { ok: true, provider: provider.id, models, cached: false, categories, source: 'platform' })
              return
            }
          } catch { /* 平台接口不可用 → 走网关兜底 */ }
        }

        const key = effectiveKey(provider)
        if (key === '') {
          writeJson(res, { ok: false, code: 'NO_KEY', error: '还没有可用的 API Key：到「密钥」页录入一把，或配置 ' + provider.apiKeyEnv }, 409)
          return
        }
        const hit = modelsCache.get(cacheKey)
        if (hit !== undefined && hit.source !== 'platform' && Date.now() - hit.ts < MODELS_TTL_MS) {
          writeJson(res, { ok: true, provider: provider.id, models: hit.models, cached: true, categories: hit.categories, source: 'gateway' })
          return
        }
        try {
          const models = await fetchUpstreamModels(provider, key)
          modelsCache.set(cacheKey, { models, source: 'gateway', ts: Date.now() })
          writeJson(res, { ok: true, provider: provider.id, models, cached: false, source: 'gateway' })
        } catch (err) {
          // 上游失败但有过期缓存：宁可给旧数据也别白屏。
          if (hit !== undefined && hit.source !== 'platform') { writeJson(res, { ok: true, provider: provider.id, models: hit.models, cached: true, stale: true, source: 'gateway' }); return }
          writeJson(res, { ok: false, code: err.code || 'UPSTREAM_ERROR', error: String((err && err.message) || err) }, err.status && err.status >= 400 ? err.status : 502)
        }
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/balance' && req.method === 'GET') {
        loadState()
        if (state.cookie === '') { writeJson(res, { ok: false, code: 'NO_SESSION', error: '未配置网页会话 Cookie' }); return }
        try {
          const balance = await fetchUpstreamBalance(state.cookie)
          // 记住这条凭据最后一次查到的余额（密钥页列表展示）。只认凭据会话：账密登录的会话不挂到任何凭据上。
          const cur = activeCredOf(state)
          if (cur !== null && typeof balance.balanceCny === 'number') {
            state.credBalances[cur.id] = { cny: balance.balanceCny, avail: toNum(balance.availableBalanceCny), at: Date.now() }
            saveState()
          }
          writeJson(res, { ok: true, ...balance })
        } catch (err) {
          if (err && err.code === 'SESSION_EXPIRED') {
            writeJson(res, { ok: false, code: 'SESSION_EXPIRED', error: '会话已过期：到「密钥」页更新该凭据的 Cookie，或到「设置」用账号密码重新登录' })
            return
          }
          writeJson(res, { ok: false, code: 'UPSTREAM_ERROR', error: String((err && err.message) || err) }, 502)
        }
        return
      }

      // 账号密码登录：host 直接调平台登录接口，成功后从 Set-Cookie 提取
      // tr_session 存入 state（0600）。凭据同时并入 accounts（明文 0600，与账号
      // 管理一致）：会话过期后自动重登可用，登录事件与贴 Cookie 两条路径绑定语义一致。
      if (pathname === '/dsh-tokenrhythm-bill/auth/login' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account.trim() : ''
        const password = body && typeof body.password === 'string' ? body.password : ''
        if (account === '' || password === '') { writeJson(res, { ok: false, error: '请填写账号和密码' }, 400); return }
        const r = await loginOnPlatform(account, password)
        if (!r.ok) { writeJson(res, { ok: false, error: r.error }); return }
        loadState()
        state.cookie = r.cookie
        if (r.csrf) state.csrf = r.csrf
        state.activeAccount = account
        state.activeCred = '' // 账密登录的会话取代凭据选择，不留悬空选中
        const rest = state.accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase())
        state.accounts = sanitizeAccounts([...rest, { account, password, addedAt: Date.now() }])
        saveState()
        writeJson(res, { ok: true, configured: true, hint: maskSecret(r.cookie) })
        return
      }

      // 账号管理：添加（按用户要求明文保存密码，可随时查看）/ 删除 / 一键登录。
      if (pathname === '/dsh-tokenrhythm-bill/accounts' && req.method === 'GET') {
        loadState()
        writeJson(res, { ok: true, accounts: state.accounts })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/accounts/add' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account.trim() : ''
        const password = body && typeof body.password === 'string' ? body.password : ''
        if (account === '' || password === '') { writeJson(res, { ok: false, error: '请填写账号和密码' }, 400); return }
        loadState()
        const rest = state.accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase())
        state.accounts = sanitizeAccounts([...rest, { account, password, addedAt: Date.now() }])
        saveState()
        const r = await loginOnPlatform(account, password)
        if (r.ok) { state.cookie = r.cookie; if (r.csrf) state.csrf = r.csrf; state.activeAccount = account; state.activeCred = ''; saveState() }
        writeJson(res, { ok: true, saved: true, loggedIn: r.ok, hint: r.ok ? maskSecret(r.cookie) : null, error: r.error || null })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/accounts/remove' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account : ''
        loadState()
        state.accounts = state.accounts.filter((a) => a.account.toLowerCase() !== account.toLowerCase())
        saveState()
        writeJson(res, { ok: true, accounts: state.accounts })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/accounts/login' && req.method === 'POST') {
        const body = await readBody(req)
        const account = body && typeof body.account === 'string' ? body.account : ''
        loadState()
        const acc = state.accounts.find((a) => a.account.toLowerCase() === account.toLowerCase())
        if (!acc) { writeJson(res, { ok: false, error: '账号不存在' }, 404); return }
        const r = await loginOnPlatform(acc.account, acc.password)
        if (!r.ok) { writeJson(res, { ok: false, error: r.error }); return }
        state.cookie = r.cookie
        if (r.csrf) state.csrf = r.csrf
        state.activeAccount = acc.account
        state.activeCred = '' // 账密登录的会话取代凭据选择，不留悬空选中
        saveState()
        writeJson(res, { ok: true, hint: maskSecret(r.cookie) })
        return
      }

      // ---- 本机凭据池（密钥页）：保存 / 列表 / 选用 / 删除。明文落本机 0600 state 文件，
      // 列表按用户要求把 API Key 与 Cookie 原样回给同源面板（只在本机浏览器可见）。----
      if (pathname === '/dsh-tokenrhythm-bill/creds' && req.method === 'GET') {
        loadState()
        const active = state.activeCred
        writeJson(res, {
          ok: true,
          active: active || null,
          creds: state.creds.map((c) => ({
            id: c.id,
            apiKey: c.apiKey,
            cookie: c.cookie,
            // 完整展示用：优先用户粘贴的原文；旧条目没有 cookieRaw 时退回 tr_session=… 形态。
            cookieRaw: c.cookieRaw || (c.cookie !== '' ? 'tr_session=' + c.cookie : ''),
            lastBalance: isObj(state.credBalances[c.id]) ? state.credBalances[c.id] : null,
            addedAt: c.addedAt,
            active: c.id === active,
          })),
        })
        return
      }
      // 只入库，不改变当前选用项——选用由列表里的「使用」显式触发。
      if (pathname === '/dsh-tokenrhythm-bill/creds/add' && req.method === 'POST') {
        const body = await readBody(req)
        const apiKey = body && typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
        const cookieRaw = body && typeof body.cookie === 'string' ? body.cookie : ''
        if (apiKey === '' && extractSessionCookie(cookieRaw) === '') {
          writeJson(res, { ok: false, error: 'API Key 与 Cookie 至少填写一项（Cookie 里要能识别出 tr_session）' }, 400)
          return
        }
        loadState()
        const id = randomUUID()
        state.creds = sanitizeCreds([...state.creds, { id, apiKey, cookie: cookieRaw, addedAt: Date.now() }])
        saveState()
        writeJson(res, { ok: true, id, count: state.creds.length, active: state.activeCred || null })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/creds/remove' && req.method === 'POST') {
        const body = await readBody(req)
        const id = asStr(body && body.id).trim()
        loadState()
        state.creds = state.creds.filter((c) => c.id !== id)
        // 余额快照随记录一起删掉：列表不会再展示已删凭据的数字。
        if (isObj(state.credBalances) && state.credBalances[id] !== undefined) delete state.credBalances[id]
        // 删掉的正是当前选用项 → 连带解除它在模型（API Key）与余额（Cookie）上的应用：
        // 会话清空、不再自动重登，余额/用量随即返回未配置。
        if (state.activeCred === id) {
          state.activeCred = ''
          state.cookie = ''
          state.csrf = ''
          state.activeAccount = ''
        }
        saveState()
        writeJson(res, { ok: true, active: state.activeCred || null, count: state.creds.length })
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/creds/use' && req.method === 'POST') {
        const body = await readBody(req)
        const id = asStr(body && body.id).trim()
        loadState()
        if (id === '') {
          // 空 id = 停用当前凭据：会话清空（要靠账密登录或重新选用凭据才能查余额）。
          state.activeCred = ''
          state.cookie = ''
          state.csrf = ''
          state.activeAccount = ''
          saveState()
          writeJson(res, { ok: true, active: null })
          return
        }
        const hit = state.creds.find((c) => c.id === id)
        if (!hit) { writeJson(res, { ok: false, error: '凭据不存在' }, 404); return }
        state.activeCred = hit.id
        state.cookie = hit.cookie
        state.csrf = hit.csrf
        state.activeAccount = '' // 凭据会话不绑账密账号：Cookie 失效不做自动重登
        saveState()
        writeJson(res, { ok: true, active: hit.id, hasCookie: hit.cookie !== '', hasKey: hit.apiKey !== '' })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/prefs' && req.method === 'GET') {
        loadState()
        writeJson(res, { ok: true, prefs: state.prefs })
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/prefs' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        state.prefs = { ...state.prefs, ...sanitizePrefs(body && body.prefs ? body.prefs : body) }
        saveState()
        writeJson(res, { ok: true, prefs: state.prefs })
        return
      }

      // ---- 更新检测：npm dist-tags 比对。24h TTL，未过期零网络；失败降级回持久化结果。----
      const UPDATE_TTL_MS = 24 * 60 * 60 * 1000
      let updateBusy = null // 单飞：并发请求共享同一次上游检查
      const fetchLatestVersion = async () => {
        for (const base of ['https://registry.npmmirror.com', 'https://registry.npmjs.org']) {
          try {
            const res = await fetchWithTimeout(base + '/-/package/dsh-tokenrhythm-bill/dist-tags', {})
            if (!res.ok) continue
            const latest = normalizeDistTags(await res.json().catch(() => null))
            if (latest !== null) return latest
          } catch { /* 换下一个 registry */ }
        }
        return null
      }
      const updateResponse = (latest, checkedAt, stale) => {
        const current = PKG_VERSION
        const ignored = state.update.ignoredVersion || ''
        return {
          ok: true,
          current,
          latest,
          updateAvailable: isNewerVersion(current, latest) && latest !== ignored,
          ignoredVersion: ignored,
          installMode: detectInstallMode(),
          checkedAt,
          ...(stale ? { stale: true } : {}),
        }
      }
      const checkUpdate = async (force) => {
        loadState()
        const saved = state.update
        if (!force && saved.latestVersion && Date.now() - (saved.checkedAt || 0) < UPDATE_TTL_MS) {
          return updateResponse(saved.latestVersion, saved.checkedAt || 0, false)
        }
        if (updateBusy !== null) return updateBusy
        updateBusy = (async () => {
          const latest = await fetchLatestVersion()
          if (latest !== null) {
            state.update = { ...sanitizeUpdate(saved), latestVersion: latest, checkedAt: Date.now(), currentAtCheck: PKG_VERSION }
            saveState()
            return updateResponse(latest, state.update.checkedAt, false)
          }
          // 上游全挂：有持久化结果给旧值标 stale，否则静默失败（不阻塞设置页）
          if (saved.latestVersion) return { ...updateResponse(saved.latestVersion, saved.checkedAt || 0, true), error: '检查失败，显示上次结果' }
          return { ok: true, current: PKG_VERSION, latest: null, updateAvailable: false, installMode: detectInstallMode(), checkedAt: 0, error: '检查失败，稍后再试' }
        })()
        try { return await updateBusy } finally { updateBusy = null }
      }
      if (pathname === '/dsh-tokenrhythm-bill/update' && req.method === 'GET') {
        writeJson(res, await checkUpdate(url.searchParams.get('force') === '1'))
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/update/ignore' && req.method === 'POST') {
        const body = await readBody(req)
        loadState()
        state.update = { ...sanitizeUpdate(state.update), ignoredVersion: asStr(body && body.version) ? asStr(body.version) : '' }
        if (state.update.ignoredVersion === '') delete state.update.ignoredVersion
        saveState()
        const saved = state.update
        writeJson(res, { ok: true, ...updateResponse(saved.latestVersion || null, saved.checkedAt || 0, false) })
        return
      }


      // ================= ZCode（额度展示 + 活动领取）路由 =================
      if (pathname === '/dsh-tokenrhythm-bill/zcode/quota' && req.method === 'GET') {
        if (!zcodeEnabled()) { writeJson(res, zcodeDisabledResponse()); return }
        writeJson(res, await fetchZcodeQuota(url.searchParams.get('force') === '1'))
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/zcode/claim/preview' && req.method === 'GET') {
        if (!zcodeEnabled()) { writeJson(res, zcodeDisabledResponse()); return }
        const ctx = zcodeLoadClaimContext()
        if (ctx.error !== undefined) { writeJson(res, { ok: false, code: ctx.code, error: ctx.error }); return }
        // 激活埋点先打（软失败：带 activationError 但照样返回套餐列表，同 zcode-switch）。
        const activation = await zcodeReportActivation(ctx.token, ctx.mid)
        const purl = zc.BILLING_PREVIEW_URL + '?app_version=' + encodeURIComponent(zc.zcodeAppVersion())
          + '&platform=' + encodeURIComponent(zc.clientPlatform())
        let r
        try {
          r = await zcFetchJson(purl, ctx.token, ctx.mid)
        } catch (err) {
          writeJson(res, { ok: false, code: 'PREVIEW_NET', error: 'preview 请求失败：' + String((err && err.message) || err) })
          return
        }
        if (r.json !== null && r.json.code === 0) {
          writeJson(res, { ok: true, plans: zc.parseClaimPlans(r.json), ...activation })
        } else {
          const code = r.json !== null && typeof r.json.code === 'number' ? r.json.code : -1
          const errP = code === -1
            ? { code: -1, message: r.json === null ? 'preview 响应不可解析（HTTP ' + r.status + '）' : zcodeErrMsg(r, 'preview 失败'), nextAt: null }
            : zc.claimErrorPayload(code, r.json)
          writeJson(res, { ok: false, code: 'CLAIM_BIZ', ...errP, ...activation })
        }
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/zcode/captcha-config' && req.method === 'GET') {
        if (!zcodeEnabled()) { writeJson(res, zcodeDisabledResponse(), 403); return }
        try {
          const cfg = await zcodeCaptchaConfig(zcodeDeviceMid())
          writeJson(res, cfg !== null ? cfg : { error: '验证码配置不可用' }, cfg !== null ? 200 : 502)
        } catch (err) {
          writeJson(res, { error: '配置请求失败：' + String((err && err.message) || err) }, 502)
        }
        return
      }

      if (pathname === '/dsh-tokenrhythm-bill/zcode/claim' && req.method === 'POST') {
        if (!zcodeEnabled()) { writeJson(res, zcodeDisabledResponse(), 403); return }
        const body = await readBody(req)
        const planId = asStr(body && body.planId)
        if (planId === '') { writeJson(res, { ok: false, code: -1, message: '缺少套餐参数' }, 400); return }
        const r = await zcodeSubmitClaim(
          planId,
          typeof (body && body.captchaParam) === 'string' ? body.captchaParam.trim() : '',
          typeof (body && body.captchaRegion) === 'string' ? body.captchaRegion.trim() : '',
        )
        if (r.ok) zcodeQuotaCache = null // 领取成功 → 额度缓存立即失效，下次进页重新查
        writeJson(res, r)
        return
      }

      // 验证码弹窗页（同源伺服；SDK 被 CSP 拦时页面自己跳 zcode/captcha-fallback）。
      if (pathname === '/dsh-tokenrhythm-bill/captcha' && req.method === 'GET') {
        if (!zcodeEnabled()) { writeJson(res, zcodeDisabledResponse(), 403); return }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(zcodeCaptchaHtml('/dsh-tokenrhythm-bill', url.searchParams.get('planId') || ''))
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/captcha.js' && req.method === 'GET') {
        if (!zcodeEnabled()) { writeJson(res, zcodeDisabledResponse(), 403); return }
        const safePlanId = String(url.searchParams.get('planId') || '').replace(/[^\w.-]/g, '').slice(0, 80)
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
        res.end(zcodeCaptchaScript(safePlanId, '/dsh-tokenrhythm-bill', ''))
        return
      }
      if (pathname === '/dsh-tokenrhythm-bill/zcode/captcha-fallback' && req.method === 'GET') {
        if (!zcodeEnabled()) { writeJson(res, zcodeDisabledResponse(), 403); return }
        try {
          const u = await zcodeStartCaptchaFallback()
          const planId = url.searchParams.get('planId') || ''
          writeJson(res, { ok: true, url: u + (u.includes('?') ? '&' : '?') + 'planId=' + encodeURIComponent(planId) })
        } catch (err) {
          writeJson(res, { ok: false, error: '回退服务器启动失败：' + String((err && err.message) || err) }, 500)
        }
        return
      }

      writeJson(res, { ok: false, error: 'not found' }, 404)
    } catch (err) {
      try { writeJson(res, { ok: false, error: String((err && err.message) || err) }, 500) } catch { /* socket 已断 */ }
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-tokenrhythm-bill', handler: serve }), 'tokenrhythm-bill: routes')
}
