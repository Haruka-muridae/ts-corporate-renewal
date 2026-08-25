package com.potenitas.meetingassistant.recorder

import org.json.JSONObject
import java.io.File
import java.time.Instant
import java.util.UUID

data class Checkpoint(
    var recordingId: String,
    var startedAt: String,
    var state: String,
    var localPath: String,
    var fileName: String,
    var organization: String,
    var personName: String,
    var kind: String,
    var lastCheckpointAt: String,
    var driveUploadState: String,
    var sizeBytes: Long,
    var durationSeconds: Double,
    var driveFileId: String,
    var driveUrl: String,
    var error: String
) {
    fun toMap(): Map<String, Any> = mapOf(
        "recordingId" to recordingId,
        "startedAt" to startedAt,
        "state" to state,
        "localPath" to localPath,
        "path" to localPath,
        "fileName" to fileName,
        "organization" to organization,
        "personName" to personName,
        "kind" to kind,
        "lastCheckpointAt" to lastCheckpointAt,
        "driveUploadState" to driveUploadState,
        "sizeBytes" to sizeBytes,
        "durationSeconds" to durationSeconds,
        "driveFileId" to driveFileId,
        "driveUrl" to driveUrl,
        "error" to error,
        "mimeType" to "audio/mp4"
    )

    fun toJson(): String {
        val json = JSONObject()
        toMap().forEach { (key, value) -> json.put(key, value) }
        return json.toString()
    }

    companion object {
        fun fromJson(raw: String): Checkpoint {
            val json = JSONObject(raw)
            return Checkpoint(
                recordingId = json.optString("recordingId"),
                startedAt = json.optString("startedAt"),
                state = json.optString("state"),
                localPath = json.optString("localPath", json.optString("path")),
                fileName = json.optString("fileName"),
                organization = json.optString("organization"),
                personName = json.optString("personName"),
                kind = json.optString("kind"),
                lastCheckpointAt = json.optString("lastCheckpointAt"),
                driveUploadState = json.optString("driveUploadState"),
                sizeBytes = json.optLong("sizeBytes"),
                durationSeconds = json.optDouble("durationSeconds"),
                driveFileId = json.optString("driveFileId"),
                driveUrl = json.optString("driveUrl"),
                error = json.optString("error")
            )
        }

        fun create(
            recordingId: String = UUID.randomUUID().toString(),
            fileName: String,
            localPath: String,
            organization: String,
            personName: String,
            kind: String
        ): Checkpoint {
            val now = Instant.now().toString()
            return Checkpoint(
                recordingId = recordingId,
                startedAt = now,
                state = "RECORDING",
                localPath = localPath,
                fileName = fileName,
                organization = organization,
                personName = personName,
                kind = kind,
                lastCheckpointAt = now,
                driveUploadState = "none",
                sizeBytes = 0,
                durationSeconds = 0.0,
                driveFileId = "",
                driveUrl = "",
                error = ""
            )
        }
    }
}

object CheckpointStore {
    fun dir(filesDir: File): File {
        val recordings = File(filesDir, "recordings")
        if (!recordings.exists()) {
            recordings.mkdirs()
        }
        return recordings
    }

    fun file(filesDir: File, recordingId: String): File {
        return File(dir(filesDir), "$recordingId.checkpoint.json")
    }

    fun write(filesDir: File, checkpoint: Checkpoint) {
        file(filesDir, checkpoint.recordingId).writeText(checkpoint.toJson())
    }

    fun read(filesDir: File, recordingId: String): Checkpoint {
        return Checkpoint.fromJson(file(filesDir, recordingId).readText())
    }

    fun listPending(filesDir: File): List<Checkpoint> {
        val directory = dir(filesDir)
        val files = directory.listFiles { _, name -> name.endsWith(".checkpoint.json") } ?: return emptyList()
        return files.mapNotNull { file ->
            runCatching { Checkpoint.fromJson(file.readText()) }.getOrNull()
        }.filter { it.state != "UPLOADED" && it.state != "IDLE" }
    }
}
