// End-to-end test of the host conversion pipeline (real anydoc via npx).
// Run: npm test
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { convertToMarkdown, sanitizeName, stamp, resolveBaseDir, decodeText } from '../lib/index.js'

// pure helpers
const s = sanitizeName('a/b\\c<script>:*.docx')
assert.ok(!/[\\/:*?"<>|\x00-\x1f]/.test(s), 'sanitized name must contain no illegal chars')
assert.ok(s.endsWith('.docx'), 'extension preserved')
assert.match(stamp(new Date()), /^\d{8}-\d{6}-\d{3}$/)
console.log('sanitizeName / stamp OK')

// decodeText: 编码探测(BOM / UTF-16 / GB18030)
assert.equal(decodeText(Buffer.from('hello 世界', 'utf8')), 'hello 世界', 'plain UTF-8')
assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69])), 'hi', 'UTF-8 BOM stripped')
assert.equal(decodeText(Buffer.from([0xff, 0xfe, 0x41, 0x00])), 'A', 'UTF-16LE BOM')
assert.equal(decodeText(Buffer.from([0xfe, 0xff, 0x00, 0x41])), 'A', 'UTF-16BE BOM')
assert.equal(decodeText(Buffer.from([0xc4, 0xe3, 0xba, 0xc3])), '你好', 'GBK fallback (no BOM, invalid UTF-8)')
console.log('decodeText OK')

// real conversion: CSV -> Markdown table (anydoc supports csv)
const csv = '名称,金额\n项目A,1000\n项目B,2000\n'
const res = await convertToMarkdown(Buffer.from(csv, 'utf8'), '测试数据.csv')
assert.ok(res.ok, 'convert should succeed: ' + (res.error ?? ''))
assert.ok(res.markdown.includes('项目A'), 'markdown should contain the data')
assert.equal(res.outName, '测试数据.md')
console.log('convertToMarkdown OK')
console.log('--- markdown preview ---')
console.log(res.markdown.slice(0, 300))
// resolveBaseDir: registry present -> newest workspace wins
const wsA = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-wsA-'))
const wsB = fs.mkdtempSync(path.join(os.tmpdir(), 'dmp-wsB-'))
const fakeCtx = {
  workspaceRegistry: {
    list: () => [
      { path: wsA, updatedAt: 100 },
      { path: wsB, updatedAt: 200 },
    ]
  }
}
assert.equal(resolveBaseDir(fakeCtx), path.join(wsB, 'md-picker-attachments'))
console.log('resolveBaseDir (registry present) OK -> newest workspace wins')

// resolveBaseDir: registry absent -> home fallback
assert.equal(resolveBaseDir({}), path.join(os.homedir(), '.dsh', 'md-picker-attachments'))
console.log('resolveBaseDir (registry absent) OK -> home fallback')

// env override
process.env.DSH_MD_PICKER_DIR = wsA
assert.equal(resolveBaseDir(fakeCtx), wsA)
delete process.env.DSH_MD_PICKER_DIR
console.log('resolveBaseDir (env override) OK')

fs.rmSync(wsA, { recursive: true, force: true })
fs.rmSync(wsB, { recursive: true, force: true })
console.log('ALL TESTS PASSED')
