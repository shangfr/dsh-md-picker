
// 生产语义 E2E:apply(fiber 活跃)捕获服务实例 -> 很久之后才触发 handler
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import * as dmp from '../lib/index.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-e2e-'))
const handlers = {}
const tapped = []

const fakeCtx = {
  // 模拟真实 host:apply 期间 ctx.workspaceRegistry 可用
  webServer: {
    register: (r) => { handlers[r.path] = r.handler },
    tapIndex: (h) => { tapped.push(true); return h('<html/>') },
  },
  effect() {},
  workspaceRegistry: { list: () => [{ path: TMP, updatedAt: 42 }] },
}

dmp.apply(fakeCtx)   // apply 完成 -> fiber 结束 -> ctx scope 失效(生产等价)

// 模拟很久之后的 HTTP 请求(闭包只持有 wsRegistry 实例)
async function post(pathName, body, headers = {}) {
  let captured = {}
  const res = { writeHead: (s, h) => { captured.status = s; captured.headers = h }, end: (b) => { captured.body = b } }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body)
  const req = new EventEmitter()
  req.headers = { 'content-length': String(buf.length), ...headers }
  const done = handlers[pathName](req, res)
  await new Promise((ok) => setImmediate(ok))
  req.emit('data', buf)
  req.emit('end')
  await done
  return captured
}

const resp = await post('/dsh-md-picker/store', Buffer.from('hello 工作区', 'utf8'), { 'x-filename': encodeURIComponent('note.txt') })
const out = JSON.parse(resp.body)
console.log('store response:', resp.body)
const expectedDir = path.join(TMP, 'md-picker-attachments')
assert.equal(path.dirname(out.path), expectedDir, 'file must land in the WORKSPACE dir')
assert.ok(fs.existsSync(out.path), 'file must exist on disk')
assert.equal(fs.readFileSync(out.path, 'utf8'), 'hello 工作区', 'utf-8 text saved verbatim')
assert.ok(typeof out.preview === 'string' && out.preview.length > 0, 'store returns preview')

// GBK 编码文本("你好" 的 GBK 字节):服务端应识别并统一为 UTF-8 落盘
const gresp = await post('/dsh-md-picker/store', Buffer.from([0xc4, 0xe3, 0xba, 0xc3]), { 'x-filename': encodeURIComponent('gbk.txt') })
const gout = JSON.parse(gresp.body)
assert.equal(fs.readFileSync(gout.path, 'utf8'), '你好', 'GBK decoded and stored as UTF-8')

const cresp = await post('/dsh-md-picker/store', Buffer.from('x', 'utf8'), { 'x-filename': encodeURIComponent('b.txt') })
const out2 = JSON.parse(cresp.body)
assert.equal(path.dirname(out2.path), expectedDir)
console.log('E2E OK — 落盘地址 =', out.path)
fs.rmSync(TMP, { recursive: true, force: true })