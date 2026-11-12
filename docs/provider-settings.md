# API 服务商选项和自定义语音

## 对话 API

- 服务商下拉列表移除 Together AI 和 SiliconFlow。
- 读取或保存旧配置时，将这两类配置转换为 Custom，保留 ID、名称、密钥、模型、能力开关和绑定关系。原地址为空时补上该配置原本使用的官方根地址；用户自填地址优先。
- 迁移时单独保留旧配置隐含的向量模型回退值，防止角色记忆检索因删除服务商选项而改变。显式填写的向量模型仍优先；主动切换服务商会清除这个迁移回退值。
- 类型检查不会读取本机真实密钥或执行 API 请求。

## 语音 API 的自定义

选择「自定义（OpenAI 兼容）」后，手动填写 API 根地址、TTS 模型和音色 ID。可填写根地址（例如 https://voice.example/v1），也可填写完整 /audio/speech 地址；识别与合成会使用同一根地址和查询参数，避免重复追加端点。只接受 http/https，空地址不会默认发往 OpenAI。

- TTS 使用 POST /audio/speech，JSON 字段为 model、input、voice、response_format，要求返回音频文件；JSON、文本错误页和空响应会报错。返回的音频 MIME 类型会保留。
- 非 iOS 通话的按住说话可使用同一配置的 POST /audio/transcriptions：multipart 文件和识别模型。需服务商实现此接口并启用 STT；模型留空沿用 whisper-1。
- 密钥按服务商要求填写，留空时不发送 Authorization。OpenAI 官方配置仍要求密钥。
- 保存和重新打开设置时，自定义配置会保留。可自动拉取模型及用户指定的音色目录，也可手填 ID；不展示不适用的 Minimax 克隆或 OpenAI 固定音色按钮。自动拉取和原生新增服务商详见 [语音自动拉取](voice-auto-fetch.md)。
- 从 OpenAI 切换为自定义时保留地址、模型和音色；从 Minimax 切换时清空这些不兼容字段，等待用户填写。已有密钥不会自动删除。

这里的「自定义」明确指 OpenAI 兼容的语音合成/识别接口。Minimax 私有格式、JSON 中返回音频 URL/base64、自定义请求模板和任意第三方私有协议不在此次接入范围。

验证方式为语法、类型、配置迁移逻辑和调用链静态检查；不进行网络接口测试、试听、录音、真机或模拟器测试。APK 构建结果另见发布记录。

参考：[Speech 接口](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)、[Transcriptions 接口](https://developers.openai.com/api/reference/resources/audio/subresources/transcriptions/methods/create)。
