package app.floatphone.shell

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.media.projection.MediaProjectionConfig
import android.media.projection.MediaProjectionManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import android.widget.FrameLayout
import android.widget.TextView
import android.view.Gravity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.repeatOnLifecycle
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker
import kotlinx.coroutines.launch
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.retryWhen
import org.json.JSONObject
import java.lang.ref.WeakReference

/**
 * Float 小手机安卓壳：全屏 WebView 直接加载线上站点。
 * 网页每次部署即时生效，本壳只负责原生能力（推送长连接、文件上下行、外链）。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        val SITE_URL: String = BuildConfig.SITE_URL
        val VERSION: String = BuildConfig.VERSION_NAME
        var companionHost: WeakReference<MainActivity> = WeakReference(null)
        @Volatile var currentFoldInfo: JSONObject? = null
        @Volatile var currentOverlayFold: OverlayFoldSnapshot? = null
        /** 来电接听等场景的站内深链（必须以 SITE_URL 开头，否则忽略） */
        const val EXTRA_OPEN_URL = "open_url"
        const val EXTRA_ACCOUNT_ID = "account_id"
        const val EXTRA_RETURN_TO_DESKTOP = "return_to_desktop"
    }

    private var latestWindowLayout: OverlayFoldObservation? = null
    private lateinit var webView: WebView
    private lateinit var webViewWindow: WebViewWindowController
    private lateinit var displayRefresh: DisplayRefreshRateController
    private lateinit var mediaPermissions: WebMediaPermissionController
    private lateinit var appUpdates: AppUpdateController
    private var updateBlocked = false
    private var businessUrl: String? = null
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var pendingCompanion: Bundle? = null
    private var pendingDocumentExport: String? = null
    private var pendingDesktopReturn = false
    private val sharedArchive by lazy { SharedPersonaArchive(this) }
    private fun archiveAccess(accountId: String): Boolean {
        val result = java.util.concurrent.atomic.AtomicBoolean(false)
        val ready = java.util.concurrent.CountDownLatch(1)
        runOnUiThread { result.set(isTrustedPage() && accountId.isNotEmpty() && PushService.accountScope == accountId); ready.countDown() }
        return ready.await(3, java.util.concurrent.TimeUnit.SECONDS) && result.get()
    }
    private fun archiveGranted(): Boolean = if (Build.VERSION.SDK_INT >= 30) Environment.isExternalStorageManager()
        else ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    private fun archiveResult(accountId: String, action: () -> Any): String = runCatching {
        check(archiveAccess(accountId) && archiveGranted()) { "请授权本机存档访问，或重新登录。" }
        JSONObject().put("ok", true).put("value", action()).toString()
    }.getOrElse { JSONObject().put("ok", false).put("error", it.message ?: "本机存档操作失败").toString() }

    private val documentExportLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val base64 = pendingDocumentExport ?: return@registerForActivityResult
        pendingDocumentExport = null
        val target = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || target == null) return@registerForActivityResult
        val resolver = applicationContext.contentResolver
        Thread {
            val saved = runCatching {
                val bytes = android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
                val output = resolver.openOutputStream(target) ?: error("无法写入文件")
                output.use { it.write(bytes) }
            }.isSuccess
            runOnUiThread { Toast.makeText(this, if (saved) "文档已保存" else "文档保存失败，请重试", Toast.LENGTH_LONG).show() }
        }.start()
    }

    private val overlayPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) {
        if (pendingCompanion != null && Settings.canDrawOverlays(this)) requestCompanionCaptureConsent()
        else {
            pendingCompanion = null
            Toast.makeText(this, "未开启悬浮窗权限，无法显示 AI 伴侣", Toast.LENGTH_LONG).show()
        }
    }

    private val companionCaptureLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val config = pendingCompanion ?: return@registerForActivityResult
        pendingCompanion = null
        val data = result.data
        if (result.resultCode != Activity.RESULT_OK || data == null) {
            Toast.makeText(this, "未允许屏幕共享，点击应用可以重新开启陪伴", Toast.LENGTH_LONG).show()
            return@registerForActivityResult
        }
        runCatching {
            ContextCompat.startForegroundService(this, Intent(this, CompanionOverlayService::class.java)
                .putExtras(config).putExtra("projectionData", data))
        }.onFailure { Toast.makeText(this, "无法启动 AI 伴侣，请重新打开后重试", Toast.LENGTH_LONG).show() }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        callback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data))
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) PushService.start(this)
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        companionHost = WeakReference(this)
        pendingCompanion = savedInstanceState?.getBundle("pendingCompanion")
        pendingDesktopReturn = intent?.getBooleanExtra(EXTRA_RETURN_TO_DESKTOP, false) == true
        intent?.removeExtra(EXTRA_RETURN_TO_DESKTOP)
        // 音量键默认调媒体流：WebView 里的语音条/TTS 都走媒体流播放，
        // 不设的话短音频没在播时按键调的是铃声，用户感觉"音量键无效、声音巨大"
        volumeControlStream = AudioManager.STREAM_MUSIC

        webView = WebView(this)
        val loading = TextView(this).apply {
            text = "寻信正在启动…\n首次打开需要准备应用文件，请稍候。"
            gravity = Gravity.CENTER
            textSize = 16f
            setTextColor(android.graphics.Color.rgb(133, 104, 94))
        }
        val container = FrameLayout(this).apply {
            addView(webView, FrameLayout.LayoutParams(-1, -1))
            if (BuildConfig.LOCAL_BUNDLE) addView(loading, FrameLayout.LayoutParams(-1, -1))
        }
        setContentView(container)
        webViewWindow = WebViewWindowController(this, container, webView) { isTrustedPage() }
        webViewWindow.install()
        displayRefresh = DisplayRefreshRateController(this, webView) { isTrustedPage() }
        webView.addOnLayoutChangeListener { _, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom ->
            if (left != oldLeft || top != oldTop || right != oldRight || bottom != oldBottom) {
                webViewWindow.viewportChanged()
                displayRefresh.refresh()
                latestWindowLayout?.let { updateFoldState(it) }
            }
        }

        webView.settings.apply {
            useWideViewPort = true
            loadWithOverviewMode = false
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            userAgentString = "$userAgentString FloatShell/$VERSION"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.addJavascriptInterface(ShellBridge(), "AndroidShell")
        mediaPermissions = WebMediaPermissionController(this, { origin ->
            val site = Uri.parse(SITE_URL)
            isTrustedPage() && origin.scheme == site.scheme && origin.host == site.host && origin.port == site.port
        }) { dispatchCompanionEvent("android-media-permissions-changed", JSONObject()) }

        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
                mediaPermissions.cancelWebRequest()
                super.onPageStarted(view, url, favicon)
            }
            override fun onPageFinished(view: WebView, url: String?) {
                super.onPageFinished(view, url)
                val current = runCatching { Uri.parse(url) }.getOrNull()
                val site = Uri.parse(SITE_URL)
                if (current?.scheme == site.scheme && current?.host == site.host && current?.port == site.port) {
                    view.evaluateJavascript("document.documentElement.dataset.androidShell='1'", null)
                    webViewWindow.viewportChanged(force = true)
                    displayRefresh.refresh(force = true)
                    dispatchDesktopReturn()
                    currentFoldInfo?.let { fold ->
                        view.evaluateJavascript("window.__updateDeviceFoldInfo && window.__updateDeviceFoldInfo($fold)", null)
                    }
                }
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme ?: return false
                if (scheme == "floatshell" && url.host == "companion") {
                    if (request.isForMainFrame && request.hasGesture() && isTrustedPage()) {
                        requestCompanion(url)
                    }
                    return true
                }
                // 站内导航留在壳里；http(s) 外链和自定义协议（shortcuts:// 等）交给系统
                if (scheme == "http" || scheme == "https") {
                    if (url.host == Uri.parse(SITE_URL).host) return false
                    return runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, url)); true
                    }.getOrDefault(true)
                }
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                }.getOrDefault(true)
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                mediaPermissions.requestWeb(request)
            }

            override fun onPermissionRequestCanceled(request: android.webkit.PermissionRequest) {
                mediaPermissions.onWebRequestCanceled(request)
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(emptyArray())
                filePathCallback = callback
                return runCatching {
                    fileChooserLauncher.launch(params.createIntent()); true
                }.getOrElse {
                    filePathCallback = null; false
                }
            }
        }

        // 备份导出等下载：交给系统下载管理器，落到公共下载目录
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            runCatching {
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    // blob/data 由页面内 JS 触发的 a[download] 处理；提示用户等待
                    Toast.makeText(this, "正在导出…", Toast.LENGTH_SHORT).show()
                    return@DownloadListener
                }
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    addRequestHeader("User-Agent", userAgent)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType),
                    )
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "已开始下载到「下载」目录", Toast.LENGTH_SHORT).show()
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (::appUpdates.isInitialized && appUpdates.handleBack()) return
                if (!isTrustedPage()) { defaultBack(); return }
                // React app switches do not create WebView history entries. Give the active page first refusal.
                webView.evaluateJavascript("!window.dispatchEvent(new Event('android-shell-back',{cancelable:true}))") { handled ->
                    if (!isFinishing && !isDestroyed && handled != "true") defaultBack()
                }
            }
        })

        appUpdates = AppUpdateController(this, container) { blocked -> applyUpdateGate(blocked) }
        appUpdates.start()

        // 冷启动带深链（如来电接听）直接加载目标；否则加载首页
        if (BuildConfig.LOCAL_BUNDLE) {
            LocalNodeRuntime.start(this) { localUrl, error ->
                if (isFinishing || isDestroyed) return@start
                if (localUrl != null) {
                    container.removeView(loading)
                    loadBusinessUrl(localUrl)
                } else {
                    loading.text = error ?: "本地服务启动失败"
                }
            }
        } else {
            loadBusinessUrl(consumeOpenUrl(intent) ?: SITE_URL)
            ensurePushService()
        }

        lifecycleScope.launch {
            lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
                observeOverlayFolds(this@MainActivity, windowManager) {
                    WindowInfoTracker.getOrCreate(this@MainActivity).windowLayoutInfo(this@MainActivity)
                }.retryWhen { cause, attempt ->
                    val retry = attempt < 2 && cause is Exception && cause !is SecurityException
                        && cause !is UnsupportedOperationException
                    if (retry) delay(250L shl attempt.toInt())
                    retry
                }.catch { failure ->
                    if (failure !is Exception && failure !is LinkageError && failure !is NotImplementedError) throw failure
                    latestWindowLayout = null
                }.collect { observation ->
                    latestWindowLayout = observation
                    updateFoldState(observation)
                }
            }
        }
    }

    private fun updateFoldState(observation: OverlayFoldObservation) {
        if (webView.width <= 0 || webView.height <= 0) return
        val matchesWindow = runCatching { observation.frame == overlayDisplayFrame(windowManager)
            && observation.area == overlayWindowArea(this, windowManager) }.getOrDefault(false)
        if (!matchesWindow) return
        val layoutInfo = observation.layout
        val feature = layoutInfo.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
        val density = resources.displayMetrics.density
        val location = IntArray(2).also { webView.getLocationInWindow(it) }
        val json = JSONObject().apply {
            put("hasFold", feature != null)
            put("viewportWidth", webView.width / density)
            put("viewportHeight", webView.height / density)
        }
        if (feature != null) {
            val bounds = feature.bounds
            val orientation = if (feature.orientation == FoldingFeature.Orientation.VERTICAL) "vertical" else "horizontal"
            val left = (bounds.left - location[0]).coerceIn(0, webView.width)
            val top = (bounds.top - location[1]).coerceIn(0, webView.height)
            val right = (bounds.right - location[0]).coerceIn(left, webView.width)
            val bottom = (bounds.bottom - location[1]).coerceIn(top, webView.height)
            json.put("posture", if (feature.state == FoldingFeature.State.HALF_OPENED) "folded" else "continuous")
                .put("orientation", orientation).put("isSeparating", feature.isSeparating)
                .put("bounds", JSONObject().put("left", left / density).put("top", top / density)
                    .put("width", (right - left) / density).put("height", (bottom - top) / density))
        }
        // Keep an explicit display fingerprint: an Activity cache may outlive rotation or resizing.
        // A partial Activity reporting no hinge cannot clear geometry belonging to another pane.
        currentOverlayFold = runCatching {
            val frame = overlayDisplayFrame(windowManager)
            val next = observation.snapshot()
            val cached = currentOverlayFold?.inFrame(frame)
            if (next != null && (cached == null || next.observedAtNanos >= cached.observedAtNanos)) next else cached
        }.getOrNull()
        if (layoutInfo.displayFeatures.isEmpty() && !observation.confirmedEmpty
            && currentFoldInfo?.optBoolean("hasFold") == true) return
        currentFoldInfo = json
        CompanionOverlayService.current?.onFoldChanged(currentOverlayFold)
        // The web layer is the single owner of CSS geometry, including viewport scaling.
        if (isTrustedPage()) webView.evaluateJavascript("window.__updateDeviceFoldInfo && window.__updateDeviceFoldInfo($json)", null)
    }

    /** singleTask：App 已在运行时（如全屏来电页接听）通过 onNewIntent 送达深链 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (intent.getBooleanExtra(EXTRA_RETURN_TO_DESKTOP, false)) {
            intent.removeExtra(EXTRA_RETURN_TO_DESKTOP)
            pendingDesktopReturn = true
            pendingCompanion = null
            stopService(Intent(this, CompanionOverlayService::class.java))
            dispatchDesktopReturn()
            return
        }
        val target = consumeOpenUrl(intent) ?: return
        // SPA 已加载：loadUrl 到同页 hash 只触发 hashchange，不会整页重载
        loadBusinessUrl(target)
    }

    private fun loadBusinessUrl(url: String) {
        businessUrl = url
        if (!updateBlocked) webView.loadUrl(url)
    }

    private fun applyUpdateGate(blocked: Boolean) {
        if (blocked == updateBlocked) return
        if (blocked && isTrustedPage()) businessUrl = webView.url
        updateBlocked = blocked
        if (blocked) {
            pendingCompanion = null
            if (::mediaPermissions.isInitialized) mediaPermissions.cancelWebRequest()
            stopService(Intent(this, CompanionOverlayService::class.java))
            stopService(Intent(this, PushService::class.java))
            CallAlert.stop(this)
            // Unload incompatible business JS and media, without clearing any persistent WebView data.
            webView.stopLoading(); webView.loadUrl("about:blank")
            webView.visibility = android.view.View.GONE
        } else {
            webView.visibility = android.view.View.VISIBLE
            businessUrl?.let { webView.loadUrl(it) }
            if (!BuildConfig.LOCAL_BUNDLE && lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                runCatching { PushService.start(this) }
            }
        }
    }

    private fun defaultBack() {
        if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
    }

    private fun dispatchDesktopReturn() {
        if (!pendingDesktopReturn || !isTrustedPage()) return
        pendingDesktopReturn = false
        // Retain a flag until React mounts if the Activity was cold-started from the overlay.
        webView.evaluateJavascript("window.__androidShellReturnHome=true;window.dispatchEvent(new Event('android-shell-home'))", null)
    }

    private fun consumeOpenUrl(intent: Intent?): String? {
        val target = intent?.getStringExtra(EXTRA_OPEN_URL) ?: return null
        intent.removeExtra(EXTRA_OPEN_URL)
        val expectedAccount = intent.getStringExtra(EXTRA_ACCOUNT_ID)
        intent.removeExtra(EXTRA_ACCOUNT_ID)
        if (expectedAccount != null && expectedAccount != PushService.accountScope) return null
        return target.takeIf { it.startsWith(SITE_URL) }
    }

    private fun ensurePushService() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            PushService.start(this)
        }
    }

    private fun isTrustedPage(): Boolean {
        if (updateBlocked) return false
        val current = runCatching { Uri.parse(webView.url) }.getOrNull() ?: return false
        val site = Uri.parse(SITE_URL)
        return current.scheme == site.scheme && current.host == site.host && current.port == site.port
    }

    private fun requestCompanion(url: Uri) {
        if (updateBlocked) return
        if (pendingCompanion != null) return
        val appId = url.getQueryParameter("app") ?: return
        val target = CompanionOverlayService.targetPackage(appId) ?: return
        val characterId = url.getQueryParameter("characterId")?.takeIf { it.isNotBlank() && it.length <= 200 } ?: return
        if (packageManager.getLaunchIntentForPackage(target) == null) {
            Toast.makeText(this, "请先安装${if (appId == "douyin") "抖音" else "小红书"} App", Toast.LENGTH_LONG).show()
            return
        }
        stopService(Intent(this, CompanionOverlayService::class.java))
        pendingCompanion = Bundle().apply {
            putString("appId", appId); putString("characterId", characterId)
            putString("name", url.getQueryParameter("name")?.take(80) ?: "AI 伴侣")
            putBoolean("voiceReplyEnabled", url.getQueryParameter("voiceReply") == "1")
        }
        if (Settings.canDrawOverlays(this)) { requestCompanionCaptureConsent(); return }
        Toast.makeText(this, "请允许小手机显示悬浮窗，返回后继续", Toast.LENGTH_LONG).show()
        runCatching {
            overlayPermissionLauncher.launch(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }.onFailure {
            pendingCompanion = null
            Toast.makeText(this, "无法打开悬浮窗权限设置", Toast.LENGTH_LONG).show()
        }
    }

    private fun requestCompanionCaptureConsent() {
        runCatching {
            val manager = getSystemService(MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
            val consent = if (Build.VERSION.SDK_INT >= 34) manager.createScreenCaptureIntent(MediaProjectionConfig.createConfigForDefaultDisplay())
                else manager.createScreenCaptureIntent()
            companionCaptureLauncher.launch(consent)
        }.onFailure {
            pendingCompanion = null
            Toast.makeText(this, "无法请求屏幕共享权限", Toast.LENGTH_LONG).show()
        }
    }

    fun dispatchCompanionEvent(name: String, detail: JSONObject) {
        if (isFinishing || isDestroyed || !isTrustedPage()) {
            stopService(Intent(this, CompanionOverlayService::class.java))
            return
        }
        webView.evaluateJavascript("window.dispatchEvent(new CustomEvent(${JSONObject.quote(name)},{detail:$detail}))", null)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        outState.putBundle("pendingCompanion", pendingCompanion)
        super.onSaveInstanceState(outState)
    }

    override fun onResume() {
        super.onResume()
        if (::appUpdates.isInitialized) appUpdates.onResume()
        if (::mediaPermissions.isInitialized) mediaPermissions.onResume()
        if (!BuildConfig.LOCAL_BUNDLE && !updateBlocked) runCatching { PushService.start(this) }
        if (::displayRefresh.isInitialized) displayRefresh.start()
    }

    override fun onStop() {
        if (::appUpdates.isInitialized) appUpdates.onStop()
        super.onStop()
    }

    override fun onPause() {
        if (::displayRefresh.isInitialized) displayRefresh.stop()
        super.onPause()
    }

    override fun onDestroy() {
        if (::mediaPermissions.isInitialized) mediaPermissions.destroy()
        if (::appUpdates.isInitialized) appUpdates.destroy()
        if (::displayRefresh.isInitialized) displayRefresh.stop()
        if (companionHost.get() === this) {
            companionHost.clear()
            stopService(Intent(this, CompanionOverlayService::class.java))
        }
        CookieManager.getInstance().flush()
        webView.destroy()
        super.onDestroy()
    }

    /** 暴露给网页的原生桥（网页侧可用 window.AndroidShell 特性检测壳环境）。 */
    inner class ShellBridge {
        @JavascriptInterface fun sharedArchivePermission(accountId: String): Boolean = archiveAccess(accountId) && archiveGranted()
        @JavascriptInterface fun requestSharedArchivePermission(accountId: String) {
            runOnUiThread {
                if (!isTrustedPage() || PushService.accountScope != accountId) return@runOnUiThread
                if (Build.VERSION.SDK_INT >= 30) startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:$packageName")))
                else androidx.core.app.ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE), 709)
            }
        }
        @JavascriptInterface fun sharedArchiveReadStart(accountId: String): String = archiveResult(accountId) { sharedArchive.beginRead() }
        @JavascriptInterface fun sharedArchiveRead(accountId: String, token: String, offset: String): String = archiveResult(accountId) { sharedArchive.read(token, offset.toLong()) }
        @JavascriptInterface fun sharedArchiveWriteStart(accountId: String): String = archiveResult(accountId) { sharedArchive.beginWrite() }
        @JavascriptInterface fun sharedArchiveWrite(accountId: String, token: String, bytes: String): String = archiveResult(accountId) { sharedArchive.append(token, bytes); true }
        @JavascriptInterface fun sharedArchiveCommit(accountId: String, token: String): String = archiveResult(accountId) { sharedArchive.commit(token); true }
        @JavascriptInterface
        fun getVersion(): String = VERSION

        @JavascriptInterface
        fun getMediaPermissionInfo(): String = mediaPermissions.info()

        @JavascriptInterface
        fun requestMicrophonePermission() {
            runOnUiThread { if (isTrustedPage()) mediaPermissions.requestMicrophone() }
        }

        @JavascriptInterface
        fun openMediaPermissionSettings() {
            runOnUiThread { if (isTrustedPage()) mediaPermissions.openAppSettings() }
        }

        @JavascriptInterface
        fun openMicrophonePrivacySettings() {
            runOnUiThread { if (isTrustedPage()) mediaPermissions.openPrivacySettings() }
        }

        @JavascriptInterface
        fun getAppUpdateInfo(): String = appUpdates.info()

        @JavascriptInterface
        fun checkForAppUpdate() {
            runOnUiThread { if (isTrustedPage()) appUpdates.manualCheck() }
        }

        @JavascriptInterface
        fun supportsCompanionOverlay(): Boolean = true

        @JavascriptInterface
        fun onAccountScopeChanged(accountId: String) {
            if (accountId.length > 160) return
            runOnUiThread {
                synchronized(PushService.accountLock) {
                if (!isTrustedPage() || PushService.accountScope == accountId) return@runOnUiThread
                PushService.accountScope = accountId
                sharedArchive.reset()
                pendingCompanion = null
                pendingDocumentExport = null
                stopService(Intent(this@MainActivity, CompanionOverlayService::class.java))
                stopService(Intent(this@MainActivity, PushService::class.java))
                CallAlert.stop(this@MainActivity)
                IncomingCallActivity.closeForAccountChange()
                val notifications = getSystemService(android.app.NotificationManager::class.java)
                notifications.activeNotifications.filter {
                    it.notification.channelId == "shell_messages" || it.notification.channelId == "shell_calls"
                }.forEach { notifications.cancel(it.id) }
                if (accountId.isNotEmpty() && !updateBlocked) PushService.start(this@MainActivity)
                }
            }
        }

        @JavascriptInterface
        fun stopCompanionOverlay() {
            runOnUiThread {
                if (!isTrustedPage()) return@runOnUiThread
                pendingCompanion = null
                stopService(Intent(this@MainActivity, CompanionOverlayService::class.java))
            }
        }

        /** Save a user-selected document through Android's system file picker. */
        @JavascriptInterface
        fun saveDocumentFile(base64: String, name: String, mime: String) {
            if (base64.length > 40 * 1024 * 1024) return
            runOnUiThread {
                if (!isTrustedPage()) return@runOnUiThread
                if (pendingDocumentExport != null) {
                    Toast.makeText(this@MainActivity, "请先完成当前文件保存", Toast.LENGTH_SHORT).show()
                    return@runOnUiThread
                }
                pendingDocumentExport = base64
                runCatching {
                    documentExportLauncher.launch(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                        addCategory(Intent.CATEGORY_OPENABLE)
                        type = mime.takeIf { it.contains('/') } ?: "application/octet-stream"
                        putExtra(Intent.EXTRA_TITLE, name.substringAfterLast('/').substringAfterLast('\\').take(240))
                    })
                }.onFailure {
                    pendingDocumentExport = null
                    Toast.makeText(this@MainActivity, "无法打开文件保存窗口", Toast.LENGTH_LONG).show()
                }
            }
        }

        @JavascriptInterface
        fun setCompanionAvatar(overlayId: String, dataUrl: String) {
            runOnUiThread { if (isTrustedPage()) CompanionOverlayService.current?.setAvatar(overlayId, dataUrl) }
        }

        @JavascriptInterface
        fun completeCompanionRequest(overlayId: String, requestId: String, text: String, isError: Boolean) {
            runOnUiThread { if (isTrustedPage()) CompanionOverlayService.current?.complete(overlayId, requestId, text, isError) }
        }

        @JavascriptInterface
        fun beginCompanionAudio(overlayId: String, requestId: String, length: Int) {
            runOnUiThread { if (isTrustedPage()) CompanionOverlayService.current?.beginAudio(overlayId, requestId, length) }
        }

        @JavascriptInterface
        fun appendCompanionAudio(overlayId: String, requestId: String, chunk: String) {
            if (chunk.length > 48 * 1024) return
            runOnUiThread { if (isTrustedPage()) CompanionOverlayService.current?.appendAudio(overlayId, requestId, chunk) }
        }

        @JavascriptInterface
        fun finishCompanionAudio(overlayId: String, requestId: String) {
            runOnUiThread { if (isTrustedPage()) CompanionOverlayService.current?.finishAudio(overlayId, requestId) }
        }

        private fun streamingAudioOnUi(action: () -> Int): Int {
            val result = java.util.concurrent.atomic.AtomicInteger(-1)
            val abandoned = java.util.concurrent.atomic.AtomicBoolean(false)
            val ready = java.util.concurrent.CountDownLatch(1)
            runOnUiThread {
                try { if (!abandoned.get() && isTrustedPage()) result.set(action()) }
                finally { ready.countDown() }
            }
            if (!ready.await(3, java.util.concurrent.TimeUnit.SECONDS)) { abandoned.set(true); return -1 }
            return result.get()
        }

        @JavascriptInterface
        fun beginCompanionPcm(overlayId: String, requestId: String, sampleRate: Int): Boolean = streamingAudioOnUi {
            if (CompanionOverlayService.current?.beginPcm(overlayId, requestId, sampleRate) == true) 1 else -1
        } == 1

        @JavascriptInterface
        fun appendCompanionPcm(overlayId: String, requestId: String, chunk: String): Int {
            if (chunk.length > 48 * 1024) return -1
            return streamingAudioOnUi { CompanionOverlayService.current?.appendPcm(overlayId, requestId, chunk) ?: -1 }
        }

        @JavascriptInterface
        fun finishCompanionPcm(overlayId: String, requestId: String) {
            runOnUiThread { if (isTrustedPage()) CompanionOverlayService.current?.finishPcm(overlayId, requestId) }
        }

        @JavascriptInterface
        fun stopCompanionPcm(overlayId: String, requestId: String) {
            runOnUiThread { if (isTrustedPage()) CompanionOverlayService.current?.stopPcm(overlayId, requestId) }
        }

        @JavascriptInterface
        fun failCompanionAudio(overlayId: String, requestId: String, message: String) {
            val safeMessage = message.take(200)
            runOnUiThread { if (isTrustedPage()) CompanionOverlayService.current?.failAudio(overlayId, requestId, safeMessage) }
        }

        @JavascriptInterface
        fun setCompanionVoiceEnabled(appId: String, enabled: Boolean) {
            runOnUiThread { if (isTrustedPage()) CompanionOverlayService.current?.setVoiceEnabled(appId, enabled) }
        }

        /** 打开本应用的系统设置页（引导用户关电池限制、开自启动）。 */
        @JavascriptInterface
        fun openAppSettings() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 请求忽略电池优化（保活关键一步）。 */
        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestIgnoreBatteryOptimization() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 返回折叠屏铰链/折痕几何与状态信息 */
        @JavascriptInterface
        fun getFoldInfo(): String = currentFoldInfo?.toString() ?: "{\"hasFold\":false}"

        @JavascriptInterface
        fun getDeviceWindowInfo(): String = webViewWindow.snapshot()

        @JavascriptInterface
        fun getDisplayRefreshInfo(): String = displayRefresh.snapshot()

        @JavascriptInterface
        fun setPreferredRefreshRate(fps: Int) {
            runOnUiThread { if (isTrustedPage()) displayRefresh.select(fps) }
        }

        @JavascriptInterface
        fun setSystemBarAppearance(useDarkIcons: Boolean) {
            runOnUiThread { if (isTrustedPage()) webViewWindow.applyBarAppearance(useDarkIcons) }
        }

        @JavascriptInterface
        fun setSystemBarAppearanceForBackgrounds(useDarkStatusIcons: Boolean, useDarkNavigationIcons: Boolean) {
            runOnUiThread {
                if (isTrustedPage()) webViewWindow.applyBarAppearance(useDarkStatusIcons, useDarkNavigationIcons)
            }
        }
    }
}
