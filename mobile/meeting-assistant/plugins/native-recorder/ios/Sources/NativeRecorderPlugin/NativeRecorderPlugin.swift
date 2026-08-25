import AVFoundation
import Capacitor
import Foundation

@objc(NativeRecorderPlugin)
public class NativeRecorderPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeRecorderPlugin"
    public let jsName = "NativeRecorder"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listPending", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "readChunk", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markUploaded", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "markUploadFailed", returnType: CAPPluginReturnPromise)
    ]

    private let iso = ISO8601DateFormatter()
    private var recorder: AVAudioRecorder?
    private var currentId: String?
    private var interruptionObserver: NSObjectProtocol?
    private var routeObserver: NSObjectProtocol?
    private var checkpointTimer: Timer?

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": true])
    }

    @objc func start(_ call: CAPPluginCall) {
        if recorder?.isRecording == true {
            call.reject("already_recording")
            return
        }

        let recordingId = call.getString("recordingId") ?? UUID().uuidString
        let fileName = call.getString("fileName") ?? "recording.m4a"

        do {
            try configureSession()
            let audioURL = try audioURL(for: recordingId)
            let recorder = try AVAudioRecorder(url: audioURL, settings: [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44100,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64000,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
            ])
            recorder.isMeteringEnabled = false
            if !recorder.record() {
                call.reject("recorder_start_failed")
                return
            }

            self.recorder = recorder
            self.currentId = recordingId

            var checkpoint = CheckpointStore.blank(
                recordingId: recordingId,
                fileName: fileName,
                localPath: audioURL.path,
                organization: call.getString("organization") ?? "",
                personName: call.getString("personName") ?? "",
                kind: call.getString("kind") ?? ""
            )
            checkpoint.state = "RECORDING"
            try CheckpointStore.write(checkpoint)
            listenForInterruptions()
            startCheckpointTimer()

            call.resolve([
                "recordingId": recordingId,
                "fileName": fileName,
                "path": audioURL.path,
                "state": "RECORDING",
                "startedAt": checkpoint.startedAt
            ])
        } catch {
            call.reject("start_failed", error.localizedDescription, error)
        }
    }

    @objc func stop(_ call: CAPPluginCall) {
        guard let recorder, let recordingId = currentId else {
            call.reject("not_recording")
            return
        }

        recorder.stop()
        let duration = recorder.currentTime
        let path = recorder.url.path
        let size = (try? FileManager.default.attributesOfItem(atPath: path)[.size] as? NSNumber)?.int64Value ?? 0
        self.recorder = nil
        self.currentId = nil
        stopCheckpointTimer()
        removeObservers()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)

        do {
            var checkpoint = try CheckpointStore.read(recordingId: recordingId)
            checkpoint.state = "SAVED_LOCAL"
            checkpoint.driveUploadState = "pending"
            checkpoint.sizeBytes = size
            checkpoint.durationSeconds = duration
            checkpoint.lastCheckpointAt = iso.string(from: Date())
            checkpoint.error = ""
            try CheckpointStore.write(checkpoint)
            call.resolve(checkpoint.asJS())
        } catch {
            call.resolve([
                "recordingId": recordingId,
                "path": path,
                "localPath": path,
                "sizeBytes": size,
                "durationSeconds": duration,
                "state": "SAVED_LOCAL",
                "mimeType": "audio/mp4"
            ])
        }
    }

    @objc func getStatus(_ call: CAPPluginCall) {
        if let recorder, let recordingId = currentId, recorder.isRecording {
            let started = (try? CheckpointStore.read(recordingId: recordingId).startedAt) ?? iso.string(from: Date())
            let elapsed = elapsedSeconds(startedAt: started)
            call.resolve([
                "state": "RECORDING",
                "recordingId": recordingId,
                "startedAt": started,
                "elapsedSeconds": elapsed,
                "recording": true
            ])
            return
        }

        if let recordingId = currentId {
            if let checkpoint = try? CheckpointStore.read(recordingId: recordingId) {
                call.resolve(checkpoint.asJS())
                return
            }
        }

        call.resolve(["state": "IDLE", "elapsedSeconds": 0, "recording": false])
    }

    @objc func listPending(_ call: CAPPluginCall) {
        let items = (try? CheckpointStore.listPending()) ?? []
        call.resolve(["items": items.map { $0.asJS() }])
    }

    @objc func readChunk(_ call: CAPPluginCall) {
        guard let path = call.getString("path") else {
            call.reject("missing_path")
            return
        }

        let offset = call.getInt("offset") ?? 0
        let size = call.getInt("size") ?? 0

        do {
            let handle = try FileHandle(forReadingFrom: URL(fileURLWithPath: path))
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(max(0, offset)))
            let data = handle.readData(ofLength: max(0, size))
            call.resolve(["data": data.base64EncodedString(), "bytes": data.count])
        } catch {
            call.reject("read_failed", error.localizedDescription, error)
        }
    }

    @objc func markUploaded(_ call: CAPPluginCall) {
        guard let recordingId = call.getString("recordingId") else {
            call.reject("missing_id")
            return
        }

        do {
            var checkpoint = try CheckpointStore.read(recordingId: recordingId)
            checkpoint.state = "UPLOADED"
            checkpoint.driveUploadState = "uploaded"
            checkpoint.driveFileId = call.getString("driveFileId") ?? ""
            checkpoint.driveUrl = call.getString("driveUrl") ?? ""
            checkpoint.error = ""
            checkpoint.lastCheckpointAt = iso.string(from: Date())
            try CheckpointStore.write(checkpoint)
            call.resolve(checkpoint.asJS())
        } catch {
            call.reject("checkpoint_failed", error.localizedDescription, error)
        }
    }

    @objc func markUploadFailed(_ call: CAPPluginCall) {
        guard let recordingId = call.getString("recordingId") else {
            call.reject("missing_id")
            return
        }

        do {
            var checkpoint = try CheckpointStore.read(recordingId: recordingId)
            checkpoint.state = "UPLOAD_FAILED"
            checkpoint.driveUploadState = "failed"
            checkpoint.error = call.getString("error") ?? ""
            checkpoint.lastCheckpointAt = iso.string(from: Date())
            try CheckpointStore.write(checkpoint)
            call.resolve(checkpoint.asJS())
        } catch {
            call.reject("checkpoint_failed", error.localizedDescription, error)
        }
    }

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetooth])
        try session.setActive(true, options: [])
    }

    private func listenForInterruptions() {
        removeObservers()
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] notification in
            self?.handleInterruption(notification)
        }
        routeObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance(),
            queue: .main
        ) { [weak self] _ in
            self?.persistCheckpoint(state: nil)
        }
    }

    private func handleInterruption(_ notification: Notification) {
        guard let recorder, let recordingId = currentId else {
            return
        }

        let typeValue = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
        let type = typeValue.flatMap(AVAudioSession.InterruptionType.init(rawValue:))

        if type == .began {
            persistCheckpoint(state: "INTERRUPTED")
            notifyListeners("statechange", data: ["state": "INTERRUPTED", "recordingId": recordingId])
            return
        }

        let optionsValue = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
        let options = AVAudioSession.InterruptionOptions(rawValue: optionsValue)
        if options.contains(.shouldResume), recorder.record() {
            persistCheckpoint(state: "RECORDING")
            notifyListeners("statechange", data: ["state": "RECORDING", "recordingId": recordingId])
            return
        }

        recorder.stop()
        persistCheckpoint(state: "SAVED_LOCAL")
        notifyListeners("statechange", data: ["state": "SAVED_LOCAL", "recordingId": recordingId])
    }

    private func persistCheckpoint(state: String?) {
        guard let recordingId = currentId else {
            return
        }

        do {
            var checkpoint = try CheckpointStore.read(recordingId: recordingId)
            if let state {
                checkpoint.state = state
                if state == "SAVED_LOCAL" {
                    checkpoint.driveUploadState = "pending"
                }
            }
            if let recorder {
                checkpoint.durationSeconds = recorder.currentTime
                checkpoint.sizeBytes = (try? FileManager.default.attributesOfItem(atPath: recorder.url.path)[.size] as? NSNumber)?.int64Value ?? checkpoint.sizeBytes
            }
            checkpoint.lastCheckpointAt = iso.string(from: Date())
            try CheckpointStore.write(checkpoint)
        } catch {
            /* 録音継続を優先し、checkpoint 失敗では止めない。 */
        }
    }

    private func startCheckpointTimer() {
        stopCheckpointTimer()
        checkpointTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in
            self?.persistCheckpoint(state: nil)
        }
    }

    private func stopCheckpointTimer() {
        checkpointTimer?.invalidate()
        checkpointTimer = nil
    }

    private func removeObservers() {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
            self.interruptionObserver = nil
        }
        if let routeObserver {
            NotificationCenter.default.removeObserver(routeObserver)
            self.routeObserver = nil
        }
    }

    private func audioURL(for recordingId: String) throws -> URL {
        try CheckpointStore.recordingsDir().appendingPathComponent("\(recordingId).m4a")
    }

    private func elapsedSeconds(startedAt: String) -> Int {
        guard let date = iso.date(from: startedAt) else {
            return 0
        }
        return max(0, Int(Date().timeIntervalSince(date)))
    }

    deinit {
        stopCheckpointTimer()
        removeObservers()
    }
}

