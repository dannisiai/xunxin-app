# 寻信 App

AI 虚拟手机，包含角色聊天、一起看抖音和小红书、语音回复及按 AI 保存的伴宠头像。

## 下载与更新

- [下载最新 Android 安装包](https://github.com/dannisiai/xunxin-app/releases/latest)
- [自动更新地址](https://github.com/dannisiai/xunxin-app/releases/download/android-ota-stable/version.json)

首次发布显示版本为 **1.0.0**，内部版本号从 23 继续递增，沿用原签名与包名，支持覆盖旧版安装。旧版首次迁移到新仓库时需手动安装新包；之后 App 会自动检查更新，安装时仍需系统确认。

## 自动发布

推送代码到 `main` 会在云端构建下一个版本，也可手动运行 `Publish Android` 工作流指定显示版本与更新说明。默认由本地私钥签名后发布安装包及稳定更新通道，签名私钥和密码保留在维护者本机；如果维护者自行配置仓库签名 Secrets，工作流也支持自动签名发布。后续发布须继续使用同一签名。

构建前检查源码，构建后检查前端与服务端编译产物，发布前检查实际 APK 内的页面文件。如果发现已删除的三处编码「使用声明」弹窗载荷，流程会停止。

## 本地开发

使用 `.nvmrc` 指定的 Node.js 版本，运行 `npm ci` 和 `npm run dev`。Android 原生改动需要重新构建 APK。

## 开源许可

保留原项目的 AGPL-3.0 许可及第三方声明，详见 [LICENSE](LICENSE) 和 [NOTICE](NOTICE)。
