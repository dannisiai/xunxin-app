# 寻信正式 OTA 发布通道

首个固定签名基线已经发布：**1.0.0，versionCode 14**。显示版本名按用户要求重新从 1.0.0 开始，内部版本代码继续递增，因此高于旧 Debug 版的 13。

## 已部署内容

- 仓库：`dannisiai/xunxin-app`。
- 生产源码分支：`android-ota-production`。
- 基线 APK 源码：`6dda4e78f00c4755e51413bf6c4335fb60c9906f`。
- 工作流：`Publish signed Android OTA`，已在默认分支注册，默认检出生产分支；发布标签使用实际检出的源码提交。
- 四个 Actions Secrets：`SHELL_KEYSTORE_BASE64`、`SHELL_KEYSTORE_PASSWORD`、`SHELL_KEY_ALIAS`、`SHELL_KEY_PASSWORD`。
- Repository variable：`SHELL_SIGNING_CERT_SHA256`。
- 证书 SHA-256：`4c17f30aa35c9d236d84218fc3fb26a3c978dfbacb2aa633bbc92898bfb8be8d`。
- 普通更新，`forceUpdate=false`。

APK：[下载寻信 1.0.0](https://github.com/dannisiai/xunxin-app/releases/download/android-v1.0.0-14/xunxin-1.0.0.apk)。

固定更新清单：[version.json](https://github.com/dannisiai/xunxin-app/releases/download/android-ota-stable/version.json)。客户端启动时或通过设置中的「检查更新」读取这个地址。

APK SHA-256：`813d81afe58c82d4c4288da645e71312f28779445b56cfb4fc7f812a106f12d0`。

成功构建：[42694088775](https://github.com/dannisiai/xunxin-app/actions/runs/42694088775)。首轮构建因 localhost 的网络安全声明缺少 `includeSubdomains` 被 Release lint 阻止；已明确设为 `false`，只允许确切的 localhost 明文例外，保留默认禁止明文和 OTA HTTPS 限制。

## 首次迁移

旧 Debug 包不包含本次 OTA 功能，发布记录中的旧签名也与正式证书不同，不能靠本次清单自动覆盖升级。

1. 在旧版的数据管理中导出完整备份，确认备份文件已保存到 App 之外。
2. 确认备份后再进行换签名安装：卸载旧 Debug 版，安装本页的正式基线 APK，然后导入备份。本次部署没有替用户执行卸载、安装或恢复。
3. 在正式包的设置中点击「检查更新」。目前远端与本机都是 code=14，正常结果是已是最新版本。
4. 后续正式版本沿用同一签名、包名和更新清单，可由 App 提示下载、校验并交给系统安装器覆盖安装。安装最终由用户在 Android 系统界面确认。

## 后续发版

将修改提交到生产源码分支，打开仓库 Actions → Publish signed Android OTA → Run workflow。

- 工作流所在分支可选 `main`。
- `source_ref` 默认 `android-ota-production`；填写已核实的完整提交 SHA 可固定构建输入。
- 下次 `version_code` 至少 `15`，之后持续递增。
- `version_name` 例如 `1.0.1`。
- 填写更新日志；普通更新保持 `force_update=false`。

工作流会检查既有 OTA 版本，使用固定密钥签名，从实际 APK 提取版本并校验生产证书，先发布不可变版本标签中的 APK，成功后再更新 `android-ota-stable/version.json`。推送代码本身不会自动发布正式 APK。

## 密钥与验证范围

私钥及恢复资料保存在受限的本地目录，具体路径见本机 `C:/rjl/private-signing/README.txt`。该目录不属于源码快照，也未公开。另有本机备份；用户仍应另存安全的离线备份。后续请复用此密钥，不能重新生成替换。

本次通过了云端前端构建、Android Release 编译和 lint、APK 数字签名与版本核验及发布。匿名 HTTPS 读取更新清单返回 200；APK HEAD 返回 200、长度 370412823 字节并声明 `Accept-Ranges: bytes`；清单摘要与 GitHub Release 的 APK 摘要一致。

未执行自动化功能测试、模拟器、真机、真实录音、实际 APK 下载安装或旧版数据迁移。响应头声明支持 Range 不等于已完成真机断点续传验收。完整待验收步骤见 [android-ota-updates.md](android-ota-updates.md)。
