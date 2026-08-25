package com.potenitas.meetingassistant.recorder

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import androidx.core.app.NotificationCompat
import java.io.File
import java.time.Instant

class RecordingService : Service() {
    private var recorder: MediaRecorder? = null
    private var checkpoint: Checkpoint? = null
    private var startedElapsedRealtime: Long = 0
    private val handler = Handler(Looper.getMainLooper())
    private var persistCounter = 0
    private val tick = object : Runnable {
        override fun run() {
            persistCounter += 1
            if (persistCounter % 15 == 0) {
                persist(null)
            }
            updateNotification()
            handler.postDelayed(this, 1_000)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopRecording(savedLocal = true)
            stopSelf()
            return START_NOT_STICKY
        }

        val recordingId = intent?.getStringExtra(EXTRA_ID) ?: return START_NOT_STICKY
        val fileName = intent.getStringExtra(EXTRA_NAME) ?: "recording.m4a"
        val output = File(CheckpointStore.dir(filesDir), "$recordingId.m4a")

        val created = Checkpoint.create(
            recordingId = recordingId,
            fileName = fileName,
            localPath = output.absolutePath,
            organization = intent.getStringExtra(EXTRA_ORG) ?: "",
            personName = intent.getStringExtra(EXTRA_PERSON) ?: "",
            kind = intent.getStringExtra(EXTRA_KIND) ?: ""
        )
        checkpoint = created
        CheckpointStore.write(filesDir, created)
        instance = this

        startAsForeground()
        startRecorder(output)
        startedElapsedRealtime = SystemClock.elapsedRealtime()
        handler.post(tick)
        return START_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        if (recorder != null) {
            stopRecording(savedLocal = true)
        }
        if (instance === this) {
            instance = null
        }
        super.onDestroy()
    }

    fun currentStatus(): Map<String, Any> {
        val current = checkpoint ?: return mapOf("state" to "IDLE", "elapsedSeconds" to 0, "recording" to false)
        val elapsed = ((SystemClock.elapsedRealtime() - startedElapsedRealtime) / 1000L).toInt().coerceAtLeast(0)
        return current.toMap() + mapOf(
            "elapsedSeconds" to elapsed,
            "recording" to (current.state == "RECORDING" || current.state == "INTERRUPTED")
        )
    }

    fun stopAndFinalize(): Checkpoint {
        stopRecording(savedLocal = true)
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
        return checkpoint ?: throw IllegalStateException("no_checkpoint")
    }

    fun markInterrupted() {
        persist("INTERRUPTED")
        updateNotification()
    }

    fun markRecording() {
        persist("RECORDING")
        updateNotification()
    }

    private fun startRecorder(output: File) {
        val mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(this)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        mediaRecorder.setAudioSource(MediaRecorder.AudioSource.MIC)
        mediaRecorder.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
        mediaRecorder.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
        mediaRecorder.setAudioSamplingRate(44100)
        mediaRecorder.setAudioEncodingBitRate(64000)
        mediaRecorder.setAudioChannels(1)
        mediaRecorder.setOutputFile(output.absolutePath)
        mediaRecorder.prepare()
        mediaRecorder.start()
        recorder = mediaRecorder
    }

    private fun stopRecording(savedLocal: Boolean) {
        handler.removeCallbacks(tick)
        try {
            recorder?.stop()
        } catch (_: Exception) {
            /* 既に止まっている場合もある。ファイルは残す。 */
        }
        recorder?.release()
        recorder = null
        if (savedLocal) {
            persist("SAVED_LOCAL")
        }
    }

    private fun persist(state: String?) {
        val current = checkpoint ?: return
        state?.let {
            current.state = it
            if (it == "SAVED_LOCAL") {
                current.driveUploadState = "pending"
            }
        }
        current.durationSeconds = ((SystemClock.elapsedRealtime() - startedElapsedRealtime) / 1000.0).coerceAtLeast(0.0)
        current.sizeBytes = File(current.localPath).takeIf { it.exists() }?.length() ?: current.sizeBytes
        current.lastCheckpointAt = Instant.now().toString()
        CheckpointStore.write(filesDir, current)
        checkpoint = current
    }

    private fun startAsForeground() {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Meeting Assistant 録音", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val notification = buildNotification("録音中")
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun updateNotification() {
        val elapsed = ((SystemClock.elapsedRealtime() - startedElapsedRealtime) / 1000L).toInt().coerceAtLeast(0)
        val minutes = elapsed / 60
        val seconds = elapsed % 60
        val text = "録音中  %d:%02d".format(minutes, seconds)
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildNotification(text))
    }

    private fun buildNotification(text: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("Meeting Assistant")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    companion object {
        const val ACTION_STOP = "com.potenitas.meetingassistant.recorder.STOP"
        const val EXTRA_ID = "recordingId"
        const val EXTRA_NAME = "fileName"
        const val EXTRA_ORG = "organization"
        const val EXTRA_PERSON = "personName"
        const val EXTRA_KIND = "kind"
        const val CHANNEL_ID = "meeting-assistant-recording"
        const val NOTIFICATION_ID = 4201

        @Volatile
        var instance: RecordingService? = null

        fun start(context: Context, extras: Map<String, String>) {
            val intent = Intent(context, RecordingService::class.java)
            extras.forEach { (key, value) -> intent.putExtra(key, value) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }
    }
}
