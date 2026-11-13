package app.floatphone.shell

import android.content.ClipData
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.lifecycle.Lifecycle
import org.json.JSONObject

/** Native dialogs and a persistent mandatory-update gate; no business data is changed. */
class AppUpdateController(
    private val activity: AppCompatActivity, private val container: FrameLayout,
    private val onGateChanged: (Boolean) -> Unit,
) {
    private val repository = AppUpdateRepository.get(activity)
    private var dialog: AlertDialog? = null
    private var dialogKey = ""
    private var detail: TextView? = null
    private var bar: ProgressBar? = null
    private var foreground = false
    private var requested = false
    private var dismissedIdentity: String? = null
    private var lastBlocked = false
    private val gate = TextView(activity).apply {
        text = "此版本需要更新后才能继续使用。\n请完成更新，或退出应用。"
        textSize = 18f; gravity = Gravity.CENTER
        setTextColor(Color.BLACK); setBackgroundColor(Color.WHITE)
        isClickable = true; isFocusable = true
        visibility = View.GONE
        setOnClickListener { requested = true; render(repository.state) }
    }
    private val permissionLauncher = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        resumePermissionRequest()
    }
    private val installerLauncher = activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        requested = true
        repository.notice("若尚未完成安装，可再次点击安装；原版本和数据仍保留。")
    }
    private val observer: (AppUpdateState) -> Unit = { render(it) }
    val blocked: Boolean get() = repository.state.required
    init {
        container.addView(gate, FrameLayout.LayoutParams(-1, -1))
        repository.observe(observer)
    }
    fun start() { repository.checkAtStartup() }
    fun manualCheck() {
        requested = true; dismissedIdentity = null
        val state = repository.state
        if (state.phase in listOf(AppUpdatePhase.CHECKING, AppUpdatePhase.DOWNLOADING, AppUpdatePhase.VERIFYING, AppUpdatePhase.READY)) render(state)
        else repository.check()
    }
    fun onResume() { foreground = true; render(repository.state); resumePermissionRequest() }
    fun onStop() {
        foreground = false
        dialog?.dismiss(); dialog = null; dialogKey = ""
        if (!activity.isChangingConfigurations) repository.cancelDownload()
    }
    fun destroy() {
        repository.removeObserver(observer)
        dialog?.dismiss(); dialog = null
        container.removeView(gate)
    }
    fun handleBack(): Boolean {
        if (!blocked) return false
        requested = true; render(repository.state)
        return true
    }
    fun info(): String = JSONObject().put("available", true).put("versionCode", BuildConfig.VERSION_CODE)
        .put("versionName", BuildConfig.VERSION_NAME).put("phase", repository.state.phase.name)
        .put("configured", BuildConfig.UPDATE_MANIFEST_URL.isNotBlank()).toString()
    private fun render(state: AppUpdateState) {
        val required = state.required
        gate.visibility = if (required) View.VISIBLE else View.GONE
        if (required != lastBlocked) { lastBlocked = required; onGateChanged(required) }
        if (!foreground || activity.isFinishing || activity.isDestroyed) return
        if (resumePermissionRequest()) return
        val manifest = state.manifest
        val shouldShow = required || requested || (manifest != null && dismissedIdentity != manifest.identity
            && state.phase != AppUpdatePhase.CHECKING)
        if (!shouldShow || state.phase == AppUpdatePhase.IDLE && !requested) {
            dialog?.dismiss(); dialog = null; dialogKey = ""; return
        }
        val key = "${state.phase}:${manifest?.identity}:$required"
        if (dialog != null && dialogKey == key) { updateProgress(state); return }
        dialog?.dismiss(); dialogKey = key
        val density = activity.resources.displayMetrics.density
        fun dp(value: Int) = (value * density).toInt()
        detail = TextView(activity).apply { textSize = 15f; setPadding(dp(24), dp(12), dp(24), dp(12)) }
        bar = ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal).apply { max = 1000 }
        val layout = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            val height = minOf(dp(230), (activity.resources.displayMetrics.heightPixels * 0.35f).toInt()).coerceAtLeast(dp(72))
            addView(ScrollView(activity).apply { addView(detail) }, LinearLayout.LayoutParams(-1, height))
            addView(bar, LinearLayout.LayoutParams(-1, dp(18)).apply { leftMargin = dp(24); rightMargin = dp(24) })
        }
        val working = state.phase == AppUpdatePhase.DOWNLOADING || state.phase == AppUpdatePhase.VERIFYING
        val builder = AlertDialog.Builder(activity)
            .setTitle(if (manifest != null) "${if (required) "必须更新" else "发现新版本"} ${manifest.versionName}" else "检查更新")
            .setView(layout).setCancelable(!required)
        val positive = when (state.phase) {
            AppUpdatePhase.CHECKING, AppUpdatePhase.DOWNLOADING, AppUpdatePhase.VERIFYING -> null
            AppUpdatePhase.READY -> "立即安装"
            AppUpdatePhase.PAUSED -> "继续下载"
            AppUpdatePhase.ERROR -> "重试"
            AppUpdatePhase.IDLE -> "确定"
            else -> "立即更新"
        }
        if (positive != null) builder.setPositiveButton(positive, null)
        if (state.phase != AppUpdatePhase.IDLE) builder.setNegativeButton(
            if (required) "退出应用" else if (working) "暂停下载" else if (manifest == null) "关闭" else "稍后更新", null)
        if (required && state.phase != AppUpdatePhase.CHECKING) builder.setNeutralButton(if (working) "暂停下载" else "重新检查", null)
        val shown = builder.create()
        dialog = shown
        shown.setCanceledOnTouchOutside(!required)
        shown.setOnCancelListener {
            dismissedIdentity = manifest?.identity; requested = false
            repository.cancelDownload()
        }
        shown.setOnShowListener {
            shown.getButton(AlertDialog.BUTTON_POSITIVE)?.setOnClickListener {
                when (repository.state.phase) {
                    AppUpdatePhase.IDLE -> { requested = false; shown.dismiss(); dialog = null; dialogKey = "" }
                    AppUpdatePhase.READY -> requestInstall()
                    AppUpdatePhase.ERROR -> if (repository.state.manifest == null) repository.check() else repository.download()
                    else -> repository.download()
                }
            }
            shown.getButton(AlertDialog.BUTTON_NEGATIVE)?.setOnClickListener {
                if (required) { repository.cancelDownload(); activity.finishAndRemoveTask() }
                else if (working) repository.cancelDownload()
                else {
                    dismissedIdentity = manifest?.identity; requested = false; repository.cancelDownload()
                    shown.dismiss(); dialog = null; dialogKey = ""
                }
            }
            shown.getButton(AlertDialog.BUTTON_NEUTRAL)?.setOnClickListener {
                if (working) repository.cancelDownload() else repository.check()
            }
        }
        shown.show(); updateProgress(state)
    }
    private fun updateProgress(state: AppUpdateState) {
        val manifest = state.manifest
        fun mb(size: Long) = String.format(java.util.Locale.ROOT, "%.1f", size / 1048576.0)
        val status = when (state.phase) {
            AppUpdatePhase.CHECKING -> "正在安全检查最新版本…"
            AppUpdatePhase.DOWNLOADING -> if (state.total > 0) "已下载 ${mb(state.downloaded)} / ${mb(state.total)} MB" else "已下载 ${mb(state.downloaded)} MB"
            AppUpdatePhase.VERIFYING -> "正在校验 SHA-256、包名、版本和数字签名…"
            else -> state.message
        }
        detail?.text = listOfNotNull(manifest?.let { "版本：${it.versionName}（${it.versionCode}）\n\n${it.releaseNotes}" },
            status.takeIf { it.isNotBlank() }).joinToString("\n\n")
        bar?.apply {
            visibility = if (state.phase in listOf(AppUpdatePhase.CHECKING, AppUpdatePhase.DOWNLOADING, AppUpdatePhase.VERIFYING)) View.VISIBLE else View.GONE
            isIndeterminate = state.phase != AppUpdatePhase.DOWNLOADING || state.total <= 0
            if (state.total > 0) progress = (state.downloaded * 1000 / state.total).coerceIn(0, 1000).toInt()
        }
    }
    private fun requestInstall() {
        requested = true
        repository.verifyForInstall {
            if (activity.isDestroyed || activity.isFinishing || !activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) return@verifyForInstall
            if (!activity.packageManager.canRequestPackageInstalls()) {
                repository.awaitInstallPermission()
                runCatching {
                    permissionLauncher.launch(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
                }.onFailure {
                    repository.takeInstallPermissionRequest()
                    repository.notice("无法打开安装授权设置，请在系统设置中允许此应用安装未知应用后重试。")
                }
            } else openInstaller()
        }
    }
    private fun resumePermissionRequest(): Boolean {
        if (!foreground || repository.state.phase in listOf(AppUpdatePhase.CHECKING, AppUpdatePhase.DOWNLOADING, AppUpdatePhase.VERIFYING)) return false
        if (!repository.takeInstallPermissionRequest()) return false
        requested = true
        if (activity.packageManager.canRequestPackageInstalls()) { requestInstall(); return true }
        repository.notice("尚未获得未知来源安装授权，可再次点击安装；也可以退出。")
        return false
    }
    @Suppress("DEPRECATION")
    private fun openInstaller() {
        runCatching {
            val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.updates", repository.verifiedApk)
            installerLauncher.launch(Intent(Intent.ACTION_INSTALL_PACKAGE).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                clipData = ClipData.newRawUri("APK update", uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                putExtra(Intent.EXTRA_RETURN_RESULT, true)
            })
        }.onFailure {
            repository.notice("无法打开系统安装器，请检查设备的安装限制后重试。原版本和数据未被修改。")
            Toast.makeText(activity, "无法打开系统安装器", Toast.LENGTH_LONG).show()
        }
    }
}
