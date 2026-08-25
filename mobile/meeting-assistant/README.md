# Meeting Assistant スマートフォン版

既存 Web UI（`public/meeting-assistant/`）を Capacitor で包み、On-site 録音だけネイティブへ切り替える。

- PC ブラウザ: 現行 AudioWorklet / MP3 / OPFS のまま
- スマートフォン: AVAudioRecorder / Android microphone Foreground Service → ローカル `.m4a`

## まだこのディレクトリだけでは実機に入らない

Linux 上では Xcode / Android Studio のプロジェクト生成と実機 90 分テストは完了しない。次をユーザー環境で行う。

```text
cd mobile/meeting-assistant
npm install
npx cap add ios
npx cap add android
npx cap sync
```

Xcode の Info.plist に追加する:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>対面の打ち合わせを録音し、議事録を作成するためにマイクを使います。</string>
<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

Google Cloud Console の OAuth クライアントに、Capacitor のオリジン（通常 `https://localhost`）を「承認済みの JavaScript 生成元」へ追加する。

## やらないこと

- スマホ Remote 録音
- Gemini API 実テスト
- 本番デプロイ
- PC 版録音方式の変更
