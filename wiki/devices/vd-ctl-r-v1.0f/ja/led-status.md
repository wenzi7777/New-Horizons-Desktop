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

外部 WS2812B ストリップ（3 ピクセル、GPIO 12）はオンボード SK6812 ステータス LED とは独立して動作します。設定は `set_indicators.external_led` で行い、モードは `off` / `enabled` のみです。

| 項目 | デフォルト | オプション / 範囲 | 説明 |
|------|-----------|-------------------|------|
| `mode` | `"off"` | `off`, `enabled` | ストリップを消灯するか、選択したプリセットを動かします |
| `preset` | `"system_status"` | `system_status`, `connectivity`, `pressure_meter`, `stream_heartbeat`, `calibration_auto`, `solid_marker`, `identify`, `off` | ストリップの表示動作を選びます |
| `color` | `"teal"` | `teal`, `green`, `blue`, `purple`, `amber`, `red`, `white` | `solid_marker` で使うマーカー色です |
| `brightness` | `0.35` | `0.0`–`1.0` | ストリップ全体の輝度です |

### プリセット一覧

| プリセット | 動作 | 補足 |
|-----------|------|------|
| `system_status` | 3 ピクセル全体を 1 つの状態灯として使います。`Error` / `OtaError` / `RamDanger` は赤の 2 連パルス、`Maintenance` / `SafeMode` はオレンジのパルス、`WifiSetup` / `WifiConnecting` / `FindMePending` / `ChargeDone` / `ChargingOrMissing` は対応するパレット色で点灯します。 | `Online` は通常は緑の常灯ですが、直近の UDP 送信失敗やスキャンオーバーランがある間だけ Warning の黄橙に切り替わります。 |
| `connectivity` | ピクセル 0 が Wi-Fi 状態、ピクセル 1 がゲートウェイ接続、ピクセル 2 がストリーム活動を示します。 | Wi-Fi 接続中は Warning、未接続は Error、ストリーム側はゲートウェイ接続済みでアイドル時のみ Warning になります。 |
| `pressure_meter` | 現在の正規化圧力に応じて 0〜3 ピクセルが点灯します。 | 点灯部分は Online の緑から Error の赤へ段階的に変化します。 |
| `stream_heartbeat` | 最近フレーム送信があったときだけシアンのハートビートを短く出します。 | ストリームが止まっている間は消灯します。 |
| `calibration_auto` | 自動キャリブレーション中だけオレンジのゆっくりしたパルスを出します。 | キャリブレーションが止まると消灯します。 |
| `solid_marker` | 選択した `color` で 3 ピクセルすべてを常灯させます。 | 色は `teal`, `green`, `blue`, `purple`, `amber`, `red`, `white` です。 |
| `identify` | 3 ピクセルを白で追いかけるチェイス表示です。 | 固定プリセットとしても、一回だけの identify/test 表示としても使われます。 |
| `off` | ストリップを常に消灯します。 | `mode` が `enabled` のままでもこのプリセットは保持されます。 |

### 優先度の高い上書き

- ソフトオフ中はストリップが強制的に消灯し、復帰するまで戻りません。
- 電源遷移アニメーションはプリセットより優先されます。シャットダウン時は白のステップ/フェード、ウェイク時はシアンのフィル表示です。
- 一回だけの `identify` トリガーは現在のプリセットを一時的に上書きし、終了後に元のプリセットへ戻ります。

### 設計メモ

- 深刻なエラーやメンテナンス警告は `system_status` に集約し、その他のプリセットは役割を分離しています。
- オンボード SK6812 ステータス LED はフォールバックとして引き続き主要エラーを表示するため、基板 LED と外部ストリップは別々の役割です。
