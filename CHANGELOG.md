# Changelog

## 1.2.0

- 文本编码探测：`.txt/.md/.markdown` 改为**原始字节上传**，服务端识别
  BOM / UTF-8 / UTF-16 / GB18030 并统一按 UTF-8 落盘（修复 GBK 中文乱码）；
  store 响应新增 preview，回执不再依赖浏览器端解码
- 内联降级总量上限：单文件 3 万字符之外，多文件内联合计不超过 6 万字符
  （此前 `INLINE_TOTAL_CHAR_CAP` 仅声明未使用）
- 并发转换限流：服务端信号量，同时最多 2 个 anydoc 进程，其余排队
  （队列上限 16，超限返回 429）
- 支持把文件直接拖放到按钮上（dragover/drop + 悬停高亮）
- a11y：转换结果通过 `aria-live` 播报（成功/失败），不再只靠颜色与 title

## 1.1.2

- 按钮状态机：文档转换期间显示旋转弧线（aria-busy + tooltip 提示），完成后
  绿勾 1.5s 回弹，失败红叉+红描边；多文件按 pending 计数，全部结束才出结果态
- `prefers-reduced-motion` 下停用旋转动画；纯文本/图片选择不触发状态
  （近即时操作避免闪烁）

## 1.1.1

- 专用图标：Composer 按钮由通用回形针改为"文档(折角) + Markdown M↓"字形
  （currentColor 跟随主题）；新增品牌图标 `assets/icon.svg` 与 512px
  `assets/icon.png`（市场提交用——dshmarket 丢弃 SVG，仅收白名单主机位图）

## 1.1.0

- **落盘地址默认改为当前工作目录**：解析 workspaceRegistry 中最近使用的
  workspace 根，存到 `<工作目录>/md-picker-attachments/`——agent 文件工具
  在会话沙箱内即可直接读取，回执路径不再指向主目录
- 解析顺序：环境变量 `DSH_MD_PICKER_DIR` 显式覆盖 → 最近 workspace →
  回退 `~/.dsh/md-picker-attachments/`（注册表不可用或无 workspace 时）
- 修复（关键）：cordis 插件 fiber 结束后其 ctx scope 失效——请求期穿 ctx 访问
  服务会静默回退。现在 apply 期间（fiber 活跃）捕获 workspaceRegistry 服务
  实例，handler 闭包直接持有实例，请求期不再触碰 ctx
- 服务必须显式 `inject`（cordis isolate 语义——未声明的服务在插件 ctx 上
  不可见，`ctx.get` 也不存在），`inject: ['webServer', 'workspaceRegistry']`
- `resolveBaseDir` 独立导出，带单测（registry 在场/缺席两分支）

## 1.0.0 (2026-09-04)

- 首版：📎 三路路由——图片合成 drop 直传官方附件管线；文本类原样暂存；
  文档经本地 anydoc 转 Markdown 后暂存
- 回执式插入（路径 + 字符数 + 120 字预览），正文不进会话上下文
- 护栏：25MB 上限、文件名清洗、120s 转换超时、扫描 PDF 明确报 422、文本内联降级
