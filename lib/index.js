/**
 * dsh-md-picker v1.3.0 — host-side shell (服务端挂载壳 + Markdown 转换服务)
 *
 * 职责一:把 lib/client.js 暴露为静态资源并在 HTML 注入 <script defer>
 * (webServer.tapIndex,whale-widget 同款模式),client 每次请求现读磁盘,
 * 并注入本次进程的访问令牌(__DMP_TOKEN__ 占位符替换)。
 *
 * 职责二:两个路由,均要求 X-Dsh-Md-Picker-Token 令牌(进程级随机,随 client.js 下发)
 *   POST /dsh-md-picker/store    —— 纯文本类(.txt/.md/.markdown)原始字节 + X-Filename,
 *                                   编码探测(BOM/UTF-8/GB18030…)后统一按 UTF-8 落盘
 *   POST /dsh-md-picker/convert  —— 可转换格式(docx/pptx/xlsx/pdf/rtf/odt/...)
 *                                   写临时文件 -> anydoc CLI 转 Markdown -> 落盘(同上) -> 回执
 * 消息里只出现极短回执(保存路径+字符数+预览),正文不进会话上下文。
 *
 * v1.3.0 特性:
 *   - 会话感知落盘:client 可带 X-Session-Id,host 精确解析该会话属主 workspace;
 *     否则回退"最近使用 workspace"(env DSH_MD_PICKER_DIR 显式覆盖仍最高优先)
 *   - SHA-256 内容去重:同内容文件重复上传只返回既有路径(manifest.json 登记)
 *   - 访问令牌 + 每路由速率限制(LAN 暴露面加固)
 *   - anydoc 临时文件名固定(input.<ext>/output.md),用户文件名不再进入 shell 命令行
 *   - 原子唯一落盘:写入失败(同一毫秒重名)自动追加 -1/-2… 后缀
 *   - 附件目录自保护:创建目录时写入 .gitignore(*),不污染任何 git 工作区
 *   - 配置化(cordis Config 对象,无第三方依赖)与按保留天数清理
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CLIENT_ROUTE = '/dsh-md-picker/client.js'
const STORE_ROUTE = '/dsh-md-picker/store'
const CONVERT_ROUTE = '/dsh-md-picker/convert'
const SCRIPT_TAG = '<script defer src="' + CLIENT_ROUTE + '"></script>'
const MANIFEST_NAME = 'manifest.json'
const GITIGNORE_CONTENT = '*\n'
const SESSION_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/
const STAMP_FILE_RE = /^[0-9]{8}-[0-9]{6}-[0-9]{3}-/

/** 配置默认值(apply 传入的 cordis Config 可覆盖,字段缺失取默认) */
export const DEFAULTS = {
  maxUploadBytes: 25 * 1024 * 1024, // 单文件上限(字节)
  anydocTimeoutMs: 120000,          // anydoc 转换超时(ms)
  maxConcurrentConversions: 2,      // 同时最多 anydoc 进程数
  maxQueuedConversions: 16,         // 转换排队上限
  retentionDays: 0,                 // 附件保留天数,0 = 永久保留
  storeRatePerMin: 300,             // /store 每 IP 每分钟请求上限
  convertRatePerMin: 20,            // /convert 每 IP 每分钟请求上限
  dedupe: true,                     // SHA-256 内容去重
  targetDir: '',                    // 显式落盘目录(空 = resolveBaseDir 自动解析)
  token: '',                        // 访问令牌(空 = 进程随机生成)
  cleanupMinIntervalMs: 3600000,    // 过期清理最小间隔
}

