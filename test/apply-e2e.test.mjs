// 生产语义 E2E:apply(fiber 活跃)捕获服务实例 -> 很久之后才触发 handler。
// 覆盖:token 鉴权(401)、会话感知落盘、SHA-256 去重、.gitignore 自保护、413 上限。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import * as dmp from '../lib/index.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-e2e-'))
const TOKEN = 'e2e-test-token'

function makeFakeCtx(workspaceEntries) {
  const handlers = {}
  const tapped = []
  return {
    webServer: {
      register: (r) => { handlers[r.path] = r.handler },
      tapIndex: (h) => { tapped.push(true); return h('<html/>') },
    },
    effect() {},
    workspaceRegistry: { list: () => workspaceEntries },
    _handlers: handlers,
  }
}

/** 模拟很久之后的 HTTP 请求(闭包只持有 wsRegistry 实例) */
async function post(ctx, pathName, body, headers = {}) {
  let captured = {}
  const res = { writeHead: (s, h) => { captured.status = s; captured.headers = h }, end: (b) => { captured.body = b } }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const req = new EventEmitter()
  req.headers = { 'content-length': String(buf.length), ...headers }
  req.destroy = () => {}
  const done = ctx._handlers[pathName](req, res)
  await new Promise((ok) => setImmediate(ok))
  req.emit('data', buf)
  req.emit('end')
  await done
  return captured
}

// 主 ctx:TMP 作为唯一 workspace(无会话 id 时走"最近使用")
const ctx = makeFakeCtx([{ path: TMP, updatedAt: 42, sessionIds: ['sess-e2e'] }])
dmp.apply(ctx, { token: TOKEN, storeRatePerMin: 0, convertRatePerMin: 0 })
const expectedDir = path.join(TMP, 'md-picker-attachments')

// 1) UTF-8 文本落盘 + 目录自保护
const resp = await post(ctx, '/dsh-md-picker/store', Buffer.from('hello 工作区', 'utf8'), {
  'x-filename': encodeURIComponent('note.txt'), 'x-dsh-md-picker-token': TOKEN,
})
const out = JSON.parse(resp.body)
console.log('store response:', resp.body)
assert.equal(resp.status, 200)
assert.equal(path.dirname(path.normalize(out.path)), expectedDir, 'file lands in the WORKSPACE dir')
assert.ok(fs.existsSync(out.path), 'file exists on disk')
assert.equal(fs.readFileSync(out.path, 'utf8'), 'hello 工作区', 'utf-8 text saved verbatim')
assert.equal(fs.readFileSync(path.join(expectedDir, '.gitignore'), 'utf8'), '*\n', 'self-protecting .gitignore')
assert.equal(out.duplicate, false)

// 2) GBK 编码文本("你好" 的 GBK 字节):服务端应识别并统一为 UTF-8 落盘
const gresp = await post(ctx, '/dsh-md-picker/store', Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), {
  'x-filename': encodeURIComponent('gbk.txt'), 'x-dsh-md-picker-token': TOKEN,
})
const gout = JSON.parse(gresp.body)
assert.equal(fs.readFileSync(gout.path, 'utf8'), '你好', 'GBK decoded and stored as UTF-8')

// 3) SHA-256 去重:同内容再次上传 -> 同一路径,duplicate=true
const dup = await post(ctx, '/dsh-md-picker/store', Buffer.from('hello 工作区', 'utf8'), {
  'x-filename': encodeURIComponent('note-copy.txt'), 'x-dsh-md-picker-token': TOKEN,
})
const dout = JSON.parse(dup.body)
assert.equal(dout.ok, true)
assert.equal(dout.duplicate, true, 'duplicate flagged')
assert.equal(dout.path, out.path, 'same content -> same stored path, nothing rewritten')

// 4) 鉴权:缺 token -> 401
const bad = await post(ctx, '/dsh-md-picker/store', Buffer.from('x'), { 'x-filename': encodeURIComponent('n.txt') })
assert.equal(bad.status, 401)
const badBody = JSON.parse(bad.body)
assert.equal(badBody.ok, false)

// 5) 会话感知:带 X-Session-Id -> 落到该会话属主 workspace(即使它不是最新)
const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-e2eA-'))
const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-e2eB-'))
const ctx2 = makeFakeCtx([
  { path: wsA, updatedAt: 999, sessionIds: ['sess-a'] },
  { path: wsB, updatedAt: 1, sessionIds: ['sess-b'] },
])
dmp.apply(ctx2, { token: TOKEN, storeRatePerMin: 0 })
const sresp = await post(ctx2, '/dsh-md-picker/store', Buffer.from('session routed', 'utf8'), {
  'x-filename': encodeURIComponent('s.txt'), 'x-dsh-md-picker-token': TOKEN, 'x-session-id': 'sess-b',
})
const sout = JSON.parse(sresp.body)
assert.equal(path.dirname(path.normalize(sout.path)), path.join(wsB, 'md-picker-attachments'), 'session owner wins over newest')

// 6) 413:超出单文件上限
const small = makeFakeCtx([{ path: TMP, updatedAt: 1, sessionIds: [] }])
dmp.apply(small, { token: TOKEN, storeRatePerMin: 0, maxUploadBytes: 64 })
const over = await post(small, '/dsh-md-picker/store', Buffer.from('x'.repeat(128)), {
  'x-filename': encodeURIComponent('big.txt'), 'x-dsh-md-picker-token': TOKEN,
})
assert.equal(over.status, 413, 'oversized payload rejected')

console.log('E2E OK — 落盘地址 =', out.path)
fs.rmSync(TMP, { recursive: true, force: true })
fs.rmSync(wsA, { recursive: true, force: true })
fs.rmSync(wsB, { recursive: true, force: true })