struct Checkpoint: Codable {
    var recordingId: String
    var startedAt: String
    var state: String
    var localPath: String
    var fileName: String
    var organization: String
    var personName: String
    var kind: String
    var lastCheckpointAt: String
    var driveUploadState: String
    var sizeBytes: Int64
    var durationSeconds: TimeInterval
    var driveFileId: String
    var driveUrl: String
    var error: String

    func asJS() -> JSObject {
        [
            "recordingId": recordingId,
            "startedAt": startedAt,
            "state": state,
            "localPath": localPath,
            "path": localPath,
            "fileName": fileName,
            "organization": organization,
            "personName": personName,
            "kind": kind,
            "lastCheckpointAt": lastCheckpointAt,
            "driveUploadState": driveUploadState,
            "sizeBytes": sizeBytes,
            "durationSeconds": durationSeconds,
            "driveFileId": driveFileId,
            "driveUrl": driveUrl,
            "error": error,
            "mimeType": "audio/mp4"
        ]
    }
}

enum CheckpointStore {
    static func recordingsDir() throws -> URL {
        let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let dir = docs.appendingPathComponent("recordings", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    static func url(for recordingId: String) throws -> URL {
        try recordingsDir().appendingPathComponent("\(recordingId).checkpoint.json")
    }

    static func blank(
        recordingId: String,
        fileName: String,
        localPath: String,
        organization: String,
        personName: String,
        kind: String
    ) -> Checkpoint {
        let now = ISO8601DateFormatter().string(from: Date())
        return Checkpoint(
            recordingId: recordingId,
            startedAt: now,
            state: "RECORDING",
            localPath: localPath,
            fileName: fileName,
            organization: organization,
            personName: personName,
            kind: kind,
            lastCheckpointAt: now,
            driveUploadState: "none",
            sizeBytes: 0,
            durationSeconds: 0,
            driveFileId: "",
            driveUrl: "",
            error: ""
        )
    }

    static func write(_ checkpoint: Checkpoint) throws {
        let data = try JSONEncoder().encode(checkpoint)
        try data.write(to: url(for: checkpoint.recordingId), options: .atomic)
    }

    static func read(recordingId: String) throws -> Checkpoint {
        let data = try Data(contentsOf: url(for: recordingId))
        return try JSONDecoder().decode(Checkpoint.self, from: data)
    }

    static func listPending() throws -> [Checkpoint] {
        let dir = try recordingsDir()
        let files = try FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)
        return files
            .filter { $0.lastPathComponent.hasSuffix(".checkpoint.json") }
            .compactMap { try? JSONDecoder().decode(Checkpoint.self, from: Data(contentsOf: $0)) }
            .filter { $0.state != "UPLOADED" && $0.state != "IDLE" }
    }
}
