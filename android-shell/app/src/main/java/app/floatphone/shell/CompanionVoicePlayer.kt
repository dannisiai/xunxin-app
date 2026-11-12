package app.floatphone.shell

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.os.Handler
import android.os.Looper
import android.util.Base64
import java.io.File
import java.util.concurrent.Executors

/** Main-thread owner. Only decoding and private cache writes run on the worker. */
class CompanionVoicePlayer(
    private val context: Context,
    private val onChanged: () -> Unit,
    private val onError: (String) -> Unit,
    private val onPlaybackActive: (Boolean) -> Unit,
) {
    private val handler = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val audioManager = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val directory = File(context.cacheDir, "companion-voice").apply {
        mkdirs()
        listFiles()?.filter { it.isFile }?.forEach { it.delete() }
    }
    private var requestId: String? = null
    private var accepting = false
    private var encoded: StringBuilder? = null
    private var expectedLength = 0
    private var generation = 0
    private var closed = false
    private var cached: File? = null
    private var player: MediaPlayer? = null
    private var focus: AudioFocusRequest? = null
    private var loadingTimeout: Runnable? = null
    var state = "idle"
        private set
    val hasAudio get() = cached != null
    val hasReply get() = requestId != null

    fun expect(id: String) {
        clear()
        requestId = id
        accepting = true
        state = "loading"
        armTimeout(125_000L)
        onChanged()
    }

    fun clear() {
        stop()
        requestId = null
        cached?.delete(); cached = null
        state = "idle"
        onChanged()
    }

    fun begin(id: String, length: Int) {
        if (closed || !accepting || requestId != id) return
        if (length <= 0 || length > MAX_ENCODED || encoded != null) {
            fail(id, "回复音频过长或数据异常，请重试。")
            return
        }
        expectedLength = length
        encoded = StringBuilder(length)
    }

    fun append(id: String, chunk: String) {
        if (closed || !accepting || requestId != id) return
        val buffer = encoded ?: return
        if (chunk.length > CHUNK_SIZE || buffer.length + chunk.length > expectedLength) {
            fail(id, "音频传输异常，请重试。")
            return
        }
        buffer.append(chunk)
    }

    fun finish(id: String) {
        if (closed || !accepting || requestId != id) return
        val buffer = encoded
        if (buffer == null || buffer.length != expectedLength) {
            fail(id, "音频传输不完整，请重试。")
            return
        }
        val data = buffer.toString()
        encoded = null
        accepting = false
        val ticket = generation
        worker.execute {
            var file: File? = null
            try {
                val bytes = Base64.decode(data, Base64.NO_WRAP)
                require(bytes.isNotEmpty() && bytes.size <= MAX_BYTES)
                val ready = File.createTempFile("reply-", ".audio", directory)
                file = ready
                ready.writeBytes(bytes)
                handler.post {
                    if (closed || ticket != generation || requestId != id) ready.delete()
                    else {
                        cached?.delete(); cached = ready
                        play()
                    }
                }
            } catch (_: Exception) {
                file?.delete()
                handler.post {
                    if (!closed && ticket == generation) fail(id, "无法读取回复音频，请重试。")
                }
            }
        }
    }

    fun fail(id: String, message: String) {
        if (closed || requestId != id) return
        stop()
        state = "error"
        onChanged()
        onError(message)
    }

    fun play() {
        if (closed) return
        val file = cached ?: return
        stop()
        val ticket = generation
        state = "loading"
        armTimeout(15_000L)
        onChanged()
        try {
            val next = MediaPlayer()
            player = next
            next.setAudioAttributes(attributes)
            next.setDataSource(file.absolutePath)
            next.setOnPreparedListener {
                if (closed || ticket != generation || player !== next) return@setOnPreparedListener
                loadingTimeout?.let { handler.removeCallbacks(it) }; loadingTimeout = null
                try {
                    onPlaybackActive(true)
                    val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                        .setAudioAttributes(attributes).setWillPauseWhenDucked(true)
                        .setOnAudioFocusChangeListener({ change ->
                            if (change < 0 && player === next) stop()
                        }, handler).build()
                    focus = request
                    if (audioManager.requestAudioFocus(request) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                        fail(requestId.orEmpty(), "暂时无法播放语音，可稍后点重播。")
                    } else {
                        next.start()
                        state = "playing"
                        onChanged()
                    }
                } catch (_: Exception) {
                    fail(requestId.orEmpty(), "语音播放失败，可点重播。")
                }
            }
            next.setOnCompletionListener { if (player === next) stop() }
            next.setOnErrorListener { _, _, _ ->
                if (player === next) fail(requestId.orEmpty(), "音频格式不支持或播放失败，可点重试。")
                true
            }
            next.prepareAsync()
        } catch (_: Exception) {
            fail(requestId.orEmpty(), "无法播放回复音频，可点重试。")
        }
    }

    /** Keep a completed clip for replay; invalidate pending synthesis/decoding/preparation. */
    fun stop() {
        generation++
        loadingTimeout?.let { handler.removeCallbacks(it) }; loadingTimeout = null
        accepting = false
        encoded = null
        player?.let { runCatching { it.release() } }; player = null
        focus?.let { runCatching { audioManager.abandonAudioFocusRequest(it) } }; focus = null
        onPlaybackActive(false)
        state = if (cached != null) "ready" else "idle"
        onChanged()
    }

    private fun armTimeout(delay: Long) {
        loadingTimeout?.let { handler.removeCallbacks(it) }
        val ticket = generation
        val timeout = Runnable {
            if (!closed && ticket == generation) fail(requestId.orEmpty(), "语音准备超时，可点重试。")
        }
        loadingTimeout = timeout
        handler.postDelayed(timeout, delay)
    }

    fun close() {
        closed = true
        clear()
        worker.shutdownNow()
    }

    companion object {
        private const val MAX_BYTES = 4 * 1024 * 1024
        private const val MAX_ENCODED = ((MAX_BYTES + 2) / 3) * 4
        private const val CHUNK_SIZE = 48 * 1024
    }
}
