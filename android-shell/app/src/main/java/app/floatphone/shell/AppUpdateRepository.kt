package app.floatphone.shell

import android.content.Context
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.AtomicFile
import com.android.apksig.ApkVerifier
import okhttp3.Call
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.MessageDigest
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/** The update feed is configured at build time; web pages cannot supply an APK or a feed URL. */
data class AppUpdateManifest(
    val versionCode: Long, val versionName: String, val apkUrl: String,
    val sha256: String, val forceUpdate: Boolean, val releaseNotes: String,
    val fallbackApkUrl: String? = null,
) {
    val identity: String get() = "$versionCode:$sha256:$apkUrl"
    fun json(): JSONObject = JSONObject().put("versionCode", versionCode).put("versionName", versionName)
        .put("apkUrl", apkUrl).put("sha256", sha256).put("forceUpdate", forceUpdate).put("releaseNotes", releaseNotes)
        .put("fallbackApkUrl", fallbackApkUrl)
    companion object {
        fun parse(json: JSONObject): AppUpdateManifest {
            val code = json.get("versionCode")
            require(code is Number && code.toString().matches(Regex("[1-9][0-9]{0,9}"))) { "versionCode 必须为正整数" }
            val value = code.toString().toLong()
            require(value <= Int.MAX_VALUE) { "versionCode 超出支持范围" }
            fun field(key: String, limit: Int): String {
                val raw = json.get(key)
                require(raw is String && raw.length <= limit) { "$key 格式无效" }
                return raw
            }
            val name = field("versionName", 80).trim()
            require(name.isNotEmpty()) { "版本名称为空" }
            val url = field("apkUrl", 8192).trim()
            requireHttps(url)
            val hash = field("sha256", 64).lowercase()
            require(hash.matches(Regex("[0-9a-f]{64}"))) { "SHA-256 格式无效" }
            val force = json.get("forceUpdate")
            require(force is Boolean) { "forceUpdate 必须为布尔值" }
            val fallback = if (json.isNull("fallbackApkUrl")) null else field("fallbackApkUrl", 8192).trim().also { requireHttps(it) }
            return AppUpdateManifest(value, name, url, hash, force, field("releaseNotes", 20000), fallback)
        }
        fun requireHttps(raw: String) {
            val url = raw.toHttpUrl()
            require(url.isHttps && url.username.isEmpty() && url.password.isEmpty() && url.fragment == null) {
                "更新地址必须为不含内嵌账号密码或片段的 HTTPS 地址"
            }
        }
    }
}

enum class AppUpdatePhase { IDLE, CHECKING, AVAILABLE, DOWNLOADING, VERIFYING, PAUSED, READY, ERROR }
data class AppUpdateState(
    val phase: AppUpdatePhase = AppUpdatePhase.IDLE, val manifest: AppUpdateManifest? = null,
    val downloaded: Long = 0, val total: Long = -1, val message: String = "",
    val downloadHost: String = "",
) {
    val required: Boolean get() = manifest?.forceUpdate == true && manifest.versionCode > BuildConfig.VERSION_CODE
}
private class UpdateCancelled : IOException()
private class RejectedUpdate(message: String) : IOException(message)
private class DownloadSourceUnavailable(message: String, cause: IOException? = null) : IOException(message, cause)

/** A single process-wide task, private resumable files and immutable UI snapshots. No user data is edited. */
class AppUpdateRepository private constructor(private val context: Context) {
    companion object {
        private const val PREFS = "app_ota_v1"
        private const val MAX_APK = 2L * 1024 * 1024 * 1024
        @Volatile private var instance: AppUpdateRepository? = null
        fun get(context: Context): AppUpdateRepository = instance ?: synchronized(this) {
            instance ?: AppUpdateRepository(context.applicationContext).also { instance = it }
        }
        fun isRequired(context: Context): Boolean = runCatching {
            val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("manifest", null)
            raw != null && AppUpdateManifest.parse(JSONObject(raw)).let { it.forceUpdate && it.versionCode > BuildConfig.VERSION_CODE }
        }.getOrDefault(false)
    }
    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    private val root = File(context.filesDir, "ota")
    // Outside the FileProvider's shared directory, including while incomplete.
    // Keep an .apk suffix for Android archive parsers that require it.
    private val part = File(root, "download.apk")
    private val candidate = AtomicFile(File(root, "download.json"))
    val verifiedApk = File(root, "verified/update.apk")
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor { task -> Thread(task, "app-ota") }
    private val busy = AtomicBoolean(false)
    private val listeners = CopyOnWriteArraySet<(AppUpdateState) -> Unit>()
    @Volatile private var cancelled = false
    @Volatile private var call: Call? = null
    @Volatile var state = AppUpdateState(manifest = readCached())
        private set
    // Use the existing OkHttp dependency and normal platform CA/hostname verification.
    // No HTTP initial URL or HTTPS -> HTTP redirect is accepted, including redirect chains.
    private val client = OkHttpClient.Builder().followRedirects(true).followSslRedirects(false)
        .connectTimeout(15, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS)
        .callTimeout(30, TimeUnit.MINUTES).build()

