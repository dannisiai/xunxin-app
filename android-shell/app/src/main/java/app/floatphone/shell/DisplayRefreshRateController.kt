package app.floatphone.shell

import android.hardware.display.DisplayManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.Display
import android.webkit.WebView
import androidx.appcompat.app.AppCompatActivity
import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.abs

/** Device-local display preference. A refresh-rate request is not a measured app FPS. */
class DisplayRefreshRateController(
    private val activity: AppCompatActivity,
    private val webView: WebView,
    private val trustedPage: () -> Boolean,
) : DisplayManager.DisplayListener {
    private val manager = activity.getSystemService(DisplayManager::class.java)
    private val preferences = activity.getSharedPreferences("display_refresh", 0)
    private val choices = setOf(0, 60, 120, 144, 185)
    private var listening = false
    @Volatile private var cachedInfo = "{}"

    fun snapshot(): String = cachedInfo

    fun start() {
        if (!listening) {
            listening = runCatching {
                manager?.registerDisplayListener(this, Handler(Looper.getMainLooper()))
                manager != null
            }.getOrDefault(false)
        }
        refresh(force = true)
        webView.post { if (listening) refresh() }
    }

    fun stop() {
        if (listening) runCatching { manager?.unregisterDisplayListener(this) }
        listening = false
    }

    @Suppress("DEPRECATION")
    private fun currentDisplay(): Display? = (webView.display ?: activity.windowManager.defaultDisplay)?.takeIf { it.isValid }

    private fun rates(display: Display, sameResolution: Boolean): List<Float> {
        val current = display.mode
        return display.supportedModes.filter {
            !sameResolution || it.physicalWidth == current.physicalWidth && it.physicalHeight == current.physicalHeight
        }.flatMap { mode ->
            listOf(mode.refreshRate) + if (Build.VERSION.SDK_INT >= 31) mode.alternativeRefreshRates.toList() else emptyList()
        }.filter { it.isFinite() && it in 1f..1000f }.distinct().sorted()
    }

    fun select(fps: Int) {
        if (fps !in choices) return
        val display = runCatching { currentDisplay() }.getOrNull() ?: return
        val available = runCatching { rates(display, true) }.getOrDefault(emptyList())
        // Use the device's actual rate (e.g. 119.88), never request an invented overclock.
        if (fps != 0 && available.none { abs(it - fps) <= 0.6f }) { refresh(force = true); return }
        preferences.edit().putInt("target_fps", fps).apply()
        refresh(force = true)
    }

    fun refresh(force: Boolean = false) {
        val display = runCatching { currentDisplay() }.getOrNull()
        if (display == null) {
            applyPreference(0f)
            publish("{\"availableRates\":[],\"maximumHz\":0,\"currentHz\":0,\"targetFps\":0,\"canSet\":false}", force)
            return
        }
        val available = runCatching { rates(display, true) }.getOrDefault(emptyList())
        val all = runCatching { rates(display, false) }.getOrDefault(available)
        if (available.isEmpty()) {
            applyPreference(0f)
            publish(JSONObject().apply {
                put("availableRates", JSONArray())
                put("maximumHz", (all.maxOrNull() ?: 0f).toDouble())
                put("targetFps", 0)
                put("canSet", false)
            }.toString(), force)
            return
        }
        val saved = preferences.getInt("target_fps", 0)
        val desired = available.minByOrNull { abs(it - saved) }?.takeIf { saved in choices && saved != 0 && abs(it - saved) <= 0.6f }
        val target = if (desired != null) saved else 0
        if (target != saved) preferences.edit().putInt("target_fps", target).apply()
        applyPreference(desired ?: 0f)
        val info = JSONObject().apply {
            put("availableRates", JSONArray(available.map { it.toDouble() }))
            put("maximumHz", (all.maxOrNull() ?: 0f).toDouble())
            put("currentHz", display.refreshRate.takeIf { it.isFinite() && it > 0 }?.toDouble() ?: 0.0)
            put("targetFps", target)
            put("preferredHz", (desired ?: 0f).toDouble())
            put("canSet", available.isNotEmpty())
        }.toString()
        publish(info, force)
    }

    private fun applyPreference(rate: Float) {
        val attributes = activity.window.attributes
        if (attributes.preferredDisplayModeId != 0 || abs(attributes.preferredRefreshRate - rate) > 0.01f) {
            // Leave resolution selection to Android. Power/thermal policy may override this preference.
            attributes.preferredDisplayModeId = 0
            attributes.preferredRefreshRate = rate
            activity.window.attributes = attributes
        }
    }

    private fun publish(info: String, force: Boolean) {
        if (!force && cachedInfo == info) return
        cachedInfo = info
        if (trustedPage()) webView.evaluateJavascript(
            "window.dispatchEvent(new CustomEvent('android-display-refresh-changed',{detail:$info}))", null,
        )
    }

    override fun onDisplayAdded(displayId: Int) { if (listening) refresh() }
    override fun onDisplayRemoved(displayId: Int) { if (listening) refresh() }
    override fun onDisplayChanged(displayId: Int) { if (listening) refresh() }
}
