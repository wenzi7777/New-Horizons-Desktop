# SK6812 ステータス LED リファレンス

オンボード SK6812 LED（GPIO 11）はリアルタイムのシステム状態フィードバックを提供します。各状態は特定の色とアニメーションパターンに対応しています。

## アニメーションパターン

| パターン | 説明 |
|---------|------|
| `Off` | LED は完全に消灯 |
| `Solid` | 一定の点灯 |
| `Breathe` | ゆっくりフェードイン・アウト |
| `BlinkBurst` | 短い点滅を連続した後、休止 |
| `AlternateBurst` | 2 つの状態を交互にバースト |

## カラーパレット（RGB）

| 名前 | R | G | B | 外観 |
|------|---|---|---|------|
| Off | 0 | 0 | 0 | 消灯 |
| Boot | 0 | 0 | 16 | 暗い青 |
| WifiSetup | 32 | 9 | 0 | 琥珀色 |
| WifiConnecting | 24 | 18 | 0 | 黄琥珀 |
| FindMePending | 0 | 18 | 24 | シアン |
| Online | 0 | 24 | 0 | 緑 |
| Maintenance | 32 | 18 | 0 | オレンジ |
| SafeMode | 32 | 0 | 32 | マゼンタ |
| Ota | 0 | 18 | 24 | シアン |
| Error | 32 | 0 | 0 | 赤 |
| Warning | 28 | 18 | 0 | 黄オレンジ |
| White | 24 | 24 | 24 | ニュートラルホワイト |
| ChargeDone | 57 | 197 | 187 | ティール |

## 状態リファレンス

| シグナル | 色 | パターン | 間隔 | 意味 |
|---------|-----|---------|------|------|
| `Boot` | 暗い青 | Breathe | 2200 ms | 起動時にファームウェアが初期化中 |
| `WifiSetup` | 琥珀色 | Breathe | 1800 ms | WiFi セットアップポータル（`newhorizons.os`）が起動中 |
| `WifiConnecting` | 黄琥珀 | Breathe | 1800 ms | 保存済み WiFi ネットワークへの接続を試みている |
| `FindMePending` | シアン | Breathe | 1500 ms | WiFi 接続済み、ゲートウェイを探している |
| `Online` | 緑 | Solid | — | 完全動作中、ゲートウェイにストリーミング中 |
| `Maintenance` | オレンジ | Solid | — | メンテナンスモードが有効 |
| `SafeMode` | マゼンタ | Solid | — | セーフメンテナンスモード（起動失敗を繰り返した後に自動移行） |
| `OtaActive` | シアン | Breathe | 1300 ms | OTA ファームウェアのダウンロード中 |
| `OtaSuccess` | 緑 | BlinkBurst | 700 ms · 900 ms | OTA 適用成功、再起動中 |
| `OtaError` | 赤 | Solid | — | OTA ダウンロードまたは検証の失敗 |
| `Error` | 赤 | Solid | — | 回復不能なランタイムエラーまたは起動障害 |
| `ScanWarning` | 黄オレンジ | Breathe | 1200 ms | マトリックススキャンのオーバーランを検出（性能低下中） |
| `RamDanger` | 黄オレンジ | Breathe | 800 ms | 空きヒープが危機的に少ない |
| `ChargingOrMissing` | オレンジ | Solid | — | 充電中、またはバッテリーが未検出 |
| `ChargeDone` | ティール | Solid | — | バッテリーが満充電 |
| `SoftOffTransition` | 白 | 短いパルス後フェード | — | ソフトオフに移行中（シャットダウンアニメーション） |
| `SoftOffCharging` | オレンジ | Solid | — | ソフトオフ状態で充電中 |
| `SoftOffChargeDone` | ティール | Solid | — | ソフトオフ状態、バッテリー満充電 |
| `SoftOffChargeIdle` | Off | — | — | ソフトオフ状態、充電なし |
| `PowerTransitionShutdown` | 白 | フェードアウト | — | ソフトオフ前のシャットダウンアニメーション |
| `PowerTransitionWake` | 白 | ライズ後ハンドオフ | — | ソフトオン後のウェイクアニメーション |
| `CommandReceived` | 白 | 短いフラッシュ | — | 制御コマンドパケットを受信した |
| `CommandSuccess` | 緑 | 短いフラッシュ | — | コマンドが正常に実行された |
| `CommandFailed` | 赤 | 短いフラッシュ | — | コマンドの実行に失敗した |

## 外部 LED ストリップ

外部 WS2812B ストリップ（3 ピクセル、GPIO 12）は独立して動作し、`set_indicators` コマンドでモード（`off`、`on`、`auto`）を設定できます。`auto` モードでは `stream_health` プリセットが UDP ストリームの健全性を Online / Warning / Error の色で表現します。