    private fun readCached(): AppUpdateManifest? = runCatching {
        prefs.getString("manifest", null)?.let { AppUpdateManifest.parse(JSONObject(it)) }
            ?.takeIf { it.versionCode > BuildConfig.VERSION_CODE }
    }.getOrNull()
    fun observe(listener: (AppUpdateState) -> Unit) { listeners.add(listener); listener(state) }
    fun removeObserver(listener: (AppUpdateState) -> Unit) { listeners.remove(listener) }
    private fun publish(next: AppUpdateState) {
        state = next
        handler.post { listeners.forEach { it(state) } }
    }
    private fun run(phase: AppUpdatePhase, onReady: (() -> Unit)? = null, job: () -> AppUpdateState) {
        if (!busy.compareAndSet(false, true)) return
        cancelled = false
        publish(state.copy(phase = phase, message = ""))
        executor.execute {
            val result = try { job() } catch (failure: Exception) {
                if (failure is RejectedUpdate) clearDownload()
                state.copy(phase = if (cancelled || failure is UpdateCancelled) AppUpdatePhase.PAUSED else AppUpdatePhase.ERROR,
                    downloaded = part.length(), message = if (cancelled || failure is UpdateCancelled) "下载已暂停，可继续下载"
                    else (failure.message ?: "更新失败，请重试").take(400))
            } finally { call = null }
            handler.post {
                // Complete on the main thread before allowing another UI action to start a task.
                val finalState = if (cancelled && result.phase == AppUpdatePhase.READY)
                    result.copy(phase = AppUpdatePhase.PAUSED, message = "下载已暂停，可继续下载") else result
                publish(finalState)
                busy.set(false)
                if (finalState.phase == AppUpdatePhase.READY && onReady != null && !cancelled) onReady()
            }
        }
    }
    fun checkAtStartup() { if (!busy.get()) check() }
    private fun readManifest(url: String, timeoutSeconds: Long): AppUpdateManifest {
        AppUpdateManifest.requireHttps(url)
        val request = Request.Builder().url(url).header("Cache-Control", "no-cache")
            .header("Accept", "application/json").build()
        return execute(request, timeoutSeconds).use { response ->
            if (!response.isSuccessful) throw IOException("检查更新失败（HTTP ${response.code}）")
            val body = response.body ?: throw IOException("更新信息为空")
            if (body.contentLength() > 65536) throw IOException("更新信息过大")
            val bytes = body.byteStream().use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(4096)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    if (output.size() + count > 65536) throw IOException("更新信息过大")
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            }
            AppUpdateManifest.parse(JSONObject(String(bytes, Charsets.UTF_8)))
        }
    }
    fun check() = run(AppUpdatePhase.CHECKING) {
        val mirror = BuildConfig.UPDATE_MIRROR_URL
        val minimum = state.manifest?.versionCode ?: 0
        val fromMirror = if (mirror.isBlank() || mirror == BuildConfig.UPDATE_MANIFEST_URL) null else try {
            readManifest(mirror, 8).takeIf { it.versionCode >= minimum }
        } catch (_: Exception) { null }
        val json = fromMirror ?: readManifest(BuildConfig.UPDATE_MANIFEST_URL, 25)
        if (json.versionCode < minimum) throw IOException("更新源暂未同步，请稍后重试")
        // Enforce a received mandatory policy in memory even if a full disk prevents persistence.
        if (json.forceUpdate && json.versionCode > BuildConfig.VERSION_CODE) publish(state.copy(manifest = json))
        if (!prefs.edit().putString("manifest", json.json().toString()).commit()) throw IOException("无法保存更新信息，请清理存储后重新检查")
        if (json.versionCode <= BuildConfig.VERSION_CODE) {
            clearDownload()
            AppUpdateState(message = "当前已是最新版本 ${BuildConfig.VERSION_NAME}")
        } else AppUpdateState(AppUpdatePhase.AVAILABLE, json, message = "发现新版本")
    }
    fun cancelDownload() {
        if (state.phase != AppUpdatePhase.DOWNLOADING && state.phase != AppUpdatePhase.VERIFYING) return
        cancelled = true; call?.cancel()
    }
    fun download(preferredUrl: String? = null) {
        val manifest = state.manifest ?: return
        if (manifest.versionCode <= BuildConfig.VERSION_CODE) return
        run(AppUpdatePhase.DOWNLOADING) {
            root.mkdirs(); verifiedApk.parentFile?.mkdirs()
            val saved = readCandidate()
            if (saved?.optString("identity") != manifest.identity) {
                clearDownload()
                writeCandidate(manifest, "", "", -1)
            }
            if (verifiedApk.isFile) {
                publish(state.copy(phase = AppUpdatePhase.VERIFYING))
                verify(manifest, verifiedApk)
            } else {
                downloadAndVerify(manifest, preferredUrl)
                ensureActive()
                if (!part.renameTo(verifiedApk)) throw IOException("无法保存已验证的安装包")
            }
            state.copy(phase = AppUpdatePhase.READY, downloaded = verifiedApk.length(), total = verifiedApk.length(), message = "校验通过，可以安装")
        }
    }
    fun verifyForInstall(onVerified: () -> Unit) {
        val manifest = state.manifest ?: return
        run(AppUpdatePhase.VERIFYING, onVerified) {
            verify(manifest, verifiedApk)
            ensureActive()
            state.copy(phase = AppUpdatePhase.READY, message = "校验通过，可以安装")
        }
    }
    fun notice(message: String) = publish(state.copy(message = message))
    fun awaitInstallPermission() { prefs.edit().putString("awaiting_install", state.manifest?.identity).commit() }
    fun takeInstallPermissionRequest(): Boolean {
        val identity = prefs.getString("awaiting_install", null) ?: return false
        prefs.edit().remove("awaiting_install").commit()
        return state.manifest?.identity == identity
    }
    private fun ensureActive() { if (cancelled) throw UpdateCancelled() }
    private fun execute(request: Request, timeoutSeconds: Long = 1800): Response {
        ensureActive(); AppUpdateManifest.requireHttps(request.url.toString())
        val current = client.newCall(request); call = current
        current.timeout().timeout(timeoutSeconds, TimeUnit.SECONDS)
        val response = current.execute()
        if (!response.request.url.isHttps || response.isRedirect) {
            response.close(); throw IOException("更新重定向无效，禁止降级到 HTTP")
        }
        return response
    }
    private fun readCandidate(): JSONObject? = runCatching {
        candidate.openRead().use { JSONObject(it.bufferedReader().readText()) }
    }.getOrNull()
    private fun writeCandidate(manifest: AppUpdateManifest, etag: String, modified: String, total: Long,
                               sourceUrl: String = manifest.apkUrl) {
        root.mkdirs()
        val output = candidate.startWrite()
        try {
            output.write(JSONObject().put("identity", manifest.identity).put("etag", etag)
                .put("modified", modified).put("total", total).put("sourceUrl", sourceUrl).toString().toByteArray(Charsets.UTF_8))
            candidate.finishWrite(output)
        } catch (failure: Exception) { candidate.failWrite(output); throw failure }
    }
    private fun clearDownload() {
        // Fixed private paths only: never touch the WebView, IndexedDB, media, backups or installed APK.
        part.delete(); verifiedApk.delete(); candidate.delete()
    }
    fun downloadSources(manifest: AppUpdateManifest): List<String> {
        val raw = manifest.apkUrl
        manifest.fallbackApkUrl?.let { return listOf(raw, it).distinct() }
        val prefix = "https://gh-proxy.com/"
        val direct = if (raw.startsWith(prefix)) raw.removePrefix(prefix) else raw
        val url = runCatching { direct.toHttpUrl() }.getOrNull() ?: return listOf(raw)
        val path = url.pathSegments
        if (!url.isHttps || url.host != "github.com" || url.port != 443
            || url.username.isNotEmpty() || url.password.isNotEmpty() || url.fragment != null || url.query != null
            || path.size < 6 || path[2] != "releases" || path[3] != "download") return listOf(raw)
        return listOf(prefix + direct, direct).distinct()
    }
    private fun downloadAndVerify(manifest: AppUpdateManifest, preferredUrl: String?) {
        val available = downloadSources(manifest)
        val sources = if (preferredUrl != null && preferredUrl in available) listOf(preferredUrl) else available
        // Resume the same source after a pause; never splice bytes or validators from two sources.
        val savedSource = readCandidate()?.optString("sourceUrl").orEmpty()
        val first = sources.indexOf(savedSource).coerceAtLeast(0)
        for (index in first..sources.lastIndex) {
            ensureActive()
            val source = sources[index]
            if (readCandidate()?.optString("sourceUrl") != source) {
                clearDownload()
                writeCandidate(manifest, "", "", -1, source)
            }
            publish(state.copy(downloadHost = source.toHttpUrl().host, downloaded = part.length(), total = -1))
            try {
                downloadFile(manifest, source)
                ensureActive()
                publish(state.copy(phase = AppUpdatePhase.VERIFYING, downloaded = part.length(), total = part.length()))
                verify(manifest, part)
                return
            } catch (failure: IOException) {
                ensureActive()
                // Storage errors and user cancellation must not trigger another network download.
                if (index == sources.lastIndex || (failure !is DownloadSourceUnavailable && failure !is RejectedUpdate)) throw failure
                clearDownload()
                publish(state.copy(phase = AppUpdatePhase.DOWNLOADING, downloaded = 0, total = -1,
                    message = "加速下载未成功，正在尝试备用下载地址"))
            }
        }
    }
    private fun downloadFile(manifest: AppUpdateManifest, sourceUrl: String) {
        var restarted = false
        while (true) {
            ensureActive()
            var offset = part.length()
            val metadata = readCandidate()
            val request = Request.Builder().url(sourceUrl).header("Accept-Encoding", "identity")
            if (offset > 0) {
                request.header("Range", "bytes=$offset-")
                val etag = metadata?.optString("etag").orEmpty()
                val modified = metadata?.optString("modified").orEmpty()
                if (etag.startsWith('"') && etag.endsWith('"')) request.header("If-Range", etag)
                else if (modified.isNotBlank()) request.header("If-Range", modified)
            }
            val received = try { execute(request.build()) }
                catch (failure: IOException) { throw DownloadSourceUnavailable("下载连接失败", failure) }
            received.use { response ->
                if (response.code == 416) {
                    val size = Regex("bytes \\*/([0-9]+)").matchEntire(response.header("Content-Range").orEmpty())
                        ?.groupValues?.get(1)?.toLongOrNull()
                    if (offset > 0 && size == offset && metadata?.optLong("total", -1) == offset) return
                    if (restarted) throw DownloadSourceUnavailable("服务器不接受断点，请重试")
                    part.delete(); writeCandidate(manifest, "", "", -1, sourceUrl); restarted = true
                    return@use
                }
                if (response.code != 200 && response.code != 206) throw DownloadSourceUnavailable("下载失败（HTTP ${response.code}）")
                val encoding = response.header("Content-Encoding")
                if (encoding != null && !encoding.equals("identity", true)) throw DownloadSourceUnavailable("下载服务器必须支持未压缩的 APK 响应")
                val body = response.body ?: throw DownloadSourceUnavailable("下载内容为空")
                var segmentEnd = -1L
                val total: Long
                if (response.code == 206) {
                    val range = Regex("bytes ([0-9]+)-([0-9]+)/([0-9]+)")
                        .matchEntire(response.header("Content-Range").orEmpty()) ?: throw DownloadSourceUnavailable("服务器断点响应格式无效")
                    val start = range.groupValues[1].toLongOrNull() ?: -1
                    segmentEnd = range.groupValues[2].toLongOrNull() ?: -1
                    total = range.groupValues[3].toLongOrNull() ?: -1
                    if (start != offset || segmentEnd < start || total <= segmentEnd || total > MAX_APK
                        || (body.contentLength() >= 0 && body.contentLength() != segmentEnd - start + 1)) {
                        throw DownloadSourceUnavailable("服务器返回了不匹配的断点范围")
                    }
                } else {
                    // A server ignoring Range (or an If-Range mismatch) means restart, never append a 200 body.
                    offset = 0; total = body.contentLength()
                    if (total > MAX_APK || total == 0L) throw DownloadSourceUnavailable("APK 大小无效")
                }
                if (total > 0 && root.usableSpace < total - offset + 16 * 1024 * 1024) throw IOException("存储空间不足，请清理后重试")
                writeCandidate(manifest, response.header("ETag").orEmpty(), response.header("Last-Modified").orEmpty(), total, sourceUrl)
                var downloaded = offset
                var lastProgress = 0L
                FileOutputStream(part, response.code == 206 && offset > 0).use { output ->
                    body.byteStream().use { input ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            ensureActive()
                            val count = try { input.read(buffer) }
                                catch (failure: IOException) { throw DownloadSourceUnavailable("下载中断", failure) }
                            if (count < 0) break
                            downloaded += count
                            if (downloaded > MAX_APK || (total > 0 && downloaded > total)
                                || (segmentEnd >= 0 && downloaded > segmentEnd + 1)) throw RejectedUpdate("下载内容超出声明大小")
                            output.write(buffer, 0, count)
                            val now = android.os.SystemClock.elapsedRealtime()
                            if (now - lastProgress >= 200) {
                                lastProgress = now
                                publish(state.copy(phase = AppUpdatePhase.DOWNLOADING, downloaded = downloaded, total = total))
                            }
                        }
                    }
                    output.fd.sync()
                }
                if (segmentEnd >= 0 && downloaded != segmentEnd + 1) throw DownloadSourceUnavailable("下载中断，可从断点继续")
                if (total >= 0 && downloaded < total && segmentEnd < 0) throw DownloadSourceUnavailable("下载不完整，可继续下载")
                if (total < 0 || downloaded == total) return
            }
        }
    }
    @Suppress("DEPRECATION")
    private fun verify(manifest: AppUpdateManifest, file: File) {
        if (!file.isFile || file.length() <= 0 || file.length() > MAX_APK) throw RejectedUpdate("安装包不存在或大小无效，请重新下载")
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                ensureActive()
                val count = input.read(buffer); if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        val expected = manifest.sha256.chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        if (!MessageDigest.isEqual(expected, digest.digest())) throw RejectedUpdate("SHA-256 校验失败，已拒绝并删除安装包")
        ensureActive()
        // PackageManager certificate extraction alone is not an APK integrity verification.
        // Google's verifier validates the actual signed APK contents before any installer is launched.
        val signature = try {
            ApkVerifier.Builder(file).setMinCheckedPlatformVersion(Build.VERSION.SDK_INT)
                .setMaxCheckedPlatformVersion(Build.VERSION.SDK_INT).build().verify()
        } catch (failure: Exception) { throw RejectedUpdate("无法验证 APK 数字签名，已拒绝安装") }
        catch (failure: LinkageError) { throw RejectedUpdate("当前设备无法安全验证 APK 数字签名，已拒绝安装") }
        if (!signature.isVerified) throw RejectedUpdate("APK 数字签名无效，已拒绝安装")
        val pm = context.packageManager
        val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val archive = pm.getPackageArchiveInfo(file.path, flags) ?: throw RejectedUpdate("无法解析安装包")
        val installed = pm.getPackageInfo(context.packageName, flags)
        if (archive.packageName != context.packageName) throw RejectedUpdate("安装包包名不一致，已拒绝安装")
        fun version(info: PackageInfo) = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else info.versionCode.toLong()
        if (version(archive) != manifest.versionCode || archive.versionName != manifest.versionName || version(archive) <= version(installed)) {
            throw RejectedUpdate("安装包版本与更新信息不一致，或不是更高版本")
        }
        if (archive.applicationInfo?.minSdkVersion?.let { it > Build.VERSION.SDK_INT } == true) throw RejectedUpdate("新版本不支持此 Android 系统")
        fun signers(info: PackageInfo): Set<String> {
            val values = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
            return values?.map { cert -> MessageDigest.getInstance("SHA-256").digest(cert.toByteArray()).joinToString("") { "%02x".format(it) } }?.toSet().orEmpty()
        }
        val current = signers(installed)
        val verified = signature.signerCertificates.map { cert ->
            MessageDigest.getInstance("SHA-256").digest(cert.encoded).joinToString("") { "%02x".format(it) }
        }.toSet()
        // Intentionally require identical current signer sets. Key rotation is not implicitly trusted.
        if (current.isEmpty() || signers(archive) != current || verified != current) throw RejectedUpdate("安装包签名与当前应用不一致，已拒绝安装")
        ensureActive()
    }
}
