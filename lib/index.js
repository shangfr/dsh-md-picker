/**
 * dsh-md-picker — host-side shell (服务端挂载壳 + Markdown 转换服务)
 *
 * 职责一:把 lib/client.js 暴露为静态资源并在 HTML 注入 <script defer>
 * (webServer.tapIndex,whale-widget 同款模式),client 每次请求现读磁盘。
 *
 * 职责二:两个路由
 *   POST /dsh-md-picker/store    —— 纯文本类(.txt/.md/.markdown)原始字节 + X-Filename,
 *                                   编码探测(BOM/UTF-8/GB18030…)后统一按 UTF-8 落盘
 *   POST /dsh-md-picker/convert  —— 可转换格式(docx/pptx/xlsx/pdf/rtf/odt/...)
 *                                   写临时文件 -> anydoc CLI 转 Markdown ->
 *                                   落盘 resolveBaseDir 解析目录(env -> 工作目录 -> ~/.dsh/) -> 回执
 * 消息里只出现极短回执(保存路径+字符数+预览),正文不进会话上下文。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const CLIENT_ROUTE = '/dsh-md-picker/client.js'
const STORE_ROUTE = '/dsh-md-picker/store'
const CONVERT_ROUTE = '/dsh-md-picker/convert'
const SCRIPT_TAG = `<script defer src="${CLIENT_ROUTE}"></script>`
const STORE_DIR = path.join(os.homedir(), '.dsh', 'md-picker-attachments')
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const ANYDOC_TIMEOUT_MS = 120000
const MAX_CONCURRENT_CONVERSIONS = 2
const MAX_QUEUED_CONVERSIONS = 16

function clientScript() {
  try {
    return fs.readFileSync(path.join(PACKAGE_ROOT, 'lib', 'client.js'), 'utf8')
  } catch (err) {
    return `console.error('[dsh-md-picker] failed to load client.js:', ${JSON.stringify(String(err))})`
  }
}

export function sanitizeName(name) {
  const base = String(name ?? 'file.txt').split(/[\\/]/).pop()
  return base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'file.txt'
}

export function stamp(d) {
  const p = (n, w) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1, 2)}${p(d.getDate(), 2)}-${p(d.getHours(), 2)}${p(d.getMinutes(), 2)}${p(d.getSeconds(), 2)}-${p(d.getMilliseconds(), 3)}`
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

function acquireSlot() {
  return new Promise((resolve) => {
    convertQueue.push(resolve)
    pump()
  })
}

function pump() {
  while (convertActive < MAX_CONCURRENT_CONVERSIONS && convertQueue.length > 0) {
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
        // 单字符串命令形式:规避 Node DEP0190(args+shell 只拼接不转义)
        const cmdLine = `npx.cmd -y @firecrawl/anydoc ${q(input)} -o ${q(output)}`
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
      resolve({ ok: false, error: `anydoc 转换超时(>${Math.round(timeoutMs / 1000)}s)` })
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
      resolve({ ok: false, exitCode: code, error: `anydoc 转换失败(退出码 ${code}):${tail.slice(0, 300)}` })
    })
  })
}

/**
 * 核心转换:原始文件字节 -> Markdown 文本。
 * 独立导出供 node 测试直接调用(不依赖 webServer)。
 */
export async function convertToMarkdown(bytes, originalName, opts = {}) {
  const safe = sanitizeName(originalName)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-md-picker-'))
  try {
    const tmpIn = path.join(tmpDir, safe)
    fs.writeFileSync(tmpIn, bytes)
    const outName = safe.replace(/\.[^.]+$/, '') + '.md'
    const tmpOut = path.join(tmpDir, outName)
    const res = await runAnydoc(tmpIn, tmpOut, opts.timeoutMs ?? ANYDOC_TIMEOUT_MS)
    if (!res.ok) return res
    const markdown = fs.readFileSync(tmpOut, 'utf8')
    return { ok: true, markdown, outName }
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch {}
  }
}

