package app.floatphone.shell

import android.content.Context
import android.os.Environment
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.util.UUID

/** Fixed, device-wide files outside app-specific storage; no caller-supplied paths. */
class SharedPersonaArchive(private val context: Context) {
    private val limit = 32L * 1024 * 1024
    private var readToken = ""
    private var writeToken = ""
    private var observedHash = ""
    private var writeBaseHash = ""
    private val input get() = File(context.cacheDir, "shared-persona-read")
    private val output get() = File(context.cacheDir, "shared-persona-write")
    private fun directory() = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), "XunxinLocalArchive")
    private fun archive() = File(directory(), "shared-personas.json")
    private fun fingerprint(file: File): String {
        if (!file.exists()) return ""
        val hash = java.security.MessageDigest.getInstance("SHA-256")
        file.inputStream().use { stream -> val buffer = ByteArray(65536); var count = stream.read(buffer); while (count >= 0) { hash.update(buffer, 0, count); count = stream.read(buffer) } }
        return hash.digest().joinToString("") { "%02x".format(it.toInt() and 255) }
    }
    private fun valid(file: File): Boolean = runCatching {
        if (!file.isFile || file.length() > limit || file.length() == 0L) return false
        JSONObject(file.readText()).optString("format") == "xunxin-shared-personas"
    }.getOrDefault(false)
    @Synchronized fun reset() { readToken = ""; writeToken = ""; input.delete(); output.delete() }
    @Synchronized fun beginRead(): String {
        observedHash = fingerprint(archive())
        val candidates = listOf(archive(), File(directory(), "shared-personas.previous.json"))
        val source = candidates.firstOrNull { valid(it) }
        if (source == null) {
            if (candidates.any { it.exists() }) error("共用存档损坏，未覆盖原文件。")
            return JSONObject().put("exists", false).toString()
        }
        source.copyTo(input, overwrite = true); readToken = UUID.randomUUID().toString()
        return JSONObject().put("exists", true).put("token", readToken).put("size", input.length()).toString()
    }
    @Synchronized fun read(token: String, offset: Long): String {
        check(token == readToken && token.isNotEmpty() && offset >= 0 && offset <= input.length())
        val bytes = ByteArray(minOf(192 * 1024L, input.length() - offset).toInt())
        java.io.RandomAccessFile(input, "r").use { it.seek(offset); it.readFully(bytes) }
        return Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
    @Synchronized fun beginWrite(): String {
        check(fingerprint(archive()) == observedHash) { "共用文件已变化，请重新扫描。" }
        writeBaseHash = observedHash
        output.writeBytes(byteArrayOf()); writeToken = UUID.randomUUID().toString(); return writeToken
    }
    @Synchronized fun append(token: String, encoded: String) {
        check(token == writeToken && token.isNotEmpty() && encoded.length <= 300000)
        val bytes = Base64.decode(encoded, Base64.DEFAULT)
        check(output.length() + bytes.size <= limit) { "共用资料超过 32MB，原存档保留。" }
        output.appendBytes(bytes)
    }
    @Synchronized fun commit(token: String) {
        check(token == writeToken && valid(output))
        check(fingerprint(archive()) == writeBaseHash) { "共用文件已变化，未覆盖。" }
        val dir = directory(); check(dir.mkdirs() || dir.isDirectory)
        val target = archive(); val staging = File(dir, "shared-personas.pending.json")
        output.copyTo(staging, overwrite = true)
        java.io.RandomAccessFile(staging, "rw").use { it.fd.sync() }
        if (valid(target)) target.copyTo(File(dir, "shared-personas.previous.json"), overwrite = true)
        check(staging.renameTo(target)) { "存档提交失败，原存档保留。" }
        writeToken = ""; output.delete()
    }
}
