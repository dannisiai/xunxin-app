# Android 应用内 OTA 更新

## 实现

MainActivity 启动时自动检查 HTTPS version.json；设置首页新增「检查更新」。原生 AlertDialog 展示版本、日志、立即更新/稍后更新、进度、取消、重试和安装状态。生产浏览器和没有对应桥接口的旧壳不显示新按钮；本地开发浏览器提供明确标注的样式预览，不执行真实下载安装。

网络复用现有 OkHttp，UI 复用 AppCompat，安装使用现有 AndroidX FileProvider。唯一新增依赖是 Google 官方 com.android.tools.build:apksig:8.5.2，用于验证 APK 内容的真实数字签名，避免仅凭读取到某个嵌入证书就认定签名有效。

清单六个字段必填：versionCode 为 1～2147483647 的 JSON 整数，versionName 为不超过 80 字符的非空字符串，apkUrl 为 HTTPS，sha256 为 64 位十六进制，forceUpdate 为 JSON 布尔值，releaseNotes 最多 20000 UTF-16 单元。清单最大 64 KiB。只有服务端 versionCode 高于本地才提示。

下载使用应用私有 files/ota/，支持 Range、可用的 If-Range（强 ETag 或 Last-Modified），校验 Content-Range 和实际字节数。服务器忽略 Range 返回 200 时重新写入，绝不拼接到旧断点。进程死亡后保留已写断点；切后台主动暂停，回到前台由用户继续，没有额外后台常驻下载服务。

下载后和每次安装前检查 SHA-256、真实数字签名、包名、APK 与清单版本一致、版本严格提高、当前设备最低系统要求、当前签名者集合一致。校验失败仅删除 OTA 候选文件；绝不自动卸载 App、清空 WebView、IndexedDB、聊天或媒体。安装由系统完成，允许用户拒绝；未知来源授权被拒绝、安装被取消或失败时旧版仍保留。

强制更新确认后卸载业务 WebView 页面，停止推送与伴侣服务，显示原生门禁。已知强制策略会缓存，重启或离线不会解除；支持暂停、继续、重试、重新检查和退出。有效 HTTPS 清单可撤回 forceUpdate；安装版本满足要求后门禁失效。通知接听和伴侣入口不能绕过门禁。

首次无缓存且检查失败时允许继续原业务；已缓存强制要求时，失败保持门禁。离线客户端无法获知尚未接收的新策略，接口服务端也应限制不兼容客户端。不支持拆分 APK/AAB、静默安装或隐式证书轮换；当前签名者集合必须完全相同。

## 完整修改文件

| 文件 | 用途 |
| --- | --- |
| android-shell/app/src/main/java/app/floatphone/shell/AppUpdateRepository.kt | HTTPS 清单、缓存、断点下载、摘要、真实签名及身份校验 |
| android-shell/app/src/main/java/app/floatphone/shell/AppUpdateController.kt | 原生弹窗、进度、门禁、安装授权返回、系统安装器 |
| android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt | 启动和设置桥、生命周期、业务门禁、版本改读 BuildConfig |
| android-shell/app/src/main/java/app/floatphone/shell/PushService.kt | 强制更新期间阻止推送业务恢复 |
| android-shell/app/src/main/java/app/floatphone/shell/CompanionOverlayService.kt | 强制更新期间阻止伴侣恢复 |
| android-shell/app/src/main/java/app/floatphone/shell/IncomingCallActivity.kt | 强制更新期间将旧来电入口转到更新界面 |
| android-shell/app/src/main/java/app/floatphone/shell/CallActionReceiver.kt | 旧通知接听不能绕过门禁 |
| android-shell/app/src/main/AndroidManifest.xml | 安装权限、非导出 FileProvider、OTA 备份排除 |
| android-shell/app/src/main/res/xml/update_file_paths.xml | 仅暴露 ota/verified/ 给安装器 |
| android-shell/app/src/main/res/xml/backup_rules.xml | 排除 OTA 缓存与策略的旧系统备份规则 |
| android-shell/app/src/main/res/xml/data_extraction_rules.xml | Android 12+ 云备份与设备迁移排除规则 |
| android-shell/app/build.gradle | HTTPS 更新地址、环境变量版本、apksig 依赖 |
| android-shell/third-party/Apksig-LICENSE.txt | Google apksig 原始 Apache 2.0 许可证，随现有 assets 打包 |
| components/settings/app-update-settings.tsx | 原生桥检测和设置按钮 |
| components/phone-settings-app.tsx | 设置首页入口 |
| scripts/create-android-update-feed.py | 从实际 APK 提取版本、校验生产证书并生成清单 |
| .github/workflows/android-ota-release.yml | 手动触发的固定签名正式发布流程 |
| .gitignore | 排除签名私钥容器 |
| android-shell/README.md | 本文入口 |
| docs/examples/android-version.example.json | 仅供参考、不能直接部署的清单示例 |
| docs/android-ota-updates.md | 部署与验收文档 |

