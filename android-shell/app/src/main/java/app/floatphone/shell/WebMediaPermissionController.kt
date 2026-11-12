package app.floatphone.shell

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.provider.Settings
import android.webkit.PermissionRequest
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import org.json.JSONObject

/** Runtime authorization and WebView authorization are separate; neither starts recording. */
class WebMediaPermissionController(
    private val activity: AppCompatActivity,
    private val trustedOrigin: (Uri) -> Boolean,
    private val notifyChanged: () -> Unit,
) {
    private var pendingWeb: PermissionRequest? = null
    private var manualMicrophone = false
    @Volatile private var promptInFlight = false
    private var recovery: AlertDialog? = null
    private val permissionLauncher = activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        promptInFlight = false
        val request = pendingWeb
        val manual = manualMicrophone
        pendingWeb = null; manualMicrophone = false
        if (activity.isDestroyed || activity.isFinishing) return@registerForActivityResult
        if (request != null) {
            val requested = request.resources.filter { androidPermissions(it).isNotEmpty() }
            if (trustedOrigin(request.origin)) {
                val grantedResources = requested.filter { resource -> androidPermissions(resource).all { granted(it) } }
                runCatching { if (grantedResources.isEmpty()) request.deny() else request.grant(grantedResources.toTypedArray()) }
                if (requested.any { resource -> androidPermissions(resource).any { !granted(it) } }) showRecovery()
            } else runCatching { request.deny() }
        } else if (manual) {
            if (granted(Manifest.permission.RECORD_AUDIO)) {
                Toast.makeText(activity, "麦克风权限已允许；返回通话后点击连接或录音，不会自动开麦。", Toast.LENGTH_LONG).show()
            } else showRecovery()
        }
        notifyChanged()
    }
    private fun androidPermissions(resource: String): List<String> = when (resource) {
        PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
        PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        else -> emptyList()
    }
    private fun granted(permission: String) = ContextCompat.checkSelfPermission(activity, permission) == PackageManager.PERMISSION_GRANTED
    private fun canRequest() = !activity.isFinishing && !activity.isDestroyed && activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)

    fun requestWeb(request: PermissionRequest) {
        if (!canRequest() || !trustedOrigin(request.origin)) { runCatching { request.deny() }; return }
        val supported = request.resources.filter { androidPermissions(it).isNotEmpty() }.distinct()
        if (supported.isEmpty()) { request.deny(); return }
        val missing = supported.flatMap { androidPermissions(it) }.distinct().filter { !granted(it) }
        if (missing.isEmpty()) { request.grant(supported.toTypedArray()); return }
        if (promptInFlight || pendingWeb != null) { request.deny(); return }
        pendingWeb = request
        launch(missing)
    }
    fun onWebRequestCanceled(request: PermissionRequest) {
        // The platform already canceled this request. Do not retain or grant it later.
        if (pendingWeb === request) pendingWeb = null
    }
    fun cancelWebRequest() {
        val request = pendingWeb; pendingWeb = null
        if (request != null) runCatching { request.deny() }
    }
    fun requestMicrophone() {
        if (!canRequest()) return
        if (promptInFlight) { Toast.makeText(activity, "请先完成当前系统权限选择", Toast.LENGTH_SHORT).show(); return }
        if (granted(Manifest.permission.RECORD_AUDIO)) {
            Toast.makeText(activity, "麦克风权限已允许。若仍无声音，请检查系统的麦克风访问总开关。", Toast.LENGTH_LONG).show()
            notifyChanged(); return
        }
        manualMicrophone = true
        launch(listOf(Manifest.permission.RECORD_AUDIO))
    }
    private fun launch(permissions: List<String>) {
        recovery?.dismiss(); recovery = null
        promptInFlight = true
        runCatching { permissionLauncher.launch(permissions.toTypedArray()) }.onFailure {
            promptInFlight = false; manualMicrophone = false; cancelWebRequest()
            Toast.makeText(activity, "无法弹出系统权限窗口，请从应用权限设置中允许麦克风。", Toast.LENGTH_LONG).show()
        }
        notifyChanged()
    }
    private fun showRecovery() {
        if (!activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return
        recovery?.dismiss()
        recovery = AlertDialog.Builder(activity).setTitle("尚未获得录音或相机权限")
            .setMessage("可以继续使用文字。若系统不再弹出授权窗口，请打开应用设置，在权限中允许麦克风；视频通话还需允许相机。手机的麦克风访问总开关也需要开启。")
            .setPositiveButton("打开应用设置") { _, _ -> openAppSettings() }
            .setNegativeButton("继续使用文字", null).create().also { it.show() }
    }
    fun openAppSettings() {
        if (!canRequest()) return
        runCatching { activity.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))) }
            .onFailure { Toast.makeText(activity, "请在手机设置 → 应用 → 寻信 → 权限中允许麦克风", Toast.LENGTH_LONG).show() }
    }
    fun openPrivacySettings() {
        if (!canRequest()) return
        runCatching { activity.startActivity(Intent(Settings.ACTION_PRIVACY_SETTINGS)) }
            .onFailure { Toast.makeText(activity, "请在手机控制中心或隐私设置中开启麦克风访问", Toast.LENGTH_LONG).show() }
    }
    fun info(): String {
        // Public SDK mute status. Do not call hidden SensorPrivacyManager query methods.
        val muted = runCatching { activity.getSystemService(AudioManager::class.java)?.isMicrophoneMute }.getOrNull()
        return JSONObject().put("available", true).put("microphoneGranted", granted(Manifest.permission.RECORD_AUDIO))
            .put("cameraGranted", granted(Manifest.permission.CAMERA)).put("requesting", promptInFlight)
            .put("systemMicrophoneMuted", muted ?: JSONObject.NULL).toString()
    }
    fun onResume() { notifyChanged() }
    fun destroy() { cancelWebRequest(); recovery?.dismiss(); recovery = null }
}
