# SK6812 ステータス LED リファレンス

オンボード SK6812 LED（GPIO 38）はリアルタイムのシステム状態フィードバックを提供します。

## アニメーションパターン

| パターン | 説明 |
|---------|------|
| `Off` | LED は完全に消灯 |
| `Solid` | 一定の点灯 |
| `Breathe` | ゆっくりフェードイン・アウト |
| `BlinkBurst` | 短い点滅を連続した後、休止 |

## 状態リファレンス

| シグナル | 色（RGB） | パターン | 間隔 | 意味 |
|---------|---------|---------|------|------|
| `Boot` | 青（0,0,16） | Breathe | 2200 ms | 起動時にファームウェアが初期化中 |
| `WifiSetup` | 琥珀（32,9,0） | Breathe | 1800 ms | WiFi セットアップポータルが起動中 |
| `WifiConnecting` | 黄琥珀（24,18,0） | Breathe | 1800 ms | 保存済み WiFi への接続を試みている |
| `FindMePending` | シアン（0,18,24） | Breathe | 1500 ms | WiFi 接続済み、ゲートウェイを探している |
| `Online` | 緑（0,24,0） | Solid | — | 完全動作中、ストリーミング中 |
| `Maintenance` | オレンジ（32,18,0） | Solid | — | メンテナンスモードが有効 |
| `SafeMode` | マゼンタ（32,0,32） | Solid | — | セーフメンテナンスモード |
| `OtaActive` | シアン（0,18,24） | Breathe | 1300 ms | OTA ファームウェアのダウンロード中 |
| `OtaSuccess` | 緑 | BlinkBurst | 700 ms · 900 ms | OTA 適用成功、再起動中 |
| `OtaError` | 赤（32,0,0） | Solid | — | OTA ダウンロードまたは検証の失敗 |
| `Error` | 赤（32,0,0） | Solid | — | 回復不能なランタイムエラー |
| `ScanWarning` | 黄オレンジ（28,18,0） | Breathe | 1200 ms | マトリックススキャンのオーバーランを検出 |
| `RamDanger` | 黄オレンジ（28,18,0） | Breathe | 800 ms | 空きヒープが危機的に少ない |
| `ChargingOrMissing` | オレンジ | Solid | — | バッテリー充電中、またはバッテリー未検出 |
| `ChargeDone` | ティール（57,197,187） | Solid | — | バッテリー満充電 |
| `SoftOffCharging` | オレンジ | Solid | — | ソフトオフ中、充電中 |
| `SoftOffChargeDone` | ティール | Solid | — | ソフトオフ中、バッテリー満充電 |
| `SoftOffChargeIdle` | Off | — | — | ソフトオフ中、充電なし |
| `CommandReceived` | 白（24,24,24） | 短いフラッシュ | — | 制御コマンドパケットを受信した |
| `CommandSuccess` | 緑 | 短いフラッシュ | — | コマンドが正常に実行された |
| `CommandFailed` | 赤 | 短いフラッシュ | — | コマンドの実行に失敗した |

> v1.0f と異なり、このボードには物理ボタンがないため `PowerTransitionShutdown` / `PowerTransitionWake` アニメーションは存在しません。電源状態の移行はコマンドでのみ行われます。
