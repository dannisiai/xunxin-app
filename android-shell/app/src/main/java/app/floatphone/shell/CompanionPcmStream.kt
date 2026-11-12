package app.floatphone.shell

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.os.SystemClock
import java.io.File
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit

/** A bounded PCM queue: network back-pressure never blocks the Android main thread. */
class CompanionPcmStream(
    private val sampleRate: Int,
    private val attributes: AudioAttributes,
    private val directory: File,
    private val onStarted: () -> Unit,
    private val onCompleted: (File) -> Unit,
    private val onFailed: () -> Unit,
) {
    private val queue = ArrayBlockingQueue<ByteArray>(32)
    @Volatile private var cancelled = false
    @Volatile private var inputFinished = false
    @Volatile private var track: AudioTrack? = null
    private var received = 0L
    private var worker: Thread? = null

    fun start() {
        worker = Thread({ consume() }, "companion-pcm").apply { isDaemon = true; start() }
    }

    /** 1 = accepted, 0 = queue full (retry later), -1 = stopped or invalid. */
    fun append(bytes: ByteArray): Int {
        if (cancelled || inputFinished || bytes.isEmpty() || bytes.size % 2 != 0
            || bytes.size > 36 * 1024 || received + bytes.size > sampleRate.toLong() * 2 * 180) return -1
        if (!queue.offer(bytes)) return 0
        received += bytes.size
        return 1
    }

    fun finish() { inputFinished = true }

    fun cancel() {
        cancelled = true
        queue.clear()
        runCatching { track?.pause() }
        worker?.interrupt()
    }

    private fun consume() {
        var file: File? = null
        var completed = false
        try {
            val minimum = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            require(minimum > 0)
            val next = AudioTrack.Builder().setAudioAttributes(attributes)
                .setAudioFormat(AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
                .setBufferSizeInBytes(maxOf(minimum * 2, sampleRate / 2))
                .setTransferMode(AudioTrack.MODE_STREAM).build()
            track = next
            require(next.state == AudioTrack.STATE_INITIALIZED)
            if (cancelled) return
            val ready = File.createTempFile("stream-", ".wav", directory)
            file = ready
            var written = 0
            var started = false
            RandomAccessFile(ready, "rw").use { cache ->
                cache.write(ByteArray(44))
                next.play()
                while (!cancelled) {
                    val bytes = queue.poll(100, TimeUnit.MILLISECONDS)
                    if (bytes == null) {
                        if (inputFinished && queue.isEmpty()) break
                        continue
                    }
                    var offset = 0
                    while (offset < bytes.size && !cancelled) {
                        val count = next.write(bytes, offset, bytes.size - offset, AudioTrack.WRITE_BLOCKING)
                        if (count <= 0) throw IllegalStateException("PCM playback failed")
                        offset += count
                        if (!started) { started = true; onStarted() }
                    }
                    if (cancelled) return
                    cache.write(bytes)
                    written += bytes.size
                }
                if (cancelled) return
                require(written > 0)
                // Drain the small hardware buffer so the final syllable is not cut off.
                val deadline = SystemClock.elapsedRealtime() + 5000
                while (!cancelled && (next.playbackHeadPosition.toLong() and 0xffffffffL) < written / 2L) {
                    if (SystemClock.elapsedRealtime() > deadline) throw IllegalStateException("PCM drain timed out")
                    Thread.sleep(20)
                }
                if (cancelled) return
                val header = ByteBuffer.allocate(44).order(ByteOrder.LITTLE_ENDIAN)
                    .put("RIFF".toByteArray(Charsets.US_ASCII)).putInt(36 + written)
                    .put("WAVEfmt ".toByteArray(Charsets.US_ASCII)).putInt(16)
                    .putShort(1.toShort()).putShort(1.toShort()).putInt(sampleRate).putInt(sampleRate * 2)
                    .putShort(2.toShort()).putShort(16.toShort())
                    .put("data".toByteArray(Charsets.US_ASCII)).putInt(written).array()
                cache.seek(0); cache.write(header)
            }
            if (!cancelled) { completed = true; onCompleted(ready) }
        } catch (_: Exception) {
            if (!cancelled) onFailed()
        } finally {
            runCatching { track?.release() }; track = null
            if (!completed) file?.delete()
        }
    }
}
