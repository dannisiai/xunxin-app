# Gemini Live / OpenAI Realtime、悬浮点与相爱徽章

## 配置入口

语音 API 服务商仍只有 OpenAI TTS、自定义、MiniMax 国内版、MiniMax 海外版。

不再自动创建任何语音方案。新增方案不预选服务商、不预填地址/模型/音色。
旧版本自动创建且未修改、未配置密钥的 default-minimax-tts 示例会移除；用户已填写密钥、更名或修改配置的方案保留。

在自定义下选择实时语音，主协议下拉只有 WebSocket、WebRTC 两项。
不再显示「消息格式」下拉。WebSocket 统一填写地址、模型等参数，并自动匹配 Gemini Live 或 MiniCPM；WebRTC 使用 OpenAI Realtime。
切到 WebRTC 后仍保留 WebSocket 配置，切回时恢复。WebSocket 新编辑值保存在 webSocketRealtime，旧的 Gemini/MiniCPM 独立配置保留，并按原选择兼容读取。
地址字段统一显示「接口地址（必填）」。Gemini/OpenAI 默认显示官方地址，用户可以编辑并自动保存各自配置；客户端连接配置与后端凭据请求都使用保存的地址。清空后在失焦时恢复官方地址，运行时也会对空白地址回退官方地址。切换配置或协议时读取对应的已保存地址，旧自定义地址继续生效。MiniCPM 需要填写自己的网关。
三个协议分别保存网关、密钥、模型与音色，切换协议不把一个服务的密钥发送到另一个服务。
WebSocket 的自动识别只分析本机配置，不查询模型、不发送探测请求：gemini/MiniCPM 模型名、Google 官方主机、明确的 Live WebSocket 路径或 MiniCPM mode=audio/chat 地址用作识别依据；既有自定义配置仍沿用原来的明确选择。无法识别或地址/模型相互冲突时显示提示，开始通话前拦截，不尝试多个协议。不能据此宣称支持所有任意自定义 WebSocket JSON 协议。
Gemini 允许填写 HTTP(S) 根地址或不含鉴权查询参数的 WS(S) Live 地址；服务端规范化后申请短期凭据，并连接同一主机派生的受限 WebSocket。MiniCPM 的模型由网关加载，设置中的 MiniCPM 模型名用于自动匹配，不发送虚构模型参数。
语音模式切换使用按钮式单选组，移除隐藏的原生 radio 与 fieldset 外观，避免多余竖线；保留方向键、Home/End 和键盘焦点支持。
MiniCPM 继续使用原官方网关与参考音色。原有 REST TTS 地址和密钥独立保留。
实时语音选择对下一次打开的单聊语音通话生效。

## OpenAI Realtime

- 使用 GA /v1/realtime/client_secrets 申请短期凭据，再由浏览器向 /v1/realtime/calls 发送 SDP 建立 WebRTC。
- 长期密钥由用户填写在本机配置中，只提交给本机/自托管后端用于换取凭据；媒体连接使用短期凭据。短期凭据不写入本机配置或聊天。
- 音频由 WebRTC 传输；oai-events DataChannel 接收会话、VAD、音频字幕、输入转写及响应完成事件。
- 使用 server_vad，自动发起回复与打断。手动打断发送 response.cancel 和 output_audio_buffer.clear，服务端清空未播音频。
- 关闭麦克风时停止真实输入设备，发送合成静音轨让 VAD 能结束当前轮；重新打开会重新请求输入设备并 replaceTrack。
- 默认示例为 gpt-realtime-2.1 / marin，输入转写模型 gpt-realtime-whisper，可手动修改；是否可用取决于实际账号或网关。
- OpenAI Realtime 默认使用 https://api.openai.com/v1，也可填写支持短期凭据、WebRTC 协商及浏览器跨域的兼容 API 根地址；媒体连接沿用同一地址派生。普通 TTS 的自定义地址设置独立保留。

## Gemini Live

