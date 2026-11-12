# 语音电话无法接通：静态排查记录

本次未调用用户 API、录音、试听或执行通话测试；没有手机上的实际配置和返回错误，不能断言唯一根因。以下为已经从源码确认的事实。

## 已确认并修复

- 普通通话的 TTS 异常原先只写控制台，手机端看不见具体失败原因。现在在通话页显示脱敏后的错误，服务返回空音频也会明确提示；关闭通话、缩小或主动取消造成的中止不误报为接口失败。
- 未绑定角色语音方案、关闭语音输出，以及 Android 没有可用云端识别配置时，原先会静默回退。现在显示配置提示，原有文字通话仍可继续。
- 申请实时凭据的请求失败或返回 HTML 时，原先容易只显示英文 fetch/JSON 错误。现在区分应用语音后端不可达、后端缺少实时路由、上游凭据错误。
- OpenAI SDP 协商失败原先只显示 HTTP 状态，丢失上游 JSON 错误；现在保留错误原因并遮蔽长期密钥和短期凭据。
- Gemini/MiniCPM 断开连接时原先隐藏服务端关闭原因；现在在服务提供原因时显示关闭码和脱敏原因。仅有浏览器通用网络错误时，仍不能从客户端得知上游拒绝连接的完整原因。

## 已核对但未改动的协议事实

当前默认 gpt-realtime-2.1、gpt-realtime-whisper、gemini-3.8-live 在当前官方文档有对应说明，不能仅凭名称判断它们不存在。官方 Gemini 短期凭据目前使用 v1beta，未改成早期 v1alpha。

OpenAI 实时需要 /realtime/client_secrets 和 /realtime/calls；能拉取 /models、能文字聊天或能 TTS，都不能证明该中转实现了实时握手。Gemini Live 需要 auth_tokens 和 Live WebSocket；MiniCPM 需要相应网关消息协议。当前普通 TTS、WebSocket 和 WebRTC 使用的地址与密钥分开保存，切换后应核对所选模式的配置。

新添加的自动拉取模型目前会返回一般模型列表，没有可靠的通话能力验证；选到纯文本、嵌入、单独合成模型时，不能自动变成实时通话模型。服务商返回的错误应作为判断依据，不对任意网关模型别名做未经确认的强制替换。

MiniMax/OpenAI TTS 本身只负责把文字读出来。普通通话的输入依赖浏览器识别或 OpenAI 兼容转写；Android 没有可用识别配置时会使用文字输入。要连续语音对话，需要把自定义实时语音方案绑定到当前角色。

## 日志范围与剩余未知项

电脑预览的旧 stderr 日志记录过 Node 堆内存不足退出，原记录进程 PID 1940 已不存在。这是本地开发预览的证据，不能据此推定手机 APK 的本地 Node 服务也发生同一错误。

本机代码无法直接读取手机上的绑定、密钥、实际网关响应或系统麦克风授权。本次没有验证账号额度、区域限制、网关实时能力、UDP/WebRTC 可达性或设备兼容性。改动目前仅在本地源码，旧安装包不会自动获得新的错误提示。

新版本出现错误后，可记录通话页完整提示；不要提供 API Key。401/403 应查看密钥及访问权限，404 应核对模型与实时路由，429 应核对额度/限流，后端不可达应查看应用服务和安装包版本。网络失败仍需结合设备端实际信息判断。

官方依据：[OpenAI Realtime WebRTC](https://developers.openai.com/api/docs/guides/voice-webrtc)、[OpenAI Client Secrets](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create)、[Gemini 短期凭据](https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens)。