原 debug 工作流保持原样；新 OTA 工作流需要手动触发。生产源码使用独立分支 `android-ota-production`，工作流默认从该分支检出，发布标签记录实际检出的源码提交。

## 固定签名：免费

Android 签名无需购买证书。用 JDK 17 自带 keytool 生成自签名密钥，之后每次正式发布使用同一密钥；私钥和密码必须长期安全备份。已有正式密钥时继续使用，不要重新生成。

```powershell
# 先创建自己的安全目录；路径仅为示例，密码通过交互输入。
keytool -genkeypair -v -keystore C:\private\xunxin-release.jks -alias xunxin -keyalg RSA -keysize 4096 -validity 10000
keytool -list -v -keystore C:\private\xunxin-release.jks -alias xunxin
```

第二条显示公开 SHA256 证书指纹。私钥不要提交到仓库、发到聊天或放进 version.json。

此前 1.2.8/1.2.9 使用临时 Debug 签名，且两版证书已确认不同。旧私钥若未保留，无法直接换签覆盖；OTA 也不能绕过 Android 同签名规则。必须先从旧版导出完整应用备份，再手动迁移到包含 OTA 代码的首次固定签名版并导入备份，此后才能同签名 OTA。没有 OTA 代码的旧 APK 不会因服务器新增清单而获得更新能力。

## GitHub 部署

默认更新源为固定通道：

`https://github.com/dannisiai/xunxin-app/releases/download/android-ota-stable/version.json`

该地址在首次成功部署前不一定存在。专用 tag 避免其他 Debug Release 影响 latest。新版本必须继续指向同一个稳定通道，地址迁移时保留旧地址或使用有效 HTTPS 跳转。

1. 提交本次代码到构建仓库。
2. 在 Settings → Secrets and variables → Actions 配置 Secrets：SHELL_KEYSTORE_BASE64（固定 jks 的 Base64）、SHELL_KEYSTORE_PASSWORD、SHELL_KEY_ALIAS、SHELL_KEY_PASSWORD。
3. 配置 Repository variable SHELL_SIGNING_CERT_SHA256：真实证书 SHA256，去掉冒号，64 位十六进制字符串。
4. Actions → Publish signed Android OTA → Run workflow，源码引用 `source_ref` 默认 `android-ota-production`，也可以填写已核实的不可变提交 SHA。填写比所有已分发 APK 都大的 version_code、版本名、更新日志和 force_update。正式 OTA 基线的显示版本名为 `1.0.0`，内部 versionCode 为 `14`，高于已分发的 code=13；后续使用 15、16……递增。不要依赖版本名排序。
5. 工作流强制要求固定密钥，使用 apksigner 验证 APK，并与公开指纹核对；不一致即失败，不回退 Debug。版本号、名称、包名和 sha256 均从实际 APK 获取。
6. 先发布不可变 APK Release，成功后才替换 android-ota-stable 中的 version.json。旧 APK 不覆盖；发布中途失败不会让客户端安装未完成的新文件。GitHub --clobber 替换清单有短暂 404 的可能，客户端保留旧策略与断点。
7. 确认目标网络可访问 APK 与清单，再分发首个正式 OTA 基线包并完成下方验收。