function clientScript(token) {
  try {
    const src = fs.readFileSync(path.join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
    return token ? src.replaceAll('__DMP_TOKEN__', token) : src
  } catch (err) {
    return 'console.error(\'[dsh-md-picker] failed to load client.js:\', ' + JSON.stringify(String(err)) + ')'
  }
}

export function sanitizeName(name) {
  const raw = String(name ?? 'file.txt').split(/[\\/]/).pop()
  const cleaned = raw.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
  // 截断时保留扩展名(最长 16 字符),避免超长文件名把 .pdf/.docx 砍掉
  const dot = cleaned.lastIndexOf('.')
  const stem = dot > 0 ? cleaned.slice(0, dot) : cleaned
  const ext = dot > 0 ? cleaned.slice(dot).slice(0, 16) : ''
  const limit = Math.max(1, 120 - ext.length)
  const out = (stem.length > limit ? stem.slice(0, limit) : stem) + ext
  return out.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_') || 'file.txt'
}

export function stamp(d) {
  const p = (n, w) => String(n).padStart(w, '0')
  return d.getFullYear() + p(d.getMonth() + 1, 2) + p(d.getDate(), 2) + '-' + p(d.getHours(), 2) + p(d.getMinutes(), 2) + p(d.getSeconds(), 2) + '-' + p(d.getMilliseconds(), 3)
}

/** Windows 路径转正斜杠,便于复制与跨平台识别 */
export function toPosix(p) {
  return typeof p === 'string' ? p.split(path.sep).join('/') : p
}

/** SHA-256 内容指纹(用于去重判定) */
export function byteHash(bytes) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)).digest('hex')
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function json(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function readHeader(req, name, fallback = '') {
  try { return decodeURIComponent(String(req.headers[name] ?? '')) || fallback } catch { return fallback }
}

/** 校验并规范化 X-Session-Id;非法值返回 undefined(走回退解析) */
function sessionFrom(req) {
  const s = readHeader(req, 'x-session-id', '')
  return SESSION_ID_RE.test(s) ? s : undefined
}

/** 简易滑窗速率限制:每 (ip,route) 每分钟上限 maxPerMin,超限返回 true */
const rateHits = new Map()
function rateLimited(key, maxPerMin) {
  if (!maxPerMin || maxPerMin <= 0) return false
  const now = Date.now()
  let arr = rateHits.get(key)
  if (!arr) { arr = []; rateHits.set(key, arr) }
  while (arr.length > 0 && now - arr[0] > 60000) arr.shift()
  if (arr.length >= maxPerMin) return true
  arr.push(now)
  return false
}
function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
  return fwd || req.socket?.remoteAddress || 'local'
}

/**
 * 文本编码探测与解码:UTF-8/UTF-16 BOM 优先,其次严格 UTF-8,
 * 失败回退 GB18030(中文环境常见),再回退 latin1(永不抛错)。
 */
export function decodeText(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  try {
    if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return b.subarray(3).toString('utf8')
    if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le')
    if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2))
    return new TextDecoder('utf-8', { fatal: true }).decode(b)
  } catch {
    try {
      return new TextDecoder('gb18030').decode(b)
    } catch {
      return new TextDecoder('latin1').decode(b)
    }
  }
}

// 并发转换信号量:anydoc 每个进程开销大,同时最多跑 2 个,其余排队。
let convertActive = 0
const convertQueue = []

function maxConcurrent() {
  return globalThis.__DMP_CONFIG__?.maxConcurrentConversions ?? DEFAULTS.maxConcurrentConversions
}

function acquireSlot() {
  return new Promise((resolve) => {
    convertQueue.push(resolve)
    pump()
  })
}

function pump() {
  while (convertActive < maxConcurrent() && convertQueue.length > 0) {
    const resolve = convertQueue.shift()
    convertActive++
    resolve()
  }
}

function releaseSlot() {
  convertActive = Math.max(0, convertActive - 1)
  pump()
}

function runAnydoc(input, output, timeoutMs) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32'
    const cmd = win ? 'npx.cmd' : 'npx'
    // Node >=18.20/20.12 (CVE-2024-27980): 在 Windows 上 spawn .cmd 必须 shell:true。
    const q = (p) => (win ? '"' + p + '"' : p)
    let child
    try {
      if (win) {
        // 单字符串命令形式:规避 Node DEP0190(args+shell 只拼接不转义)。
        // 输入/输出路径由调用方固定为 input.<ext>/output.md,不包含任何用户可控字符。
        const cmdLine = 'npx.cmd -y @firecrawl/anydoc ' + q(input) + ' -o ' + q(output)
        child = spawn(cmdLine, { windowsHide: true, shell: true, cwd: path.dirname(input) })
      } else {
        child = spawn(cmd, ['-y', '@firecrawl/anydoc', input, '-o', output], {
          windowsHide: true,
          cwd: path.dirname(input),
        })
      }
    } catch (err) {
      return resolve({ ok: false, error: 'anydoc 启动失败: ' + err.message })
    }
    let stderr = ''
    let stdout = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        if (win && child.pid) {
          // shell 模式下 child 是 cmd.exe，需要连子进程树一起杀
          spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
        } else {
          child.kill('SIGKILL')
        }
      } catch {}
      resolve({ ok: false, error: 'anydoc 转换超时(>' + Math.round(timeoutMs / 1000) + 's)' })
    }, timeoutMs)
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: 'anydoc 启动失败(宿主机需要 Node 20+ 与 npx): ' + err.message })
    })
    child.stderr.on('data', (d) => { stderr += d })
    child.stdout.on('data', (d) => { stdout += d })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code === 0) return resolve({ ok: true })
      const tail = (stderr || stdout).trim().split('\n').filter(Boolean).pop() ?? ''
      if (code === 3) {
        return resolve({ ok: false, exitCode: 3, ocr: true, error: '该 PDF 含扫描页,本地无法转换(anydoc 退出码 3,需 OCR)' })
      }
      resolve({ ok: false, exitCode: code, error: 'anydoc 转换失败(退出码 ' + code + '):' + tail.slice(0, 300) })
    })
  })
}

