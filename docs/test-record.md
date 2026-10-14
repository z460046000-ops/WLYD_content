# 测试记录

日期：2026-10-14。测试对象为独立项目 `@wlyd/dsh-material-knowledge-assembly@0.1.0`。

| 验证 | 结果与边界 |
|---|---|
| `npm run check` | 五个源码文件语法检查通过 |
| `npm test` | 7/7：逐文件格式状态、乱码/损坏、模板与自定义章节约束、可见项目绑定、无据数字与引文拒绝、本地成稿、默认上传和解析状态模拟、多项目选择及伪造附件拒绝 |
| 原件转换抽查 | 30 页文字 PDF 取到 11670 字；BIP PPTX 取到 31675 字；现有 DOCX 取到 749 字；合成 XLSX 行列提取通过。这里只验证可读文字，不判断视觉、图表或业务事实完整性 |
| 后端只读联调 | 配置账号列出 8 个项目；在可见项目绑定库中找到 6 个 `completed` 文档；`hybrid-search` 返回 6 个片段，首项具备文档 ID、chunk ID 和正文。未打印、打包或提交片段内容 |
| 独立 DSH profile | `assembly-test` 与 `wlyd-assembly-acceptance-20261014` 均从 DSH base 起步；从 `.tgz` 安装成功；`--dump-config` 有独立 Cordis ID，未出现旧售前插件或 HTML Anything；从已安装包加载并注册 5 个独立工具 |
| 包白名单 | `npm pack --dry-run`/tar 列表只含 `src/`、`rules/`、`docs/`、README、manifest、Cordis patch；无旧插件源码、goodcase 原件或凭证 |

## 尚未完成的真实验收

- 未向生产内容中台上传测试材料，因此真实 multipart 接收、解析中/失败/完成、幂等和服务端拒绝尚未联调。自动测试只验证请求构造和状态处理。
- 未在 DSH WebUI 逐键拖入附件、与真实模型对话生成报告；本地模型接口使用合成流验证，报告语义需人工核对。
- 未测试 OCR、DMG 只读提取、旧 Office、音视频、链接抓取；这些在本版返回明确状态或不提供入口。
- DSH 用户与平台配置账号的身份映射、上传人的后端字段尚无正式契约。`platformUserId` 保持空。
- `npm audit --omit=dev` 检出 5 项中危依赖告警，来源于 `exceljs`、`mammoth` 的传递依赖；未使用可能破坏兼容性的强制降级修复。
