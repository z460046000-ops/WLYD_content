# Fireworks 静态 SVG 资源

这里保留固定提交 `31fea364eda5f1852b1175f3d9e29ea31d22dcb4` 下
`skills/fireworks-tech-graph/` 中本插件需要的原件、MIT 许可和参考规则。
每份原件的上游路径与 SHA-256 见 `UPSTREAM.json`。

本插件当前使用 `architecture`、`style: 4`、`semantic_profile: "generic"`，
通过 Python 3.9+ 标准库生成静态 SVG。节点、分组和连线的坐标由插件适配层提供。
本目录是裁剪后的运行资源；原版 `SKILL.md` 中提到的统一 CLI、其他导出路径和未收录参考不属于本次交付。

从标准输入读取 UTF-8 JSON：

```bash
python3 -B scripts/generate-from-template.py architecture output.svg --report layout.json < input.json
python3 -B scripts/validate_svg.py output.svg --check xml
python3 -B scripts/validate_svg.py output.svg --check markers
python3 -B scripts/validate_svg.py output.svg --check collisions
python3 -B scripts/validate_svg.py output.svg --check geometry
python3 -B scripts/validate_svg.py output.svg --check composition
```

生成器第三个位置参数接受的是 JSON 字符串；文件内容应通过标准输入传入。
检查器每次执行一项检查：通过时退出码为 `0`，标准输出为空；失败时退出码为 `1`，标准输出逐行说明问题。
生成器会输出简短文本，完整结构结果应读取 `layout.json`。其中 `issues`、`typography`、`palette` 等用于判断文字完整性与检查范围。

实际运行验证使用 Python 3.11.3：中文标题、分组、节点主副标题和一条连线已生成 SVG，五项检查均通过。
Python 3.9 仅核对了上游最低版本要求和语法兼容性；没有运行 Python 3.9。
这些检查不代替中文字体和实际观感的人工确认。