/**
 * 核心转换:原始文件字节 -> Markdown 文本。
 * 独立导出供 node 测试直接调用(不依赖 webServer)。
 * 安全:临时目录内文件名固定为 input.<ext>/output.md,原始文件名完全不进入命令行。
 */
export async function convertToMarkdown(bytes, originalName, opts = {}) {
  const safe = sanitizeName(originalName)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-md-picker-'))
  try {
    const extMatch = /[.]([a-zA-Z0-9]{1,10})$/.exec(safe)
    const tmpIn = path.join(tmpDir, 'input' + (extMatch ? '.' + extMatch[1].toLowerCase() : ''))
    fs.writeFileSync(tmpIn, bytes)
    const tmpOut = path.join(tmpDir, 'output.md')
    const res = await runAnydoc(tmpIn, tmpOut, opts.timeoutMs ?? DEFAULTS.anydocTimeoutMs)
    if (!res.ok) return res
    const markdown = fs.readFileSync(tmpOut, 'utf8')
    return { ok: true, markdown, outName: safe.replace(/\.[^.]+$/, '') + '.md' }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 解析落盘基准目录(每次保存时重新解析,工作区可切换):
 *   1. 环境变量 DSH_MD_PICKER_DIR —— 显式覆盖(最高优先)
 *   2. 会话所属 workspace(传入 opts.sessionId 且注册表可解析时,精确匹配)
 *   3. workspaceRegistry 里最近使用(updatedAt 最新)的 workspace 根,
 *      落到 <工作目录>/md-picker-attachments/,agent 的文件工具在沙箱内即可读
 *   4. 回退 ~/.dsh/md-picker-attachments/(注册表不可用或无 workspace 时)
 */
export function resolveBaseDir(reg, { sessionId } = {}) {
  if (process.env.DSH_MD_PICKER_DIR) return process.env.DSH_MD_PICKER_DIR
  try {
    // 兼容两种入参:服务实例本身(推荐,apply 时捕获)或持有它的 ctx
    const service = reg?.workspaceRegistry ?? reg
    if (service && typeof service.list === 'function') {
      const entries = service.list()
      // 2) 会话精确匹配:该会话属于哪个 workspace,就落哪个
      if (sessionId) {
        const owned = entries.find((e) => e && Array.isArray(e.sessionIds) && e.sessionIds.includes(sessionId))
        const cwd = owned?.path
        if (cwd && fs.existsSync(cwd)) return path.join(cwd, 'md-picker-attachments')
      }
      // 3) 最近使用 workspace(updatedAt 最新)
      let best = null
      for (const e of entries) {
        if (!e) continue
        if (!best || (e.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = e
      }
      const cwd = best?.path
      if (cwd && fs.existsSync(cwd)) return path.join(cwd, 'md-picker-attachments')
    }
  } catch {}
  return path.join(os.homedir(), '.dsh', 'md-picker-attachments')
}

/** 创建附件目录并写入 .gitignore 自保护(目录整体不进 git) */
export function ensureAttachmentsDir(baseDir) {
  fs.mkdirSync(baseDir, { recursive: true })
  const gi = path.join(baseDir, '.gitignore')
  try { fs.accessSync(gi) } catch {
    try { fs.writeFileSync(gi, GITIGNORE_CONTENT, 'utf8') } catch {}
  }
}

/** 原子唯一落盘:EEXIST(同毫秒重名)时自动追加 -1/-2/… 后缀 */
export function saveUnique(baseDir, fileName, data, encoding = 'utf8') {
  ensureAttachmentsDir(baseDir)
  const dot = fileName.lastIndexOf('.')
  const prefix = dot > 0 ? fileName.slice(0, dot) : fileName
  const suffix = dot > 0 ? fileName.slice(dot) : ''
  for (let i = 0; i < 1000; i++) {
    const name = i === 0 ? fileName : prefix + '-' + i + suffix
    const target = path.join(baseDir, name)
    try {
      fs.writeFileSync(target, data, { encoding, flag: 'wx' })
      return target
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err
    }
  }
  throw new Error('无法在 ' + baseDir + ' 分配唯一文件名:' + fileName)
}

// ---- 去重清单(manifest.json) ----------------------------------------------
// 结构:{ version:1, files: { [sha256]: { path, name, chars, kind, createdAt } } }
function loadManifest(baseDir) {
  try {
    const raw = fs.readFileSync(path.join(baseDir, MANIFEST_NAME), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object' && parsed.files && typeof parsed.files === 'object') return parsed
  } catch {}
  return { version: 1, files: {} }
}

function saveManifest(baseDir, manifest) {
  try {
    fs.writeFileSync(path.join(baseDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), 'utf8')
  } catch {}
}

/** 每个 baseDir 一把写锁,串行化 manifest 的读-改-写,避免并发覆盖 */
const manifestLocks = new Map()
function withManifest(baseDir, fn) {
  const prev = manifestLocks.get(baseDir) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  manifestLocks.set(baseDir, next)
  return next
}

/**
 * 带去重的落盘:同内容(原始字节 SHA-256)已存在且文件仍在 -> 返回既有路径。
 * fileName 应为已带时间戳前缀的目标文件名;data 为要写入的文本/缓冲区。
 * 返回 { target, duplicate, duplicateOf }
 */
export function storeFile(baseDir, fileName, data, rawBytes, { dedupe = true, kind = 'text', encoding = 'utf8' } = {}) {
  const hash = dedupe ? byteHash(rawBytes) : null
  return withManifest(baseDir, () => {
    let manifest = null
    if (hash) {
      manifest = loadManifest(baseDir)
      const existing = manifest.files[hash]
      if (existing?.path && fs.existsSync(existing.path)) {
        return { target: existing.path, duplicate: true, duplicateOf: existing.path }
      }
      if (existing) delete manifest.files[hash]
    }
    const target = saveUnique(baseDir, fileName, data, encoding)
    if (hash) {
      if (!manifest) manifest = loadManifest(baseDir)
      manifest.files[hash] = { path: target, name: fileName, chars: data.length, kind, createdAt: new Date().toISOString() }
      saveManifest(baseDir, manifest)
    }
    return { target, duplicate: false }
  })
}

/**
 * 附件过期清理:删除 baseDir 下早于 retentionDays 的暂存文件并同步 manifest。
 * 每个目录有最小间隔节流(cleanupMinIntervalMs),避免每次请求都全量扫描。
 */
const lastCleanupAt = new Map()
export function cleanupAttachments(baseDir, retentionDays, now = Date.now(), minIntervalMs = DEFAULTS.cleanupMinIntervalMs) {
  if (!retentionDays || retentionDays <= 0) return 0
  const last = lastCleanupAt.get(baseDir) ?? 0
  if (now - last < minIntervalMs) return 0
  lastCleanupAt.set(baseDir, now)
  const cutoff = now - retentionDays * 86400000
  let removed = 0
  try {
    const removedPaths = new Set()
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isFile() || !STAMP_FILE_RE.test(entry.name)) continue
      const full = path.join(baseDir, entry.name)
      try {
        const st = fs.statSync(full)
        if (st.mtimeMs < cutoff) {
          fs.rmSync(full, { force: true })
          removedPaths.add(full)
          removed++
        }
      } catch {}
    }
    if (removedPaths.size > 0) {
      withManifest(baseDir, () => {
        const manifest = loadManifest(baseDir)
        for (const [h, rec] of Object.entries(manifest.files)) {
          if (removedPaths.has(rec.path)) delete manifest.files[h]
        }
        saveManifest(baseDir, manifest)
      })
    }
  } catch {}
  return removed
}

export const name = 'dsh-md-picker'
export const inject = ['webServer', 'workspaceRegistry']

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  globalThis.__DMP_CONFIG__ = config
  const disposers = []
  // cordis 语义:插件 fiber 结束后其 ctx scope 失效,请求期穿 ctx 访问服务会失败。
  // 在 apply( fiber 活跃)期间捕获服务实例本身——实例是长寿命的,handler 闭包直接持有。
  const wsRegistry = ctx.workspaceRegistry
  const token = config.token || crypto.randomBytes(24).toString('hex')
  const targetOverride = config.targetDir || ''

  /** 路由公共护栏:token 鉴权 + 每路由速率限制 */
  function guard(req, res, routeKey, ratePerMin) {
    if (req.headers['x-dsh-md-picker-token'] !== token) {
      json(res, 401, { ok: false, error: 'unauthorized: missing or invalid token' })
      return false
    }
    if (rateLimited(clientIp(req) + ':' + routeKey, ratePerMin)) {
      res.writeHead(429, { 'Content-Type': 'application/json; charset=utf-8', 'Retry-After': '60' })
      res.end(JSON.stringify({ ok: false, error: '请求过于频繁,请稍后重试' }))
      return false
    }
    return true
  }

  function pickBaseDir(req) {
    if (targetOverride) return targetOverride
    return resolveBaseDir(wsRegistry, { sessionId: sessionFrom(req) })
  }

  // 1) client.js 静态资源(no-store,每次现读磁盘并注入 token)
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: CLIENT_ROUTE,
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(clientScript(token))
    },
  }))

  // 2) 纯文本类原样暂存:POST 原始字节 + X-Filename 头
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: STORE_ROUTE,
    handler: async (req, res) => {
      try {
        if (!guard(req, res, 'store', config.storeRatePerMin)) return
        let original = 'file.txt'
        try { original = decodeURIComponent(String(req.headers['x-filename'] ?? '')) || original } catch {}
        const bytes = await readBody(req, config.maxUploadBytes)
        const safeName = sanitizeName(original)
        const text = decodeText(bytes)
        const baseDir = pickBaseDir(req)
        cleanupAttachments(baseDir, config.retentionDays)
        const { target, duplicate, duplicateOf } = await storeFile(
          baseDir,
          stamp(new Date()) + '-' + safeName,
          text,
          bytes,
          { dedupe: config.dedupe, kind: 'text' },
        )
        const preview = text.replace(/\s+/g, ' ').trim().slice(0, 120)
        json(res, 200, {
          ok: true,
          path: toPosix(target),
          chars: text.length,
          preview,
          duplicate: duplicate === true,
          duplicateOf: duplicate ? toPosix(duplicateOf) : undefined,
        })
      } catch (err) {
        json(res, err?.statusCode ?? 500, { ok: false, error: String(err?.message ?? err) })
      }
    },
  }))

  // 3) 可转换格式 -> Markdown:POST 原始字节 + X-Filename 头
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: CONVERT_ROUTE,
    handler: async (req, res) => {
      try {
        if (!guard(req, res, 'convert', config.convertRatePerMin)) return
        let original = 'file.docx'
        try { original = decodeURIComponent(String(req.headers['x-filename'] ?? '')) || original } catch {}
        if (convertQueue.length >= config.maxQueuedConversions) {
          return json(res, 429, { ok: false, error: '转换队列已满(同时最多 ' + config.maxConcurrentConversions + ' 个,排队上限 ' + config.maxQueuedConversions + '),请稍后重试' })
        }
        const bytes = await readBody(req, config.maxUploadBytes)
        await acquireSlot()
        let conv
        try {
          conv = await convertToMarkdown(bytes, original, { timeoutMs: config.anydocTimeoutMs })
        } finally {
          releaseSlot()
        }
        if (!conv.ok) {
          return json(res, conv.ocr ? 422 : 500, { ok: false, error: conv.error, ocr: conv.ocr === true })
        }
        const baseDir = pickBaseDir(req)
        cleanupAttachments(baseDir, config.retentionDays)
        const { target, duplicate, duplicateOf } = await storeFile(
          baseDir,
          stamp(new Date()) + '-' + conv.outName,
          conv.markdown,
          bytes,
          { dedupe: config.dedupe, kind: 'convert' },
        )
        const preview = conv.markdown.replace(/\s+/g, ' ').trim().slice(0, 120)
        json(res, 200, {
          ok: true,
          path: toPosix(target),
          chars: conv.markdown.length,
          original,
          preview,
          duplicate: duplicate === true,
          duplicateOf: duplicate ? toPosix(duplicateOf) : undefined,
        })
      } catch (err) {
        json(res, err?.statusCode ?? 500, { ok: false, error: String(err?.message ?? err) })
      }
    },
  }))

  // 4) 注入 <script> 标签(幂等)
  disposers.push(ctx.webServer.tapIndex((html) => {
    if (html.indexOf(CLIENT_ROUTE) !== -1) return html
    if (html.indexOf('</body>') !== -1) return html.replace('</body>', SCRIPT_TAG + '</body>')
    return html + SCRIPT_TAG
  }))

  // 5) 清理
  ctx.effect(() => () => {
    for (const d of disposers) {
      try { d() } catch {}
    }
  })
}