- 使用 Gemini Developer API v1beta/auth_tokens 申请一次性短期凭据，再通过 BidiGenerateContentConstrained WebSocket 连接；短期凭据使用 access_token 参数。
- 接口地址默认 https://generativelanguage.googleapis.com，可修改为实现相应短期凭据和 Live WebSocket 接口的兼容地址；清空时恢复官方地址。
- setup 指定实时模型、AUDIO 输出、角色上下文、预置音色、输入/输出转写。不是 Vertex AI 或 OpenAI 兼容协议。
- 发送 16 kHz 单声道 little-endian PCM16，播放 24 kHz PCM16；优先 AudioWorklet，旧 WebView 使用既有有界兼容处理器。
- 使用显式 activityStart/activityEnd：本端能量检测两帧达到阈值后发送发言开始，保留最多 300 ms 前导音频，静音约 700 ms 结束发言。语音包约 100 ms。
- activityHandling 为 START_OF_ACTIVITY_INTERRUPTS。手动打断发 activityStart 并停止本地待播音频，等待用户继续；关闭麦克风结束当前活动并停止采集。
- 能量检测与回声消除的设备效果未做真机验证；不能据静态审查断言没有误触发。
- 默认模型示例为 gemini-3.8-live / Aoede，可填写账号实际可用模型或网关模型。原生音频模型的文字使用 outputTranscription，不把思考内容当作字幕。

## 生命周期与聊天记录

两种新协议均只在用户点击开始或接听后联网、开麦，不通过试听按钮偷偷开启实时连接。
连接上限 10 分钟、初始化上限 60 秒、后端凭据请求上限 25 秒；不自动重连，不在后台持续录音。
缩小、切后台、挂断、连接失败和卸载会取消请求、关闭连接与音频上下文，并释放输入设备。
输出音量跟随原通话音量滑块，关闭语音输出时仍可保留文字转写。
字幕分用户/角色保存到原聊天，按消息 ID 更新草稿与最终转写，结束时保存已收到的部分内容；不伪造没有收到的用户台词。
转写可能有识别误差，已生成的文本也不严格等于用户实际听到的音频。
两种新协议不保存原始录音，不执行网页工具/动作；当前范围是单聊音频，视频与群聊沿用原流程。
Gemini/OpenAI 实时模式下的普通语音条仍读取原 TTS 配置，实时音色通过通话入口使用；MiniCPM 实时模式保留原网关合成试听。
只有明确识别为 MiniCPM 的实时 WebSocket 配置才会用于该实时网关的朗读；Gemini 实时地址不会覆盖已有独立 MiniCPM TTS 地址。

## 悬浮提示与相爱徽章

- Android 原生悬浮窗把静态省略号替换成三个直径 7 dp 的圆点，1.1 秒一轮，间隔错峰 0.16 周期，上下位移最高 6 dp。
- 仅思考/看屏幕占位时显示圆点；回复到达切回文字，隐藏、销毁或不可见时停止动画。遵守系统关闭动画的设置。
- 网页伴侣思考点同步调整为 8 px，保持逐点跳动与减少动态效果设置。
- 聊天列表爱心由 88×38 缩小为 64×30（均随文字缩放），参考游戏亲密徽章的粉色宝石/羽翼意象，采用项目内原创 SVG。
- 第 1～29 天为浅粉爱心，第 30～90 天为玫瑰色，第 91 天起增加双翼；双翼宽度包含装饰，中心爱心保持小尺寸。
- 继续按角色创建日期计算，第 1 天规则不变；使用本地日历跨日、页面恢复/聚焦时更新，数字不需要手动维护。90 天阈值为本项目规则，不是游戏内的亲密度规则。

## 验证与未验证项

角色档案库的自适应宿主是普通块级容器，原 char-app 只有 flex:1 而没有明确高度，导致画布和绝对定位 NPC 弹窗只占顶部一小段。已补齐 char-app 的 100% 高宽及直接页面的 flex/min-height 约束，档案滚动区允许收缩，NPC 弹窗内容在完整应用高度内滚动。仅调整布局，不改角色、世界或生成逻辑。

只做 TypeScript 无输出编译、CSS/JS 语法、调用链、Kotlin 静态审查和主源码/Android 镜像一致性检查。
前端预览按用户此前要求保持运行；未进行语音接口试调、录音、试听、自动化功能测试、模拟器或真机验证，未打包、上传或发布 APK。
因此不能保证账号模型权限、网关跨域/WebRTC/UDP 可达性、设备回声与延迟已经实际验证。Android 原生动画需要包含这些改动的 APK 才能看到。

## 官方依据与视觉参考

- OpenAI WebRTC：https://developers.openai.com/api/docs/guides/voice-webrtc
- OpenAI Realtime 会话：https://developers.openai.com/api/docs/guides/realtime-conversations
- OpenAI Client Secrets：https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets
- Gemini Live WebSocket：https://ai.google.dev/api/live?hl=zh-CN
- Gemini 短期凭据：https://ai.google.dev/gemini-api/docs/live-api/ephemeral-tokens?hl=zh-CN
- 亲密关系图标视觉参考：https://www.keaitupian.cn/aiqing/22457_3.html
