# 语音 API 自动拉取

## 界面和支持范围

语音设置新增统一「自动拉取模型 / 音色」和「停止拉取」。拉取后可下拉选择，所有模型/音色仍可手填；当前选择不会被拉取结果自动替换。

| 类型 | 联网读取 | 合成路径 |
| --- | --- | --- |
| OpenAI | GET /models；内置音色使用预置列表，不冒充联网获取 | 原有 /audio/speech |
| 自定义（TTS 模式、OpenAI 兼容格式） | 默认 /models，允许自定义模型列表 URL；音色只在用户填写音色列表 URL 后查询 | 原有 /audio/speech |
| MiniMax 国内/海外 | POST /get_voice，voice_type=all，合并系统、克隆、生成音色 | 原有 /t2a_v2 |
| 自定义（MiniCPM 实时 / TTS） | 官方网关没有通用目录查询，不显示自动拉取 | 官方实时 WebSocket 协议 |
| 自定义（Gemini Live / OpenAI Realtime） | 实时模型/音色手填，实时界面不误用 TTS 目录 | Gemini WebSocket / OpenAI WebRTC |

服务商下拉只保留 OpenAI TTS、自定义、MiniMax 国内版和海外版。ElevenLabs、Google Cloud TTS、Azure Speech 和独立 MiniCPM 服务商已从选择界面移除；旧 MiniCPM 配置迁移到自定义，其他旧配置暂存供用户重新选择或删除。保留历史协议代码用于旧配置兼容，不提供新建入口。模型列表不证明所有模型都适用于当前合成端点。
不再自动预置 Minimax 或其他语音方案，新增方案先选择服务商。旧的未配置、未修改 Minimax 自动示例会移除；用户已配置的方案保留。Gemini Live / OpenAI Realtime 的独立凭据、通话生命周期和静态验证范围见 [实时语音与徽章](live-voice-and-badges.md)。

## 数据和取消

MiniCPM-o 4.5 的官方实时协议放在自定义服务商下，不伪造模型/音色目录查询；自定义 TTS 模式可选择 OpenAI 兼容或 MiniCPM 格式。实时网关地址和 REST 地址分别保存。参考音色和实时通话接入详见 [MiniCPM 实时协议](minicpm-realtime.md)。

- 结果按配置 ID 缓存并保存，重新打开设置仍能选择。失败或空结果保留旧列表与用户当前模型、音色；部分成功只更新成功且非空的一类。
- 服务商、地址、密钥、鉴权、项目或目录 URL 变化会取消旧请求并清理旧目录缓存；请求结果还核对配置指纹，旧请求不能覆盖新配置。
- 配置编辑改用当前引用更新，避免异步拉取把用户同时修改的名称或其他字段恢复成旧值。
- 列表查询只在点击按钮后进行，打开设置不自动调用；没有为验证功能调用实际服务商密钥。
- 客户端上限 30 秒，服务端整体上限 25 秒；支持主动停止、配置删除与组件卸载取消。ElevenLabs 最多 10 页 / 1000 个音色，其他目录最多保留 1000 项。
- 服务端对目录响应、音频和文本输入设大小上限，不跟随重定向；错误展示隐藏当前密钥。自定义 URL 仅接受 HTTP(S)，不接受内嵌账号密码。
- 保留未知/新版本导入的语音配置，不再因为当前选项列表未识别就删除整项配置。

## 自定义目录响应

支持直接数组、models/voices 数组、data 数组及 data.models/data.voices。模型 ID 识别 id/model_id/model，音色 ID 识别 voice_id/ShortName/uri/id/name。不是通用 JSON 请求模板；其他鉴权、POST 专用列表或复杂嵌套格式需要单独适配。MiniMax 的三类数组按专用协议解析。

Together AI、SiliconFlow 仍不出现在对话 API 服务商选项中，本次没有恢复这两个选项。

## 验证

本次只执行静态语法/类型、调用链和镜像一致性检查；用户要求的本地开发预览保持运行。未进行功能测试、接口试调、试听、录音、模拟器或真机验证，未打包发布。不能将静态检查通过描述为服务商已真实验证成功。

参考：[OpenAI Models](https://developers.openai.com/api/reference/resources/models/methods/list)、[MiniMax 音色](https://platform.minimax.io/docs/api-reference/voice-management-get)、[ElevenLabs 模型](https://elevenlabs.io/docs/api-reference/models/list)、[ElevenLabs 音色](https://elevenlabs.io/docs/api-reference/voices/search)、[Google 音色](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/voices/list)、[Google 合成](https://docs.cloud.google.com/text-to-speech/docs/reference/rest/v1/text/synthesize)、[Google 鉴权](https://docs.cloud.google.com/text-to-speech/docs/authentication)、[Azure REST](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech)。
