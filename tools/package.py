"""生成顶层含 manifest.json 的 Chrome 扩展安装目录和压缩包。"""

import json
import hashlib
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(__file__).resolve().parents[1]
source = root / "extension"
manifest = json.loads((source / "manifest.json").read_text())
names = ["manifest.json", "background.js", "controller.html", "controller.css", "frame.css",
         "controller.mjs", "core.mjs", "reader.js"]
files = {name: (source / name).read_bytes() for name in names}
for name in set(manifest.get("icons", {}).values()) | set(manifest["action"].get("default_icon", {}).values()):
    assert name.startswith("icons/") and ".." not in Path(name).parts
    files[name] = (source / name).read_bytes()
assert manifest["background"]["service_worker"] in files
assert "manifest.json" in files
files["INSTALL.md"] = """# 安装多文档对照

解压后，在 Chrome“加载已解压的扩展程序”中选择当前文件夹。
本文件夹顶层应能看到 manifest.json，无需再进入 extension 子目录。

这是待实页验证的本地原型。启用前须阅读项目 README 中的权限说明。
连接文档时才申请 example.feishu.cn 站点访问，源码不上传正文、不读取 Cookie。
移除或停用扩展可停止运行；不会关闭已打开的原文档。
""".encode()

output = root / "outputs"
output.mkdir(exist_ok=True)
name = f"multidoc-reader-{manifest['version']}"
# Chrome 按目录识别本地扩展，升级保留原安装路径和扩展身份。
folder = output / "multidoc-reader-0.1.0"
folder.mkdir(exist_ok=True)
receipt = output / f".{folder.name}.sha256.json"
previous_hashes = json.loads(receipt.read_text()) if receipt.exists() else {}
legacy = folder / "extension"
legacy_receipt = output / ".multidoc-reader-legacy.sha256.json"
legacy_hashes = json.loads(legacy_receipt.read_text()) if legacy_receipt.exists() else {}
destinations = [(folder, previous_hashes)]
if legacy.is_dir():
    legacy_manifest = json.loads((legacy / "manifest.json").read_text())
    assert legacy_manifest["name"] == manifest["name"]
    destinations.append((legacy, legacy_hashes))

# 保护用户可能修改过的解压文件，不用新包静默覆盖。
for destination, previous in destinations:
    for filename, content in files.items():
        target = destination / filename
        if target.exists() and target.read_bytes() != content and hashlib.sha256(target.read_bytes()).hexdigest() != previous.get(filename):
            raise SystemExit(f"安装目录已有不同内容，已停止打包：{target}")
for destination, _ in destinations:
    for filename, content in files.items():
        (destination / filename).parent.mkdir(parents=True, exist_ok=True)
        (destination / filename).write_bytes(content)

archive = output / f"{name}.zip"
temporary = archive.with_suffix(".zip.tmp")
with ZipFile(temporary, "w", ZIP_DEFLATED) as package:
    for name, content in files.items():
        package.writestr(name, content)
with ZipFile(temporary) as package:
    assert package.testzip() is None
    assert set(package.namelist()) == set(files)
    assert json.loads(package.read("manifest.json")) == manifest
    for name, content in files.items():
        assert package.read(name) == content
        for destination, _ in destinations:
            assert (destination / name).read_bytes() == content
temporary.replace(archive)
receipt.write_text(json.dumps({name: hashlib.sha256(content).hexdigest() for name, content in files.items()}, indent=2) + "\n")
if legacy.is_dir():
    legacy_receipt.write_text(receipt.read_text())
print(f"已生成安装目录：{folder}")
if legacy.is_dir():
    print(f"已同步 Chrome 旧登记目录：{legacy}")
print(f"已生成压缩包：{archive}")
print("验证通过：manifest.json 位于顶层，全部运行文件及图标与源码一致，未覆盖其他文件。")
