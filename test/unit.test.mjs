// Pure-logic unit tests for dsh-md-picker host helpers (no network, no anydoc).
// Run: node test/unit.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  sanitizeName, stamp, decodeText, byteHash, toPosix, resolveBaseDir,
  ensureAttachmentsDir, saveUnique, storeFile, cleanupAttachments, DEFAULTS,
} from '../lib/index.js'

// ---- sanitizeName:清洗 + 截断(120)+ 扩展名保留 + 空值兜底 ----
const s = sanitizeName('a/b\\c<script>:*.docx')
assert.ok(!/[\\/:*?"<>|\x00-\x1f]/.test(s), 'no illegal chars remain')
assert.ok(s.endsWith('.docx'), 'extension preserved')
const long = 'x'.repeat(200) + '.txt'
const truncated = sanitizeName(long)
assert.ok(truncated.length <= 120, 'truncated to 120 chars')
assert.ok(truncated.endsWith('.txt'), 'extension survives truncation')
assert.equal(truncated, 'x'.repeat(116) + '.txt', 'stem truncated, extension kept')
assert.equal(sanitizeName(''), 'file.txt')
console.log('sanitizeName OK')

// ---- stamp:定长时间戳 ----
assert.match(stamp(new Date(2026, 8, 4, 15, 4, 40, 123)), /^[0-9]{8}-[0-9]{6}-[0-9]{3}$/)
console.log('stamp OK')

// ---- decodeText:编码探测与多级回退 ----
assert.equal(decodeText(Buffer.from('hello 世界', 'utf8')), 'hello 世界')
assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi', 'UTF-8 BOM stripped')
assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'A', 'UTF-16LE BOM')
assert.equal(decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x41])), 'A', 'UTF-16BE BOM')
assert.equal(decodeText(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), '你好', 'GB18030 fallback')
// Node 的 gb18030 解码器非 fatal:无效字节产出 U+FFFD 而非抛错;latin1 分支是永不抛错的安全网
assert.equal(decodeText(Buffer.from([0xff])), '\ufffd', 'undecodable byte substitutes, never throws')
console.log('decodeText OK')

// ---- byteHash:SHA-256 已知向量 ----
assert.equal(byteHash(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
assert.equal(byteHash('abc'), byteHash(Buffer.from('abc')), 'string/buffer inputs agree')
console.log('byteHash OK')

// ---- toPosix ----
if (path.sep === '\\') assert.equal(toPosix('C:\\a\\b.txt'), 'C:/a/b.txt')
else assert.equal(toPosix('a\\b'), 'a\\b')
assert.equal(toPosix(42), 42, 'non-string passes through')
console.log('toPosix OK')

// ---- resolveBaseDir:env > 会话精确匹配 > 最近 workspace > 家目录回退 ----
const wsX = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-wsX-'))
const wsY = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-wsY-'))
const reg = { workspaceRegistry: { list: () => [
  { path: wsX, updatedAt: 500, sessionIds: ['sess-other'] },
  { path: wsY, updatedAt: 100, sessionIds: ['sess-me'] },
] } }
assert.equal(resolveBaseDir(reg), path.join(wsX, 'md-picker-attachments'), 'no session -> newest updatedAt wins')
assert.equal(resolveBaseDir(reg, { sessionId: 'sess-me' }), path.join(wsY, 'md-picker-attachments'), 'session owner overrides newest')
assert.equal(resolveBaseDir(reg, { sessionId: 'sess-unknown' }), path.join(wsX, 'md-picker-attachments'), 'unknown session -> newest wins')
assert.equal(resolveBaseDir({}), path.join(os.homedir(), '.dsh', 'md-picker-attachments'), 'no registry -> home fallback')
process.env.DSH_MD_PICKER_DIR = wsX
assert.equal(resolveBaseDir(reg, { sessionId: 'sess-me' }), wsX, 'env override beats session')
delete process.env.DSH_MD_PICKER_DIR
console.log('resolveBaseDir OK')

// ---- ensureAttachmentsDir / saveUnique / storeFile / cleanupAttachments ----
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-unit-'))
try {
  ensureAttachmentsDir(dir)
  assert.equal(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), '*\n', 'self-protecting .gitignore written')
  ensureAttachmentsDir(dir) // idempotent
  console.log('ensureAttachmentsDir OK')

  // 同毫秒重名 -> -1 后缀,互不覆盖
  const a = saveUnique(dir, '20260904-000000-000-x.md', '# a')
  const b = saveUnique(dir, '20260904-000000-000-x.md', '# b')
  assert.notEqual(a, b)
  assert.ok(fs.existsSync(a) && fs.existsSync(b), 'both survive')
  assert.match(path.basename(b), /-1\.md$/, 'second write gets -1 suffix')
  assert.equal(fs.readFileSync(a, 'utf8'), '# a')
  assert.equal(fs.readFileSync(b, 'utf8'), '# b')
  console.log('saveUnique OK ->', path.basename(a), '/', path.basename(b))

  // 去重:同内容 -> 返回既有路径;不同内容 -> 新文件;关闭去重 -> 再写一份
  const textA = 'same content again'
  const r1 = await storeFile(dir, stamp(new Date()) + '-a.txt', textA, Buffer.from(textA), { kind: 'text' })
  const r2 = await storeFile(dir, stamp(new Date()) + '-b.txt', textA, Buffer.from(textA), { kind: 'text' })
  assert.equal(r1.duplicate, false)
  assert.equal(r2.duplicate, true, 'duplicate flagged')
  assert.equal(r2.target, r1.target, 'same path returned, nothing rewritten')
  const r3 = await storeFile(dir, stamp(new Date()) + '-c.txt', 'different', Buffer.from('different'), { kind: 'text' })
  assert.equal(r3.duplicate, false)
  assert.notEqual(r3.target, r1.target)
  const r4 = await storeFile(dir, stamp(new Date()) + '-d.txt', textA, Buffer.from(textA), { dedupe: false })
  assert.equal(r4.duplicate, false)
  assert.notEqual(r4.target, r1.target)
  console.log('storeFile dedupe OK')

  // 过期清理:只删带时间戳前缀且早于保留期的文件;非暂存文件不动
  // 过期清理:用"未来 now"前移截止线,避免平台差异的 utimes
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-unit2-'))
  try {
    const oldFile = path.join(dir2, '20260101-000000-000-old.md')
    fs.writeFileSync(oldFile, 'old')
    const futureNow = Date.now() + 30 * 86400000
    assert.equal(cleanupAttachments(dir2, 7, futureNow, 0), 1, 'stamped file older than cutoff removed')
    assert.ok(!fs.existsSync(oldFile), 'old file gone')
    const note = path.join(dir2, 'notes.md')
    fs.writeFileSync(note, 'hi')
    assert.equal(cleanupAttachments(dir2, 7, futureNow, 0), 0, 'non-stamped file untouched')
    assert.ok(fs.existsSync(note))
    assert.equal(cleanupAttachments(dir2, 0, Date.now(), 0), 0, 'retentionDays 0 = keep forever')
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true })
  }
  console.log('cleanupAttachments OK')

  assert.ok(DEFAULTS.retentionDays === 0 && DEFAULTS.dedupe === true, 'sane defaults')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(wsX, { recursive: true, force: true })
  fs.rmSync(wsY, { recursive: true, force: true })
}
console.log('ALL UNIT TESTS PASSED')
