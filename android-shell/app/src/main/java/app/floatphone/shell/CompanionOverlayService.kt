package app.floatphone.shell

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.animation.ValueAnimator
import android.view.animation.LinearInterpolator
import android.content.Intent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import android.media.AudioManager
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.Drawable
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Base64
import android.text.TextUtils
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.WindowInsets
import android.view.inputmethod.InputMethodManager
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.view.ViewCompat
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsCompat
import org.json.JSONObject
import java.util.UUID

/** Small, user-controlled companion bubble; the existing WebView generates and saves replies. */
class CompanionOverlayService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private lateinit var windows: WindowManager
    private lateinit var foldMonitor: OverlayFoldMonitor
    private val overlayUiContext get() = foldMonitor.uiContext
    private var independentFoldReady = false
    private var capture: CompanionScreenCapture? = null
    private var bubble: FrameLayout? = null
    private var avatar: ImageView? = null
    private var initial: TextView? = null
    private var notice: FrameLayout? = null
    private var noticeLabel: TextView? = null
    private var noticeDots: ThinkingDotsView? = null
    private var noticeDismiss: Runnable? = null
    private var conversationText = ""
    private var panel: LinearLayout? = null
    private var panelMovedByUser = false
    private var transcript: TextView? = null
    private var scroll: ScrollView? = null
    private var input: EditText? = null
    private var readButton: Button? = null
    private var sendButton: Button? = null
    private var requestId: String? = null
    private var requestTimeout: Runnable? = null
    private var overlayId = UUID.randomUUID().toString()
    private var characterId = ""
    private var characterName = ""
    private var appId = ""
    private var busy = false
    private var destroyed = false
    private var foldSnapshot: OverlayFoldSnapshot? = null
    private var lastFoldObservationNanos = Long.MIN_VALUE
    private var imeBottom = 0
    private var unregisterPanelBack: (() -> Unit)? = null
    private lateinit var voicePlayer: CompanionVoicePlayer
    private lateinit var foregroundNotification: Notification
    private var voiceEnabled = false
    private var voiceRequestId: String? = null
    private var voiceControls: LinearLayout? = null
    private var voicePlayButton: Button? = null
    private var voiceStopButton: Button? = null
    private val noisyReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == AudioManager.ACTION_AUDIO_BECOMING_NOISY) stopVoice()
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        foldMonitor = OverlayFoldMonitor(this,
            onFold = { snapshot ->
                if (applyFoldGeometry(snapshot)) independentFoldReady = true
            },
            onUnavailable = { independentFoldReady = false },
            onConfiguration = { reconcileDisplayConfiguration() })
        windows = foldMonitor.windows
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
            NotificationChannel(CHANNEL, "AI 伴侣屏幕陪伴", NotificationManager.IMPORTANCE_LOW))
        voicePlayer = CompanionVoicePlayer(this, { updateVoiceControls() },
            { message ->
                if (!destroyed) {
                    dispatchVoiceStop()
                    Toast.makeText(this, message, Toast.LENGTH_LONG).show()
                }
            },
            { playing -> updatePlaybackForeground(playing) })
        ContextCompat.registerReceiver(this, noisyReceiver, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (AppUpdateRepository.isRequired(this)) { stopSelf(); return START_NOT_STICKY }
        if (intent?.action == ACTION_CLOSE) { stopSelf(); return START_NOT_STICKY }
        if (intent?.action == ACTION_STOP_VOICE) { stopVoice(); return START_NOT_STICKY }
        if (capture != null) return START_NOT_STICKY
        voiceEnabled = intent?.getBooleanExtra("voiceReplyEnabled", false) == true
        val stop = PendingIntent.getService(this, 0, Intent(this, CompanionOverlayService::class.java).setAction(ACTION_CLOSE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val home = PendingIntent.getActivity(this, 0, desktopIntent(),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_stat)
            .setContentTitle("AI 伴侣正在陪你浏览")
            .setContentText("点击悬浮头像看屏幕，长按打开对话，拖动可移动")
            .setOngoing(true).setContentIntent(home).addAction(0, "关闭陪伴", stop)
        if (voiceEnabled) {
            val stopAudio = PendingIntent.getService(this, 1,
                Intent(this, CompanionOverlayService::class.java).setAction(ACTION_STOP_VOICE),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            notification.addAction(0, "停止语音", stopAudio)
        }
        foregroundNotification = notification.build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION_ID, foregroundNotification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION)
        else startForeground(NOTIFICATION_ID, foregroundNotification)
        try {
            appId = intent?.getStringExtra("appId") ?: ""
            characterId = intent?.getStringExtra("characterId") ?: ""
            characterName = intent?.getStringExtra("name") ?: "AI 伴侣"
            val target = targetPackage(appId) ?: error("不支持的应用")
            if (characterId.isBlank() || MainActivity.companionHost.get() == null) error("请返回小手机重新打开陪伴")
            @Suppress("DEPRECATION")
            val data = intent?.getParcelableExtra<Intent>("projectionData") ?: error("请重新允许屏幕共享")
            current = this
            onFoldChanged(MainActivity.currentOverlayFold)
            capture = CompanionScreenCapture(this) {
                Toast.makeText(this, "屏幕共享已结束，陪伴悬浮窗已关闭", Toast.LENGTH_LONG).show()
                stopSelf()
            }.also { it.start(data) }
            showBubble()
            foldMonitor.start()
            val host = MainActivity.companionHost.get() ?: error("请返回小手机")
            host.dispatchCompanionEvent("android-companion-avatar", JSONObject().put("overlayId", overlayId).put("characterId", characterId))
            val launch = packageManager.getLaunchIntentForPackage(target) ?: error("请先安装${appName()}")
            startActivity(launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (error: Exception) {
            Toast.makeText(this, error.message ?: "无法启动屏幕陪伴", Toast.LENGTH_LONG).show()
            stopSelf()
        }
        return START_NOT_STICKY
    }

    private fun appName() = if (appId == "douyin") "抖音" else "小红书"
    private fun compactCompanion() = appId == "douyin"
    private fun bubbleSize() = dp(72)
    private fun dp(value: Int) = (value * overlayUiContext.resources.displayMetrics.density).toInt()
    private fun background(color: Int, radius: Float) = GradientDrawable().apply { setColor(color); cornerRadius = dp(radius.toInt()).toFloat() }

    private fun showBubble() {
        val root = FrameLayout(overlayUiContext).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(Color.rgb(255, 252, 247))
                setStroke(dp(2), Color.rgb(230, 224, 215))
            }
            clipToOutline = true
            elevation = dp(6).toFloat()
            contentDescription = "${characterName}，点击看屏幕，长按打开对话，拖动移动"
        }
        initial = TextView(overlayUiContext).apply {
            text = characterName.trim().ifBlank { "AI 伴侣" }
            textSize = if (characterName.length <= 2) 24f else 14f
            gravity = Gravity.CENTER
            maxLines = 3
            ellipsize = TextUtils.TruncateAt.END
            includeFontPadding = false
            setPadding(dp(4), dp(4), dp(4), dp(4))
            setTextColor(Color.rgb(86, 57, 49))
        }
        root.addView(initial, FrameLayout.LayoutParams(-1, -1))
        avatar = ImageView(overlayUiContext).apply { scaleType = ImageView.ScaleType.CENTER_CROP }
        root.addView(avatar, FrameLayout.LayoutParams(-1, -1))
        val params = WindowManager.LayoutParams(bubbleSize(), bubbleSize(), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.START; x = dp(16); y = dp(140)
        }
        if (compactCompanion()) {
            val segment = safeSegments().maxByOrNull { it.width().toLong() * it.height() }!!
            params.x = segment.right - params.width
            params.y = segment.top + (segment.height() * 0.52f).toInt() - params.height / 2
        }
        root.setOnLongClickListener { showPanel(); true }
        root.setOnClickListener {
            if (!busy) requestScreen("")
            else if (compactCompanion()) { hidePanel(); showNotice("…") }
            else showPanel()
        }
        bindOverlayDrag(root, { params }) { position ->
            fitBubble(position)
            windows.updateViewLayout(root, position)
            reflowNotice()
        }
        fitBubble(params)
        windows.addView(root, params)
        bubble = root
    }

    /** Share the same tap/long-press/drag distinction across the avatar, reply and title bar. */
    private fun bindOverlayDrag(handle: View, position: () -> WindowManager.LayoutParams?, move: (WindowManager.LayoutParams) -> Unit) {
        var downX = 0f; var downY = 0f; var originalX = 0; var originalY = 0; var moved = false
        var longPressed = false
        var dragging: WindowManager.LayoutParams? = null
        val longPress = Runnable { if (!moved && !destroyed && handle.isAttachedToWindow) longPressed = handle.performLongClick() }
        val slop = ViewConfiguration.get(overlayUiContext).scaledTouchSlop
        handle.setOnTouchListener { view, event ->
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    val params = position() ?: return@setOnTouchListener false
                    dragging = params
                    downX = event.rawX; downY = event.rawY; originalX = params.x; originalY = params.y; moved = false; longPressed = false
                    if (handle.isLongClickable) handler.postDelayed(longPress, ViewConfiguration.getLongPressTimeout().toLong())
                    true
                }
                MotionEvent.ACTION_MOVE -> {
                    val params = dragging ?: return@setOnTouchListener true
                    val dx = event.rawX - downX; val dy = event.rawY - downY
                    if (kotlin.math.abs(dx) > slop || kotlin.math.abs(dy) > slop) moved = true
                    if (moved) {
                        handler.removeCallbacks(longPress)
                        params.x = originalX + dx.toInt()
                        params.y = originalY + dy.toInt()
                        move(params)
                    }
                    true
                }
                MotionEvent.ACTION_UP -> {
                    handler.removeCallbacks(longPress)
                    if (dragging != null && !moved && !longPressed) view.performClick()
                    dragging = null
                    true
                }
                MotionEvent.ACTION_CANCEL, MotionEvent.ACTION_POINTER_DOWN -> { handler.removeCallbacks(longPress); dragging = null; true }
                else -> false
            }
        }
    }

    private fun noticeBackground() = object : Drawable() {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.argb(245, 255, 252, 247) }
        override fun draw(canvas: Canvas) {
            val inset = dp(10).toFloat()
            val rect = RectF(bounds.left + inset, bounds.top + inset, bounds.right - inset, bounds.bottom - inset)
            if (rect.isEmpty) return
            paint.setShadowLayer(dp(7).toFloat(), 0f, 0f, Color.argb(100, 120, 100, 88))
            val radius = minOf(dp(22).toFloat(), rect.height() / 2)
            canvas.drawRoundRect(rect, radius, radius, paint)
        }
        override fun setAlpha(alpha: Int) { paint.alpha = alpha; invalidateSelf() }
        override fun setColorFilter(filter: ColorFilter?) { paint.colorFilter = filter; invalidateSelf() }
        @Suppress("DEPRECATION")
        override fun getOpacity() = PixelFormat.TRANSLUCENT
    }

    /** Three separate circles: unlike an ellipsis glyph, each dot has its own motion phase. */
    private inner class ThinkingDotsView(context: android.content.Context) : View(context) {
        private val dotPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.rgb(86, 57, 49) }
        private var pulse: ValueAnimator? = null
        private var phase = 0f
        fun stop() { pulse?.cancel(); pulse = null }
        private fun syncAnimation() {
            if (!isAttachedToWindow || !isShown || windowVisibility != View.VISIBLE) { stop(); return }
            if (pulse != null || (Build.VERSION.SDK_INT >= 26 && !ValueAnimator.areAnimatorsEnabled())) return
            pulse = ValueAnimator.ofFloat(0f, 1f).apply {
                duration = 1100L
                repeatCount = ValueAnimator.INFINITE
                interpolator = LinearInterpolator()
                addUpdateListener { phase = it.animatedValue as Float; invalidate() }
                start()
            }
        }
        override fun onAttachedToWindow() { super.onAttachedToWindow(); syncAnimation() }
        override fun onDetachedFromWindow() { stop(); super.onDetachedFromWindow() }
        override fun onVisibilityChanged(changedView: View, visibility: Int) {
            super.onVisibilityChanged(changedView, visibility); syncAnimation()
        }
        override fun onWindowVisibilityChanged(visibility: Int) { super.onWindowVisibilityChanged(visibility); syncAnimation() }
        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val density = resources.displayMetrics.density
            for (index in 0..2) {
                val position = (phase - index * 0.16f + 1f) % 1f
                val bounce = if (position < 0.5f) kotlin.math.sin(position * 2f * Math.PI).toFloat() else 0f
                dotPaint.alpha = (145 + bounce * 110).toInt().coerceIn(0, 255)
                canvas.drawCircle(width / 2f + (index - 1) * 13f * density,
                    height / 2f + 2f * density - bounce * 6f * density, 3.5f * density, dotPaint)
            }
        }
    }

    private fun setNoticeMessage(message: String) {
        val thinking = message == "…"
        noticeLabel?.apply { text = if (thinking) "" else message.take(16000); visibility = if (thinking) View.GONE else View.VISIBLE }
        noticeDots?.visibility = if (thinking) View.VISIBLE else View.GONE
    }

    /** Lightweight feedback stays over the video without taking keyboard focus. */
    private fun showNotice(message: String, dismissAfterMs: Long = 0L) {
        if (destroyed || !compactCompanion()) return
        noticeDismiss?.let { handler.removeCallbacks(it) }; noticeDismiss = null
        if (notice == null) {
            val root = FrameLayout(overlayUiContext).apply {
                setPadding(dp(10), dp(10), dp(10), dp(10))
                setLayerType(View.LAYER_TYPE_SOFTWARE, null)
                background = noticeBackground()
                setOnClickListener { hideNotice() }
                setOnLongClickListener { showPanel(); true }
            }
            bindOverlayDrag(root, { bubble?.layoutParams as? WindowManager.LayoutParams }) { position ->
                fitBubble(position)
                bubble?.let { windows.updateViewLayout(it, position) }
                reflowNotice()
            }
            noticeLabel = TextView(overlayUiContext).apply {
                textSize = 12f
                setTextColor(Color.rgb(86, 57, 49))
                setPadding(dp(14), dp(8), dp(14), dp(8))
                includeFontPadding = false
                gravity = Gravity.CENTER
                maxLines = 4
                ellipsize = TextUtils.TruncateAt.END
            }
            root.addView(noticeLabel, FrameLayout.LayoutParams(-1, -2))
            noticeDots = ThinkingDotsView(overlayUiContext).apply { visibility = View.GONE }
            root.addView(noticeDots, FrameLayout.LayoutParams(-1, dp(34)))
            notice = root
            setNoticeMessage(message)
            val params = WindowManager.LayoutParams(dp(240), -2, WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                    or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT).apply {
                gravity = Gravity.TOP or Gravity.LEFT
            }
            fitNotice(params)
            if (runCatching { windows.addView(root, params) }.isFailure) {
                noticeDots?.stop(); noticeDots = null; notice = null; noticeLabel = null
                Toast.makeText(this, message.take(100), Toast.LENGTH_SHORT).show()
                return
            }
        } else {
            setNoticeMessage(message)
            notice?.visibility = View.VISIBLE
            reflowNotice()
        }
        notice?.contentDescription = "${if (message == "…") "正在看屏幕并思考" else message}。点击收起提示，长按打开完整对话，拖动可移动。"
        if (dismissAfterMs > 0) {
            val dismiss = Runnable { hideNotice() }
            noticeDismiss = dismiss
            handler.postDelayed(dismiss, dismissAfterMs)
        }
    }

    private fun hideNotice() {
        noticeDismiss?.let { handler.removeCallbacks(it) }; noticeDismiss = null
        noticeDots?.stop()
        notice?.visibility = View.GONE
    }

    private fun fitNotice(params: WindowManager.LayoutParams) {
        val root = notice ?: return
        val anchor = bubble?.layoutParams as? WindowManager.LayoutParams
        val segment = if (anchor != null) segmentAt(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2)
            else safeSegments().maxByOrNull { it.width().toLong() * it.height() }!!
        val margin = minOf(dp(6), segment.width() / 12)
        var left = segment.left + margin
        var right = segment.right - margin
        val leftSpace = if (anchor != null) anchor.x - dp(4) - left else 0
        val rightSpace = if (anchor != null) right - anchor.x - anchor.width - dp(4) else 0
        val beside = anchor != null && maxOf(leftSpace, rightSpace) >= dp(120)
        if (beside && anchor != null) {
            if (leftSpace >= rightSpace) right = anchor.x - dp(4)
            else left = anchor.x + anchor.width + dp(4)
        }
        val availableWidth = maxOf(1, right - left)
        val label = noticeLabel
        val firstLineWidth = if (label == null) 0 else label.text.toString().lineSequence()
            .map { label.paint.measureText(it) }.maxOrNull()?.toInt() ?: 0
        params.width = minOf(availableWidth, dp(280), maxOf(dp(120), firstLineWidth + dp(48)))
        root.measure(View.MeasureSpec.makeMeasureSpec(params.width, View.MeasureSpec.EXACTLY),
            View.MeasureSpec.makeMeasureSpec(maxOf(1, minOf(dp(160), segment.height())), View.MeasureSpec.AT_MOST))
        params.height = maxOf(1, root.measuredHeight)
        params.x = (segment.centerX() - params.width / 2).coerceIn(left, maxOf(left, right - params.width))
        val centerY = anchor?.let { it.y + it.height / 2 } ?: segment.centerY()
        val preferredY = if (beside || anchor == null) centerY - params.height / 2
            else if (anchor.y - params.height - dp(4) >= segment.top) anchor.y - params.height - dp(4)
            else anchor.y + anchor.height + dp(4)
        params.y = preferredY.coerceIn(segment.top, maxOf(segment.top, segment.bottom - params.height))
    }

    private fun reflowNotice() {
        notice?.let { root ->
            val params = root.layoutParams as? WindowManager.LayoutParams ?: return@let
            fitNotice(params)
            if (root.isAttachedToWindow) runCatching { windows.updateViewLayout(root, params) }
        }
    }

    private fun button(label: String, action: () -> Unit) = Button(overlayUiContext).apply {
        text = label; textSize = 13f; isAllCaps = false; minWidth = 0; minimumWidth = 0
        setOnClickListener { action() }
    }

    private fun showPanel() {
        if (destroyed) return
        hideNotice()
        panel?.let {
            it.visibility = View.VISIBLE
            setPanelFocusable(true)
            it.post { if (!destroyed && it.visibility == View.VISIBLE) registerPanelBack(it) }
            reflowOverlays()
            return
        }
        val root = object : LinearLayout(overlayUiContext) {
            override fun dispatchKeyEvent(event: KeyEvent): Boolean {
                if (event.keyCode == KeyEvent.KEYCODE_BACK) {
                    if (event.action == KeyEvent.ACTION_UP && !event.isCanceled) handlePanelBack()
                    return true
                }
                return super.dispatchKeyEvent(event)
            }
        }.apply {
            orientation = LinearLayout.VERTICAL; setPadding(dp(12), dp(8), dp(12), dp(12))
            background = background(Color.rgb(255, 248, 251), 18f)
            elevation = dp(8).toFloat()
            isFocusableInTouchMode = true
        }
        val header = LinearLayout(overlayUiContext).apply { gravity = Gravity.CENTER_VERTICAL }
        val dragHandle = TextView(overlayUiContext).apply {
            text = characterName; textSize = 17f; setTextColor(Color.rgb(77, 43, 62))
            gravity = Gravity.CENTER_VERTICAL
            contentDescription = "${characterName}的对话，拖动此处移动窗口"
        }
        header.addView(dragHandle, LinearLayout.LayoutParams(0, -2, 1f))
        header.addView(button("收起") { hidePanel() })
        header.addView(button("×") { stopSelf() })
        root.addView(header)
        root.addView(button("‹ 返回寻信桌面") { returnToDesktop() }, LinearLayout.LayoutParams(-1, dp(44)))
        transcript = TextView(overlayUiContext).apply { textSize = 15f; setTextColor(Color.rgb(64, 48, 60)); setTextIsSelectable(true); text = conversationText.ifBlank { conversationHint() } }
        scroll = ScrollView(overlayUiContext).apply { addView(transcript) }
        root.addView(scroll, LinearLayout.LayoutParams(-1, 0, 1f))
        readButton = button("看看当前屏幕") { requestScreen("") }
        root.addView(readButton)
        voiceControls = LinearLayout(overlayUiContext).apply { gravity = Gravity.CENTER_VERTICAL }
        voicePlayButton = button("重播语音") { replayVoice() }
        voiceStopButton = button("停止语音") { stopVoice() }
        voiceControls?.addView(voicePlayButton, LinearLayout.LayoutParams(0, dp(44), 1f))
        voiceControls?.addView(voiceStopButton, LinearLayout.LayoutParams(0, dp(44), 1f))
        root.addView(voiceControls)
        updateVoiceControls()
        val row = LinearLayout(overlayUiContext).apply { gravity = Gravity.CENTER_VERTICAL }
        input = EditText(overlayUiContext).apply { hint = "想跟他说什么…"; textSize = 14f; maxLines = 3; setTextColor(Color.rgb(64, 48, 60)) }
        row.addView(input, LinearLayout.LayoutParams(0, -2, 1f))
        sendButton = button("发送") {
            val text = input?.text?.toString()?.trim().orEmpty()
            if (text.isNotBlank()) { input?.setText(""); requestScreen(text) }
        }
        row.addView(sendButton)
        root.addView(row)
        val params = WindowManager.LayoutParams(
            dp(340), dp(430), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT).apply {
            gravity = Gravity.TOP or Gravity.LEFT
            softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE
        }
        panelMovedByUser = false
        fitPanel(params)
        windows.addView(root, params)
        panel = root
        bindOverlayDrag(dragHandle, { params }) { position ->
            panelMovedByUser = true
            fitPanel(position)
            windows.updateViewLayout(root, position)
        }
        root.requestFocus()
        root.post { if (!destroyed && root.visibility == View.VISIBLE) registerPanelBack(root) }
        ViewCompat.setOnApplyWindowInsetsListener(root) { _, insets ->
            val next = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            if (next != imeBottom) {
                imeBottom = next
                root.post { if (!destroyed) reflowOverlays() }
            }
            insets
        }
        ViewCompat.requestApplyInsets(root)
        updateBusy()
    }

    private fun safeSegments(): List<Rect> {
        val frame = overlayDisplayFrame(windows)
        val metrics = if (Build.VERSION.SDK_INT >= 30) windows.currentWindowMetrics else null
        val area = if (Build.VERSION.SDK_INT >= 30) metrics!!.bounds else frame.bounds
        val width = area.width().coerceAtLeast(1)
        val height = area.height().coerceAtLeast(1)
        val full = Rect(0, 0, width, height)
        if (Build.VERSION.SDK_INT >= 30) {
            val insets = metrics!!.windowInsets.getInsetsIgnoringVisibility(
                WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            full.set(insets.left.coerceIn(0, width - 1), insets.top.coerceIn(0, height - 1),
                (width - insets.right).coerceIn(1, width), (height - insets.bottom).coerceIn(1, height))
        } else {
            val statusId = resources.getIdentifier("status_bar_height", "dimen", "android")
            val navId = resources.getIdentifier("navigation_bar_height", "dimen", "android")
            full.top = if (statusId > 0) resources.getDimensionPixelSize(statusId) else dp(24)
            full.bottom = maxOf(full.top + 1, height - if (navId > 0) resources.getDimensionPixelSize(navId) else dp(24))
        }
        full.bottom = minOf(full.bottom, maxOf(full.top + 1, height - imeBottom))
        if (full.isEmpty) return listOf(Rect(0, 0, width, height))
        val snapshot = foldSnapshot?.inFrame(frame) ?: return listOf(full)
        // WindowContext LayoutParams are local to the current display area, not the maximum display.
        val hinge = snapshot.bounds?.let { Rect(it).apply { offset(-area.left, -area.top) } } ?: return listOf(full)
        val parts = when {
            snapshot.orientation == "vertical" -> listOf(
                Rect(full.left, full.top, minOf(full.right, hinge.left), full.bottom), Rect(maxOf(full.left, hinge.right), full.top, full.right, full.bottom))
            snapshot.orientation == "horizontal" -> listOf(
                Rect(full.left, full.top, full.right, minOf(full.bottom, hinge.top)), Rect(full.left, maxOf(full.top, hinge.bottom), full.right, full.bottom))
            else -> listOf(full)
        }
        // Never fall back across a known hinge just because both remaining segments are narrow.
        return parts.filter { it.width() > 0 && it.height() > 0 }.ifEmpty { listOf(full) }
    }

    private fun segmentAt(x: Int, y: Int): Rect = safeSegments().minByOrNull {
        val dx = maxOf(it.left - x, 0, x - it.right).toLong()
        val dy = maxOf(it.top - y, 0, y - it.bottom).toLong()
        dx * dx + dy * dy
    }!!

    private fun fitBubble(params: WindowManager.LayoutParams) {
        val segment = segmentAt(params.x + params.width / 2, params.y + params.height / 2)
        params.gravity = Gravity.TOP or Gravity.LEFT
        params.width = minOf(bubbleSize(), segment.width())
        params.height = minOf(bubbleSize(), segment.height())
        params.x = params.x.coerceIn(segment.left, maxOf(segment.left, segment.right - params.width))
        params.y = params.y.coerceIn(segment.top, maxOf(segment.top, segment.bottom - params.height))
    }

    private fun fitPanel(params: WindowManager.LayoutParams) {
        val bubbleParams = bubble?.layoutParams as? WindowManager.LayoutParams
        val segment = if (panelMovedByUser) segmentAt(params.x + params.width / 2, params.y + params.height / 2)
            else if (bubbleParams != null) segmentAt(bubbleParams.x + bubbleParams.width / 2, bubbleParams.y + bubbleParams.height / 2)
            else safeSegments().maxByOrNull { it.width().toLong() * it.height() }!!
        val margin = minOf(dp(12), minOf(segment.width(), segment.height()) / 8)
        params.gravity = Gravity.TOP or Gravity.LEFT
        params.width = minOf(dp(340), maxOf(1, segment.width() - margin * 2))
        params.height = minOf(dp(430), maxOf(1, segment.height() - margin * 2))
        if (panelMovedByUser) {
            params.x = params.x.coerceIn(segment.left + margin, maxOf(segment.left + margin, segment.right - margin - params.width))
            params.y = params.y.coerceIn(segment.top + margin, maxOf(segment.top + margin, segment.bottom - margin - params.height))
        } else {
            params.x = segment.left + (segment.width() - params.width) / 2
            params.y = segment.bottom - margin - params.height
        }
    }

    private fun reflowOverlays() {
        bubble?.let { view ->
            val params = view.layoutParams as WindowManager.LayoutParams
            fitBubble(params)
            if (view.isAttachedToWindow) runCatching { windows.updateViewLayout(view, params) }
        }
        panel?.let { view ->
            val params = view.layoutParams as WindowManager.LayoutParams
            fitPanel(params)
            if (view.isAttachedToWindow) runCatching { windows.updateViewLayout(view, params) }
        }
        reflowNotice()
    }

    fun onFoldChanged(snapshot: OverlayFoldSnapshot?) {
        if (snapshot == null || independentFoldReady && snapshot.observedAtNanos <= lastFoldObservationNanos) return
        val compatible = runCatching { snapshot.inFrame(overlayDisplayFrame(windows)) }.getOrNull() ?: return
        runCatching { applyFoldGeometry(compatible) }
    }

    private fun applyFoldGeometry(snapshot: OverlayFoldSnapshot): Boolean {
        // A cached Activity update must not resurrect a hinge cleared by a newer observation.
        if (snapshot.observedAtNanos < lastFoldObservationNanos) return false
        lastFoldObservationNanos = snapshot.observedAtNanos
        foldSnapshot = snapshot
        val cached = MainActivity.currentOverlayFold
        if (cached == null || cached.observedAtNanos <= snapshot.observedAtNanos) MainActivity.currentOverlayFold = snapshot
        reflowOverlays()
        return true
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        foldMonitor.configurationChanged()
    }

    private fun reconcileDisplayConfiguration() {
        (bubble?.layoutParams as? WindowManager.LayoutParams)?.let { params ->
            params.width = bubbleSize()
            params.height = bubbleSize()
        }
        if (compactCompanion()) {
            notice?.setPadding(dp(10), dp(10), dp(10), dp(10))
            noticeLabel?.setPadding(dp(14), dp(8), dp(14), dp(8))
            noticeDots?.let { dots -> dots.layoutParams = dots.layoutParams.apply { height = dp(34) }; dots.invalidate() }
        }
        foldSnapshot = foldSnapshot?.inFrame(overlayDisplayFrame(windows))
        imeBottom = 0
        reflowOverlays()
        panel?.let { ViewCompat.requestApplyInsets(it) }
    }

    private fun hidePanel() {
        panel?.windowToken?.let { (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(it, 0) }
        unregisterPanelBack?.invoke(); unregisterPanelBack = null
        input?.clearFocus()
        setPanelFocusable(false)
        panel?.visibility = View.GONE
    }

    private fun setPanelFocusable(focusable: Boolean) {
        val root = panel ?: return
        val params = root.layoutParams as? WindowManager.LayoutParams ?: return
        params.flags = if (focusable) params.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv()
            else params.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
        windows.updateViewLayout(root, params)
        if (focusable) root.requestFocus()
    }

    private fun registerPanelBack(root: View) {
        if (Build.VERSION.SDK_INT < 33) return
        unregisterPanelBack?.invoke(); unregisterPanelBack = null
        val dispatcher = root.findOnBackInvokedDispatcher() ?: return
        val callback = OnBackInvokedCallback { handlePanelBack() }
        dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_OVERLAY, callback)
        unregisterPanelBack = { dispatcher.unregisterOnBackInvokedCallback(callback) }
    }

    private fun handlePanelBack() {
        val root = panel ?: return
        if (root.visibility != View.VISIBLE) return
        if (ViewCompat.getRootWindowInsets(root)?.isVisible(WindowInsetsCompat.Type.ime()) == true) {
            (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(root.windowToken, 0)
            input?.clearFocus()
            root.requestFocus()
            return
        }
        returnToDesktop()
    }

    private fun desktopIntent() = Intent(this, MainActivity::class.java)
        .setAction("$packageName.RETURN_FROM_COMPANION")
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        .putExtra(MainActivity.EXTRA_RETURN_TO_DESKTOP, true)

    private fun returnToDesktop() {
        runCatching { startActivity(desktopIntent()) }
            .onSuccess { hidePanel(); stopSelf() }
            .onFailure { Toast.makeText(this, "无法返回寻信，请从最近任务打开寻信", Toast.LENGTH_SHORT).show() }
    }

    private fun updateBusy() { readButton?.isEnabled = !busy; sendButton?.isEnabled = !busy; input?.isEnabled = !busy }

    private fun conversationHint() = if (compactCompanion()) "点击悬浮头像看屏幕，长按头像打开完整对话。" else "点击头像，和${characterName}一起看看${appName()}。"

    private fun append(text: String) {
        conversationText = (conversationText.ifBlank { conversationHint() } + "\n\n" + text).takeLast(16000)
        if (!compactCompanion()) showPanel()
        transcript?.text = conversationText
        scroll?.post { scroll?.fullScroll(View.FOCUS_DOWN) }
    }

    private fun requestScreen(text: String) {
        if (busy || destroyed) return
        stopVoice()
        voiceRequestId = null
        voicePlayer.clear()
        val host = MainActivity.companionHost.get()
        if (host == null) { Toast.makeText(this, "请返回小手机重新打开陪伴", Toast.LENGTH_LONG).show(); stopSelf(); return }
        busy = true; updateBusy()
        val id = UUID.randomUUID().toString()
        val deadlineAt = System.currentTimeMillis() + REQUEST_TIMEOUT_MS
        requestId = id
        hidePanel()
        if (compactCompanion()) showNotice("…")
        handler.postDelayed(prepareCapture@{
            if (destroyed || requestId != id) return@prepareCapture
            hideNotice()
            bubble?.visibility = View.INVISIBLE
            // Our name badge, feedback bubble, panel and keyboard must leave the captured frame.
            handler.postDelayed(readScreen@{
                if (destroyed || requestId != id) return@readScreen
                val screenCapture = capture
                if (screenCapture == null) {
                    complete(overlayId, id, "屏幕共享已结束，请重新打开陪伴。", true)
                    return@readScreen
                }
                screenCapture.capture { image, error ->
                    if (destroyed || requestId != id) return@capture
                    bubble?.visibility = View.VISIBLE
                    if (image == null) { complete(overlayId, id, error ?: "没有读到屏幕", true); return@capture }
                    append(if (text.isBlank()) "${characterName}正在看当前屏幕…" else "我：$text\n${characterName}正在看当前屏幕…")
                    if (compactCompanion() && panel?.visibility != View.VISIBLE) showNotice("…")
                    val timeout = Runnable {
                        if (requestId == id) {
                            cancelWebRequest(id)
                            complete(overlayId, id, "回复等待已超时，本轮请求已取消；已发送的内容保留在聊天中。", true)
                        }
                    }
                    requestTimeout = timeout
                    handler.postDelayed(timeout, maxOf(0L, deadlineAt - System.currentTimeMillis()))
                    host.dispatchCompanionEvent("android-companion-screen", JSONObject()
                        .put("overlayId", overlayId).put("requestId", id).put("characterId", characterId)
                        .put("appId", appId).put("imageDataUrl", image).put("text", text).put("deadlineAt", deadlineAt)
                        .put("voiceReplyEnabled", voiceEnabled))
                }
            }, 300)
        }, if (compactCompanion()) 120L else 0L)
    }

    fun complete(session: String, id: String, text: String, isError: Boolean) {
        if (destroyed || session != overlayId || id != requestId) return
        requestTimeout?.let { handler.removeCallbacks(it) }; requestTimeout = null
        requestId = null; busy = false; bubble?.visibility = View.VISIBLE
        if (!isError && voiceEnabled) {
            voiceRequestId = id
            voicePlayer.expect(id)
        }
        append(if (isError) "提示：$text" else "$characterName：$text")
        if (compactCompanion() && panel?.visibility != View.VISIBLE) {
            showNotice(if (isError) "提示：$text" else text, 12000L)
        }
        updateBusy()
    }

    private fun updatePlaybackForeground(playing: Boolean) {
        if (destroyed || !::foregroundNotification.isInitialized) return
        if (Build.VERSION.SDK_INT >= 29) {
            val types = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION or
                (if (playing) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0)
            startForeground(NOTIFICATION_ID, foregroundNotification, types)
        } else startForeground(NOTIFICATION_ID, foregroundNotification)
    }

    private fun updateVoiceControls() {
        if (destroyed || !::voicePlayer.isInitialized) return
        voiceControls?.visibility = if (voiceEnabled) View.VISIBLE else View.GONE
        voicePlayButton?.apply {
            text = when {
                voicePlayer.state == "loading" -> "正在准备语音…"
                voicePlayer.hasAudio -> "重播语音"
                else -> "重试语音"
            }
            isEnabled = voicePlayer.hasReply && voicePlayer.state != "loading" && voicePlayer.state != "playing"
        }
        voiceStopButton?.isEnabled = voicePlayer.state == "loading" || voicePlayer.state == "playing"
    }

    private fun dispatchVoiceStop() {
        voiceRequestId?.let { id ->
            MainActivity.companionHost.get()?.dispatchCompanionEvent("android-companion-voice-stop", JSONObject()
                .put("overlayId", overlayId).put("requestId", id))
        }
    }

    private fun stopVoice() {
        dispatchVoiceStop()
        if (::voicePlayer.isInitialized) voicePlayer.stop()
    }

    private fun replayVoice() {
        val id = voiceRequestId ?: return
        if (!voiceEnabled || destroyed) return
        if (voicePlayer.hasAudio) voicePlayer.play()
        else {
            voicePlayer.expect(id)
            MainActivity.companionHost.get()?.dispatchCompanionEvent("android-companion-voice-retry", JSONObject()
                .put("overlayId", overlayId).put("requestId", id))
        }
    }

    fun setVoiceEnabled(targetApp: String, enabled: Boolean) {
        if (destroyed || targetApp != appId) return
        voiceEnabled = enabled
        if (!enabled) {
            stopVoice()
            voiceRequestId = null
            voicePlayer.clear()
        }
        if (::foregroundNotification.isInitialized) {
            val builder = Notification.Builder.recoverBuilder(this, foregroundNotification).setActions()
            val close = PendingIntent.getService(this, 0, Intent(this, CompanionOverlayService::class.java).setAction(ACTION_CLOSE),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
            builder.addAction(0, "关闭陪伴", close)
            if (enabled) {
                val stopAudio = PendingIntent.getService(this, 1,
                    Intent(this, CompanionOverlayService::class.java).setAction(ACTION_STOP_VOICE),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                builder.addAction(0, "停止语音", stopAudio)
            }
            foregroundNotification = builder.build()
            updatePlaybackForeground(voicePlayer.state == "playing")
        }
        updateVoiceControls()
    }

    private fun acceptsVoice(session: String, id: String) =
        !destroyed && voiceEnabled && session == overlayId && id == voiceRequestId

    fun beginAudio(session: String, id: String, length: Int) {
        if (acceptsVoice(session, id)) voicePlayer.begin(id, length)
    }

    fun appendAudio(session: String, id: String, chunk: String) {
        if (acceptsVoice(session, id)) voicePlayer.append(id, chunk)
    }

    fun finishAudio(session: String, id: String) {
        if (acceptsVoice(session, id)) voicePlayer.finish(id)
    }

    fun failAudio(session: String, id: String, message: String) {
        if (acceptsVoice(session, id)) voicePlayer.fail(id, message)
    }

    private fun cancelWebRequest(id: String) {
        MainActivity.companionHost.get()?.dispatchCompanionEvent("android-companion-cancel", JSONObject()
            .put("overlayId", overlayId).put("requestId", id))
    }

    fun setAvatar(session: String, dataUrl: String) {
        if (destroyed || session != overlayId) return
        if (dataUrl.isEmpty()) { avatar?.setImageDrawable(null); initial?.visibility = View.VISIBLE; return }
        if (!dataUrl.startsWith("data:image/png;base64,") || dataUrl.length > 200000) return
        runCatching {
            val bytes = Base64.decode(dataUrl.substringAfter(','), Base64.DEFAULT)
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
            avatar?.setImageBitmap(bitmap); initial?.visibility = View.GONE
        }
    }

    override fun onDestroy() {
        requestId?.let { cancelWebRequest(it) }
        stopVoice()
        requestId = null
        destroyed = true
        voicePlayer.close()
        runCatching { unregisterReceiver(noisyReceiver) }
        unregisterPanelBack?.invoke(); unregisterPanelBack = null
        if (::foldMonitor.isInitialized) foldMonitor.close()
        handler.removeCallbacksAndMessages(null)
        capture?.close(); capture = null
        noticeDots?.stop(); noticeDots = null
        notice?.let { runCatching { windows.removeView(it) } }; notice = null; noticeLabel = null; noticeDismiss = null
        panel?.let { runCatching { windows.removeView(it) } }; panel = null
        bubble?.let { runCatching { windows.removeView(it) } }; bubble = null
        if (current === this) current = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "companion_screen_overlay"
        private const val NOTIFICATION_ID = 8204
        private const val REQUEST_TIMEOUT_MS = 180000L
        private const val ACTION_CLOSE = "app.floatphone.shell.CLOSE_COMPANION"
        private const val ACTION_STOP_VOICE = "app.floatphone.shell.STOP_COMPANION_VOICE"
        var current: CompanionOverlayService? = null
            private set
        fun targetPackage(appId: String): String? = when (appId) {
            "xiaohongshu" -> "com.xingin.xhs"
            "douyin" -> "com.ss.android.ugc.aweme"
            else -> null
        }
    }
}
