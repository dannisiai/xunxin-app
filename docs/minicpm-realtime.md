# MiniCPM-o 4.5 官方实时协议

实现依据 OpenBMB/MiniCPM-o-Demo 版本 47709a9210dfd71afa76c058e017fc8c4db5c8d2 的当前 Realtime API。不是改一个 OpenAI 模型 ID，也不使用旧版 prepare/audio_chunk 消息。

## 设置

- 语音服务商选择「自定义」，语音模式选择「实时语音」，实时协议选择 WebSocket，不再额外选择消息格式。在「接口地址（必填）」填写获准使用的 Gateway 地址，并填写 MiniCPM 实时模型名供自动识别；完整 /v1/realtime?mode=audio 地址也可直接识别。既有 MiniCPM 配置保留原选择兼容读取。HTTP(S) 转换为 WS(S)，不默认连接公共演示服务器。服务商下拉只保留 OpenAI TTS、自定义、MiniMax 国内和海外四个选项。
- 自定义的「实时语音」直接让 MiniCPM 持续处理语音。选择「TTS 语音合成」后，可在「TTS 接口格式」选择 OpenAI 兼容 REST 或 MiniCPM 官方网关；通话由聊天 API 生成回复，再合成语音，语音识别仍由原通话流程提供或回退文字输入。切换后下一次打开语音通话时生效。
- 自定义实时可选择 MiniCPM、Gemini Live、OpenAI Realtime，后两种接入详见 [实时语音与徽章](live-voice-and-badges.md)。OpenAI TTS、MiniMax 的实时选项不可选。MiniCPM 实时网关使用独立的 miniCPMGatewayUrl 字段，切换模式不覆盖原 REST 地址、密钥、模型、音色；TTS 接口格式单独保存，切回 TTS 会恢复对应格式。
- 原 MiniCPMRealtime 配置在读取、保存时迁移到 Custom，保留配置 ID、角色绑定、参考音色及录音开关，将旧 baseUrl 移到 miniCPMGatewayUrl，TTS 格式设为 minicpm。未指定模式时保留旧实时行为。其他已移除服务商的旧配置暂存并提示重新选择，不删除凭据或擅自改成不兼容协议。
- 模型由网关加载，不发送虚构的模型名/Voice ID，不查询 /models。官方协议未定义通用 API Key 字段；旧 REST 密钥不会发送。需要鉴权时，用户的网关须提供可直接连接的已授权 WS(S) 地址，本次没有实现任意 Bearer-header WebSocket 代理。
- 可选上传不超过 10 秒、8 MB 的参考音频。浏览器离线解码为 16 kHz 单声道 float32，随本机语音配置保存；连接和试听时发送给所填网关，未上传则使用网关默认音色。
- 将方案绑定给角色，打开单聊语音通话，点击开始/接听。只在排队和初始化完成后申请麦克风权限。
- 缩小、切后台、断线、到时和挂断均释放麦克风、播放节点与连接；恢复后明确点击重新连接，不自动在后台开麦。

## 协议和音频

- 实时通话连接 /v1/realtime?mode=audio，等待 session.queue_done 后发送 session.init，再等待 session.created。
- 持续发送 input.append.input.audio：16 kHz 单声道 float32 LE PCM 的 base64，通常每秒一包。
- response.output.delta 的 text 更新字幕、audio 按 24 kHz float32 PCM 立即排队播放、listen 代表回到倾听；音频模式不依赖逐轮 response.done。
- 关闭麦克风会停止输入设备，用静音包维持会话时间轴。手动或本端语音活动打断时清空本地播放，并在下一输入包发送 force_listen。语音活动采用能量阈值与回声消除，实际误触发、回声和打断效果需真机确认。
- 优先 AudioWorklet，旧 WebView 使用有界 ScriptProcessor 兼容路径；输入图不回放至扬声器。
- 单次会话上限 10 分钟，连接/排队上限 120 秒；上行积压与播放积压均有上限。

## 角色和记录

- 实时模型直接接收角色设定、绑定预设/世界书、最近聊天、本机核心与长期记忆。构建上下文不调用第二个 LLM、向量接口或远端音乐接口。
- 本模式不执行网页工具/动作，也不更新聊天 XML 状态栏；语音提示要求自然口语。
- 对方文字和通话接通/结束写入原聊天。官方音频模式没有用户逐字转写；本端发言明确标注未转写，不能据此恢复用户说过的事实。
- 可选保存检测到的本端发言为 WAV 文件，默认关闭，单段约 30 秒上限，不持续保存静音。没有调用额外付费 ASR 伪造转写。参考音色和可选录音会增加备份体积。

## TTS 与范围

- 普通语音条、试听、原视频通话中的朗读使用 mode=chat，发送 tts.enabled=true、use_tts_template=true，参考数据放入 tts.ref_audio_data；接收 PCM 并封装 24 kHz WAV。
- 由多模态模型按提示朗读，不能保证与专用确定性 TTS 完全一致或逐字无误。只收到文本而没有音频会报错。
- 合成超时 120 秒，音频总长上限 180 秒。停止试听、改配置、卸载和视频通话关闭会取消新的 MiniCPM 合成连接。
- 连续收音与分段播放接入单聊语音通话；视频通话仍使用原识别—回复—TTS，没有接入连续摄像头的 video 全双工模式，群聊也没有接入多人实时协议。

## 验证边界

当前本地改动只进行静态语法/类型、Worklet、调用链和镜像一致性检查；前端开发预览按用户要求保持运行。本次未打包、上传或发布，不连接真实模型网关，不录音、试听或运行模拟器/真机测试。静态检查通过不代表网关可访问、设备兼容、低延迟和打断效果已经实测。

官方：[协议总览](https://github.com/OpenBMB/MiniCPM-o-Demo/blob/47709a9210dfd71afa76c058e017fc8c4db5c8d2/docs-app/content/docs/en/realtime-api/overview.md)、[Audio](https://github.com/OpenBMB/MiniCPM-o-Demo/blob/47709a9210dfd71afa76c058e017fc8c4db5c8d2/docs-app/content/docs/en/realtime-api/audio.md)、[Chat/TTS](https://github.com/OpenBMB/MiniCPM-o-Demo/blob/47709a9210dfd71afa76c058e017fc8c4db5c8d2/docs-app/content/docs/en/realtime-api/chat.md)。
