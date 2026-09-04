<p align="center"><img src="assets/icon.png" width="96" alt="dsh-md-picker icon"/></p>

# dsh-md-picker

DeepSeek Harness Web GUI 插件：在会话输入框左侧添加一个「文档 + Markdown」按钮，通过系统文件选择器添加附件并转换成 Markdown 格式。

- **图片**（png/jpeg/webp/gif）→ 合成 drop 注入官方附件管线：缩略图 rail、数量/大小校验、随消息上传
- **文本类**（`.txt` / `.md` / `.markdown`）→ 读原始字节上传，服务端自动识别编码（BOM / UTF-8 / UTF-16 / GB18030 等）后**统一按 UTF-8** 暂存到**当前工作目录**下的 `md-picker-attachments/`（按 **会话所属 workspace → 最近使用的 workspace** 解析；环境变量 `DSH_MD_PICKER_DIR` 显式覆盖优先；不可用时回退 `~/.dsh/md-picker-attachments/`）
- **可转换文档**（`.doc/.docx/.docm` `.ppt/.pps/.pot/.pptx/.pptm/.ppsx/.ppsm` `.xls/.xlsx/.xlsm/.xlsb` `.pdf` `.rtf` `.odt/.ods/.odp` `.csv` `.epub`）→ 浏览器读出原始字节 POST 到本地服务端，由 [anydoc](https://github.com/firecrawl/anydoc) 转成 **Markdown** 后落盘
- **重复上传去重**（SHA-256 内容指纹）→ 同内容仅返回既有路径并标注，不重复落盘
- **访问安全**（v1.3.0）→ 进程级随机令牌随 client.js 下发，路由缺令牌返回 401；每 IP 每路由速率限制
- **附件目录自保护** → 创建 `md-picker-attachments/` 时自动写入 `.gitignore`（`*`），目录不进 git 工作区
- **上传进度 & 任意位置拖放** → 文档上传显示百分比；文档可直接拖到输入框任意位置，图片照常走官方管线
- **其它类型**（如 `.zip`）→ 不静默丢弃，回执会列出「未处理」清单

三类文件都只往消息里插入一段极短的**回执**（保存路径 + 字符数 + 120 字预览），正文不进会话上下文，agent 用普通读取工具按需取用。

## 为什么这样设计

1. **官方附件管线是图片专用**——文档走不了上传路径，直接内联又会撑爆上下文
2. **浏览器拿不到高保真结构**——`docx` 在浏览器里只能抽出纯文本；服务端 anydoc 保留标题层级、表格（含合并单元格）、列表等完整 Markdown 结构
3. **anydoc 纯 Rust 无 ML、中位 <5ms**——宿主机 `npx` 按需拉取，本插件不捆绑二进制

## 工作原理

```
点击按钮（或直接把文件拖到按钮上）→ <input type="file" multiple>
  ├─ image/*            → DataTransfer + 合成 drop → 官方 ComposerAttachments 接收
  ├─ .txt/.md/.markdown → POST /dsh-md-picker/store（原始字节 + X-Filename + 令牌 + 可选会话 id）
  │                       → 编码探测（BOM/UTF-8/GB18030…）→ SHA-256 去重 → 统一 UTF-8 暂存到工作目录
  ├─ 可转换文档          → POST /dsh-md-picker/convert（原始字节 + X-Filename + 令牌 + 可选会话 id）
  │                       → anydoc 转 Markdown（服务端信号量：同时最多 2 个，其余排队）
  │                       → SHA-256 去重后落盘工作目录 md-picker-attachments/（XHR 上传进度）→ 按钮状态机
  └─ 其它类型            → 回执列出「未处理」清单
  （文本/图片选择不触发状态——近即时操作避免闪烁）
```

## 容量与安全护栏

| 护栏 | 说明 |
|---|---|
| 单文件上传上限 | 25 MB（超出返回 413） |
| 文件名 | 清洗非法字符 + 时间戳前缀，防路径遍历 |
| 暂存目录 | 解析顺序：环境变量 `DSH_MD_PICKER_DIR` 显式覆盖 → **会话所属 workspace**（client 带 `X-Session-Id` 时精确匹配）→ **当前工作目录**（workspaceRegistry 中最近使用的 workspace 根）下的 `md-picker-attachments/` → 回退 `~/.dsh/md-picker-attachments/`（注册表不可用或无 workspace 时）。agent 文件工具在会话沙箱内即可直接读取 |
| 转换超时 | 120s（首次运行 npx 会下载 anydoc，稍慢属正常） |
| 扫描 PDF | anydoc 退出码 3 → 返回 422 并提示需 OCR（可用 anydoc `--ocr hosted`） |
| 文本编码 | 读原始字节自动探测：BOM / UTF-8 / UTF-16 / GB18030 等，统一按 UTF-8 落盘（修复 GBK 中文乱码） |
| 文本类降级 | 暂存接口不可用时自动回退全文内联：单文件 3 万字符 + 多文件合计 6 万字符封顶 |
| 并发转换 | 服务端信号量：同时最多 2 个 anydoc 进程，其余排队（队列上限 16，超限返回 429） |
| 重复上传去重 | 同内容（原始字节 SHA-256）仅返回既有路径并标注 duplicate，不重复落盘 |
| 访问鉴权 | 进程级随机令牌随 client.js 下发，路由缺令牌返回 401；写盘/转换端点不再对 LAN 裸奔 |
| 速率限制 | 每 IP 每路由每分钟上限（`/store` 300、`/convert` 20），超限 429 + `Retry-After` |
| 附件目录自保护 | 创建 `md-picker-attachments/` 时自动写入 `.gitignore`（`*`），目录不进 git |
| 原子唯一落盘 | 同毫秒重名自动追加 `-1`/`-2` 后缀，绝不覆盖既有文件 |
| 保留清理 | Config `retentionDays`：按保留天数清理过期附件并同步去重清单（默认 0 = 永久保留） |
| 配置化 | 上限/超时/并发/队列/目录/保留天数/令牌均可通过插件 Config 覆盖，无需改代码 |
| 操作方式 | 点击按钮选择，也支持把文件直接拖放到按钮上（悬停高亮） |
| 按钮状态机 | 文档转换期间显示旋转弧线（`aria-busy` + tooltip）；结束绿勾（1.5s 回弹）或红叉+红描边；多文件按 pending 计数，全部结束才出结果态；`prefers-reduced-motion` 下停用旋转动画；结果通过 `aria-live` 播报 |

## 安装（web profile）

```bash
dsh plugin add github:shangfr/dsh-md-picker
# 重启 dsh web 生效
```

要求：

- 仓库已声明 `dsh.bundle`（本包已声明）
- 宿主机有 Node 20+ 与 npx（DSH Desktop 自带）；首次转换时 npx 自动下载 anydoc
- 收录 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 后可在 DSH Desktop 插件市场一键安装

## 版本

- **1.3.0** — 会话感知落盘（`X-Session-Id` 精确匹配会话属主 workspace，回退最近使用）；SHA-256 内容去重（`manifest.json` 登记）；进程级令牌鉴权 + 每路由速率限制；anydoc 临时文件名固定（用户文件名不再进 shell 命令行）；原子唯一落盘（`-1/-2` 后缀防同毫秒覆盖）；附件目录 `.gitignore` 自保护；Config 配置化 + 按保留天数清理；XHR 上传进度；输入框任意位置拖放文档；回执路径统一正斜杠
- **1.2.0** — 文本编码探测（GBK/UTF-16 等统一 UTF-8，修复中文乱码）；内联降级单文件 3 万 + 总量 6 万字符封顶；服务端并发转换限流（同时 2 个 + 排队，超限 429）；支持拖放到按钮；`aria-live` 播报结果
- **1.1.2** — 按钮状态机：转换期间旋转弧线（`aria-busy` + tooltip 提示），成功绿勾 1.5s 回弹、失败红叉+红描边；多文件按 pending 计数；`prefers-reduced-motion` 下停用动画；纯文本/图片选择不触发状态