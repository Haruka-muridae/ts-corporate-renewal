package com.potenitas.meetingassistant.recorder

import android.Manifest
import android.media.AudioManager
import android.os.Build
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.io.RandomAccessFile

@CapacitorPlugin(
    name = "NativeRecorder",
    permissions = [
        Permission(alias = "mic", strings = [Manifest.permission.RECORD_AUDIO]),
        Permission(
            alias = "notifications",
            strings = [Manifest.permission.POST_NOTIFICATIONS]
        )
    ]
)
class NativeRecorderPlugin : Plugin() {
    private var audioFocusListener: AudioManager.OnAudioFocusChangeListener? = null

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val result = JSObject()
        result.put("available", true)
        call.resolve(result)
    }

    @PluginMethod
    fun start(call: PluginCall) {
        if (getPermissionState("mic") != PermissionState.GRANTED) {
            requestPermissionForAlias("mic", call, "micPermission")
            return
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "micPermission")
            return
        }
        beginRecording(call)
    }

    @PermissionCallback
    fun micPermission(call: PluginCall) {
        if (getPermissionState("mic") == PermissionState.GRANTED) {
            beginRecording(call)
        } else {
            call.reject("mic_denied")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        val service = RecordingService.instance
        if (service == null) {
            call.reject("not_recording")
            return
        }
        abandonAudioFocus()
        val checkpoint = service.stopAndFinalize()
        call.resolve(jsFrom(checkpoint.toMap()))
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        val service = RecordingService.instance
        if (service != null) {
            call.resolve(jsFrom(service.currentStatus()))
            return
        }
        call.resolve(JSObject().put("state", "IDLE").put("elapsedSeconds", 0).put("recording", false))
    }

    @PluginMethod
    fun listPending(call: PluginCall) {
        val items = CheckpointStore.listPending(context.filesDir)
        val result = JSObject()
        val array = com.getcapacitor.JSArray()
        items.forEach { array.put(jsFrom(it.toMap())) }
        result.put("items", array)
        call.resolve(result)
    }

    @PluginMethod
    fun readChunk(call: PluginCall) {
        val path = call.getString("path")
        if (path.isNullOrEmpty()) {
            call.reject("missing_path")
            return
        }
        val offset = call.getInt("offset") ?: 0
        val size = call.getInt("size") ?: 0
        RandomAccessFile(path, "r").use { file ->
            val length = minOf(size.toLong(), (file.length() - offset).coerceAtLeast(0)).toInt()
            file.seek(offset.toLong())
            val bytes = ByteArray(length)
            file.readFully(bytes)
            val result = JSObject()
            result.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
            result.put("bytes", bytes.size)
            call.resolve(result)
        }
    }

    @PluginMethod
    fun markUploaded(call: PluginCall) {
        val recordingId = call.getString("recordingId")
        if (recordingId.isNullOrEmpty()) {
            call.reject("missing_id")
            return
        }
        val checkpoint = CheckpointStore.read(context.filesDir, recordingId)
        checkpoint.state = "UPLOADED"
        checkpoint.driveUploadState = "uploaded"
        checkpoint.driveFileId = call.getString("driveFileId") ?: ""
        checkpoint.driveUrl = call.getString("driveUrl") ?: ""
        checkpoint.error = ""
        checkpoint.lastCheckpointAt = java.time.Instant.now().toString()
        CheckpointStore.write(context.filesDir, checkpoint)
        call.resolve(jsFrom(checkpoint.toMap()))
    }

    @PluginMethod
    fun markUploadFailed(call: PluginCall) {
        val recordingId = call.getString("recordingId")
        if (recordingId.isNullOrEmpty()) {
            call.reject("missing_id")
            return
        }
        val checkpoint = CheckpointStore.read(context.filesDir, recordingId)
        checkpoint.state = "UPLOAD_FAILED"
        checkpoint.driveUploadState = "failed"
        checkpoint.error = call.getString("error") ?: ""
        checkpoint.lastCheckpointAt = java.time.Instant.now().toString()
        CheckpointStore.write(context.filesDir, checkpoint)
        call.resolve(jsFrom(checkpoint.toMap()))
    }

    private fun beginRecording(call: PluginCall) {
        if (RecordingService.instance != null) {
            call.reject("already_recording")
            return
        }

        val recordingId = call.getString("recordingId") ?: java.util.UUID.randomUUID().toString()
        val fileName = call.getString("fileName") ?: "recording.m4a"
        requestAudioFocus()
        RecordingService.start(
            context,
            mapOf(
                RecordingService.EXTRA_ID to recordingId,
                RecordingService.EXTRA_NAME to fileName,
                RecordingService.EXTRA_ORG to (call.getString("organization") ?: ""),
                RecordingService.EXTRA_PERSON to (call.getString("personName") ?: ""),
                RecordingService.EXTRA_KIND to (call.getString("kind") ?: "")
            )
        )

        val result = JSObject()
        result.put("recordingId", recordingId)
        result.put("fileName", fileName)
        result.put("state", "RECORDING")
        call.resolve(result)
    }

    private fun requestAudioFocus() {
        val manager = context.getSystemService(AudioManager::class.java)
        val listener = AudioManager.OnAudioFocusChangeListener { focus ->
            val service = RecordingService.instance ?: return@OnAudioFocusChangeListener
            when (focus) {
                AudioManager.AUDIOFOCUS_LOSS,
                AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> service.markInterrupted()
                AudioManager.AUDIOFOCUS_GAIN -> service.markRecording()
            }
        }
        audioFocusListener = listener
        @Suppress("DEPRECATION")
        manager.requestAudioFocus(listener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN)
    }

    private fun abandonAudioFocus() {
        val listener = audioFocusListener ?: return
        val manager = context.getSystemService(AudioManager::class.java)
        @Suppress("DEPRECATION")
        manager.abandonAudioFocus(listener)
        audioFocusListener = null
    }

    private fun jsFrom(map: Map<String, Any>): JSObject {
        val obj = JSObject()
        map.forEach { (key, value) -> obj.put(key, value) }
        return obj
    }
}