GitHub CLI 配置示例，不把私钥打印到终端：

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\private\xunxin-release.jks')) | gh secret set SHELL_KEYSTORE_BASE64 --repo dannisiai/xunxin-app
gh secret set SHELL_KEYSTORE_PASSWORD --repo dannisiai/xunxin-app
gh secret set SHELL_KEY_ALIAS --repo dannisiai/xunxin-app
gh secret set SHELL_KEY_PASSWORD --repo dannisiai/xunxin-app
gh variable set SHELL_SIGNING_CERT_SHA256 --repo dannisiai/xunxin-app --body '替换为真实64位公开指纹'
```

Fork 的新工作流使用该 fork 仓库的固定通道；手动构建时自行传入 SHELL_UPDATE_URL。

## 自有 HTTPS/CDN 部署

沿用原打包方法准备前端和本地 Node 资源，然后配置构建环境：

```powershell
$env:SHELL_VERSION_CODE='14'
$env:SHELL_VERSION_NAME='1.3.0'
$env:SHELL_UPDATE_URL='https://updates.example.com/xunxin/version.json'
$env:SHELL_KEYSTORE_FILE='C:\private\xunxin-release.jks'
# 密码与 alias 通过安全环境注入，不写入源码。
gradle -p android-shell assembleRelease
```

把 APK 放到不可变 HTTPS 地址后，使用 Android SDK build-tools 生成真实清单：

```powershell
python scripts/create-android-update-feed.py --apk android-shell/app/build/outputs/apk/release/app-release.apk --apk-url https://updates.example.com/xunxin/xunxin-1.3.0.apk --notes-file release-notes.txt --expected-certificate-sha256 真实64位公开证书指纹 --output release/version.json
```

强制更新增加 --force-update。脚本通过 ANDROID_HOME/ANDROID_SDK_ROOT 查找工具，也可指定 --aapt 和 --apksigner。最后在服务器原子替换 version.json；不能先更新清单再上传 APK。示例 JSON 的全零摘要是假数据，禁止直接部署。

建议清单 Cache-Control: no-cache；APK 提供 Content-Length、Accept-Ranges: bytes、强 ETag/Last-Modified 及正确 206/Content-Range。没有 Range 仍可下载，但会从头开始。OTA 由原生请求，不需要浏览器 CORS。单包限制 2 GiB。

所有更新地址必须 HTTPS，不接受 URL 内嵌凭据或片段，允许正常签名查询参数；禁止 HTTPS→HTTP 跳转及证书/主机名校验绕过。原项目仅本机 Node 的 localhost HTTP 例外保留，但不能用于 OTA。

## 验收步骤：仅提供，本次未执行

准备测试专用的同包名、同固定证书低版本 A 和高版本 B，以及可信测试 HTTPS 通道。异常包或强制策略不能放进生产通道。

| 场景 | 操作与预期 |
| --- | --- |
| 启动与手动检查 | 安装 A，清单指向 B；启动和设置检查都显示原生版本/日志，连续点击不产生并行任务 |
| 相同/更低版本 | 清单 code≤本机，不提示更新；手动检查显示已是最新版 |
| 稍后更新 | 普通更新点击稍后，继续原业务；下次启动仍可检查 |
| 下载进度 | 大 APK 显示已下载/总 MB；无 Content-Length 时显示不定进度 |
| 取消与续传 | 中途取消后继续；Range 服务器从断点继续，无 Range 从头写入 |
| 断网/空间不足 | 出错后显示重试；网络/存储恢复后继续，旧版与数据仍保留 |
| Range 协议 | 检查合法 206、忽略 Range 的 200、416、错误 Content-Range；只有匹配范围才能拼接 |
| 文件变更 | 同 URL 改内容及 ETag，If-Range 失效从头下载；摘要不匹配拒绝安装 |
| 生命周期 | 中途杀进程、切后台、折叠/旋转再恢复；有效断点保留，没有重复任务或窗口泄漏 |
| 摘要错误 | 测试清单写错 sha256，拒绝并删除候选包，可重新下载 |
| 真正验签 | 修改 APK 内容并相应修改测试清单摘要，apksig 仍拒绝无效签名 |
| 身份与版本 | 其他包名、其他签名、降级、与清单版本不一致，均在安装器之前拒绝 |
| HTTPS | HTTP URL、HTTPS→HTTP、无效证书均拒绝，无证书绕过 |
| 安装授权 | 关闭未知来源权限；允许后返回重新校验并进入系统安装器；拒绝可重试或退出 |
| 授权时进程死亡 | 在授权页结束 App 进程，再返回；恢复待安装标记，不跳过权限与校验 |
| 安装取消/失败 | 系统安装器取消或设备限制安装，旧版和数据保留，允许再安装 |
| 强制更新 | forceUpdate=true，下载失败、断网、返回、重启，仍保持门禁，可暂停/重试/检查/退出 |
| 旁路入口 | 强制期间旧来电通知、伴侣服务不能进入旧业务 |
| 撤回策略 | 有效 HTTPS 清单改为 forceUpdate=false，下次有效检查解除门禁 |
| 成功及数据 | A 中创建聊天/角色/媒体，覆盖到 B 后数据仍在，本地版本提高，门禁解除 |
| 系统备份 | 云备份与设备迁移不携带 OTA 安装包、断点和旧设备策略 |

## 验证范围

初始实现阶段只做静态源代码、TypeScript 类型、XML/JSON/YAML/Python 语法和调用路径检查，静态报告位于 C:/rjl/android-ota-implementation-20261109/。后续生产部署已通过 GitHub Actions 的前端构建、Android Release 编译和 lint，以及 APK 签名与版本核验；实际发布状态见 [android-ota-production.md](android-ota-production.md)。未运行应用、下载/安装功能测试、模拟器、真机或数据迁移验收，不能据此宣称设备兼容或覆盖更新实测通过。

上线需配置固定签名、发布首个基线 APK 和有效清单，并完成上表验收。尤其验证 Android 8+、厂商 ROM、实际 CDN Range 和旧版数据迁移。部署是否完成以 GitHub 工作流结论、Release 资产和 HTTPS 清单的实际状态为准。

官方依据：[应用签名](https://developer.android.com/studio/publish/app-signing)、[FileProvider](https://developer.android.com/reference/androidx/core/content/FileProvider)、[安装来源授权](https://developer.android.com/reference/android/content/pm/PackageManager#canRequestPackageInstalls())、[Google apksig](https://android.googlesource.com/platform/tools/apksig/)。