/**
 * 解析落盘基准目录（每次保存时重新解析,工作区可切换）:
 *   1. 环境变量 DSH_MD_PICKER_DIR —— 显式覆盖
 *   2. 当前工作目录 —— workspaceRegistry 里最近使用(updatedAt 最新)的 workspace 根,
 *      落到 <工作目录>/md-picker-attachments/,agent 的文件工具在沙箱内即可读
 *   3. 回退 ~/.dsh/md-picker-attachments/（注册表不可用或无 workspace 时）
 */
export function resolveBaseDir(reg) {
  if (process.env.DSH_MD_PICKER_DIR) return process.env.DSH_MD_PICKER_DIR
  try {
    // 兼容两种入参:服务实例本身(推荐,apply 时捕获)或持有它的 ctx
    const service = reg?.workspaceRegistry ?? reg
    if (service && typeof service.list === 'function') {
      let best = null
      for (const e of service.list()) {
        if (!best || (e.updatedAt ?? 0) > (best.updatedAt ?? 0)) best = e
      }
      const cwd = best?.path
      if (cwd && fs.existsSync(cwd)) return path.join(cwd, 'md-picker-attachments')
    }
  } catch {}
  return path.join(os.homedir(), '.dsh', 'md-picker-attachments')
}

function saveMarkdown(markdown, originalName, baseDir) {
  fs.mkdirSync(baseDir, { recursive: true })
  const base = sanitizeName(originalName).replace(/\.[^.]+$/, '')
  const target = path.join(baseDir, `${stamp(new Date())}-${base}.md`)
  fs.writeFileSync(target, markdown, 'utf8')
  return target
}

export const name = 'dsh-md-picker'
export const inject = ['webServer', 'workspaceRegistry']

export function apply(ctx) {
  const disposers = []
  // cordis 语义:插件 fiber 结束后其 ctx scope 失效,请求期穿 ctx 访问服务会失败。
  // 在 apply( fiber 活跃)期间捕获服务实例本身——实例是长寿命的,handler 闭包直接持有。
  const wsRegistry = ctx.workspaceRegistry

  // 1) client.js 静态资源(no-store,每次现读磁盘)
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: CLIENT_ROUTE,
    handler: (req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      })
      res.end(clientScript())
    },
  }))

  // 2) 纯文本类原样暂存:POST JSON { name, text } -> { ok, path, chars }
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: STORE_ROUTE,
    handler: async (req, res) => {
      try {
        let original = 'file.txt'
        try { original = decodeURIComponent(String(req.headers['x-filename'] ?? '')) || original } catch {}
        const bytes = await readBody(req, MAX_UPLOAD_BYTES)
        const safeName = sanitizeName(original)
        const text = decodeText(bytes)
        const baseDir = resolveBaseDir(wsRegistry)
        fs.mkdirSync(baseDir, { recursive: true })
        const target = path.join(baseDir, `${stamp(new Date())}-${safeName}`)
        fs.writeFileSync(target, text, 'utf8')
        const preview = text.replace(/\s+/g, ' ').trim().slice(0, 120)
        json(res, 200, { ok: true, path: target, chars: text.length, preview })
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
        let original = 'file.docx'
        try { original = decodeURIComponent(String(req.headers['x-filename'] ?? '')) || original } catch {}
        if (convertQueue.length >= MAX_QUEUED_CONVERSIONS) {
          return json(res, 429, { ok: false, error: `转换队列已满(同时最多 ${MAX_CONCURRENT_CONVERSIONS} 个,排队上限 ${MAX_QUEUED_CONVERSIONS}),请稍后重试` })
        }
        const bytes = await readBody(req, MAX_UPLOAD_BYTES)
        await acquireSlot()
        let conv
        try {
          conv = await convertToMarkdown(bytes, original)
        } finally {
          releaseSlot()
        }
        if (!conv.ok) {
          return json(res, conv.ocr ? 422 : 500, { ok: false, error: conv.error, ocr: conv.ocr === true })
        }
        const target = saveMarkdown(conv.markdown, original, resolveBaseDir(wsRegistry))
        const preview = conv.markdown.replace(/\s+/g, ' ').trim().slice(0, 120)
        json(res, 200, { ok: true, path: target, chars: conv.markdown.length, original, preview })
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
