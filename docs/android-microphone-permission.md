# 寻信 APK 麦克风权限恢复

## 旧 APK 立即可以检查的设置

手机设置 → 应用/应用管理 → 寻信 → 权限 → 麦克风/录音 → 使用期间允许。Android 12+ 还要检查控制中心或隐私设置中的麦克风访问总开关。返回应用后重新点击连接或录音。不同品牌菜单名称可能不同。

应用不能自行强制开启被用户或系统禁止的权限，不使用反射或隐藏 API 绕过授权。

## 本次代码修复

原 AndroidManifest 已经声明 RECORD_AUDIO，并非简单漏声明。原实现存在以下缺口：

- 没有设置里的独立录音授权入口。实时连接先申请远端凭据再请求麦克风，因此网络/模型错误可能导致用户始终看不到录音授权窗口。
- 缺少 onPermissionRequestCanceled 清理，已失效的 WebView 请求可能留在 pending 状态，让后续请求被直接拒绝。
- 拒绝后只返回通用错误，没有应用系统权限页的恢复入口。
- 授权返回时没有重新核对请求源；未知资源的空权限列表不能被当作已授权。
- 按住说话在等待首次系统授权时若已经松手，原逻辑仍可能在授权后开始录音，直到超时。

现在新增原生 WebMediaPermissionController，统一系统权限与 WebView 权限的处理。只转授站内来源申请的麦克风和相机，取消、页面跳转、强制更新门禁及 Activity 销毁时清理失效请求。并行系统申请不会互相顶替，授权结果返回后重新检查来源和实际权限。

设置首页新增「麦克风权限」，可读取应用录音权限、申请授权、打开应用权限页以及系统隐私设置。这里只申请权限和读取状态，不会开启录音，也不调用语音 API。回到应用时重新读取状态；用户仍需主动点击通话或录音。

通过公开 AudioManager.isMicrophoneMute 读取系统报告的静音状态，只提示检查总开关，不能据此精确认定静音来源。未使用非公开的 SensorPrivacyManager 查询方法，也不会替用户更改全局静音状态。

普通录音、MiniCPM/Gemini 音频采集及 OpenAI Realtime 现在区分应用录音未授权、系统报告静音、设备占用、不安全页面和 WebView 不支持等错误。首次授权时松开的录音会被丢弃并释放麦克风，提示重新按住说话。

录音器创建或启动失败时也会释放已取得的麦克风，避免失败后继续占用输入设备。

## 修改文件

- android-shell/app/src/main/java/app/floatphone/shell/WebMediaPermissionController.kt
- android-shell/app/src/main/java/app/floatphone/shell/MainActivity.kt
- components/settings/media-permission-settings.tsx
- components/phone-settings-app.tsx
- lib/media-permission.ts
- lib/stt-cloud.ts
- lib/minicpm-pcm.ts
- lib/openai-realtime.ts
- components/chat/use-hold-to-talk.ts
- docs/android-microphone-permission.md

## 验证边界和后续验收

本次仅静态阅读、TypeScript 无输出类型检查、界面适配静态检查和 Android XML 检查。不打开麦克风、不连接真实接口、不运行功能测试或模拟器。当前没有 JDK/Android SDK，Kotlin 未编译，未验证手机 ROM 行为，也没有发布新包。

这些修复目前只在源码里，必须编译并安装包含修复的 APK 后才有新入口；旧包的系统权限可按上方步骤手动调整。覆盖安装仍须同包名和同签名；不要因权限问题清除应用数据或卸载未备份的旧版。

后续验收可分别检查首次允许、一次拒绝、多次拒绝后转设置、设置里重新允许、全局麦克风关闭、授权期间松手、页面取消/重载、相机与麦克风部分允许、返回前台、Activity 重建，以及第三方 iframe 不能获得录音授权。以上步骤仅提供，本次未执行。

官方依据：[Android 运行时权限](https://developer.android.com/training/permissions/requesting)、[WebView 权限取消](https://developer.android.com/reference/android/webkit/WebChromeClient#onPermissionRequestCanceled(android.webkit.PermissionRequest))、[AudioManager](https://developer.android.com/reference/android/media/AudioManager)。
