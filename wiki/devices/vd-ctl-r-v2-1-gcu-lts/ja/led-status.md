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

| シグナル | 色 | パターン | 間隔 | 意味 |
|---------|-----|---------|------|------|
| `Boot` | 暗い青 | Breathe | 2200 ms | 起動時にファームウェアが初期化中 |
| `WifiSetup` | 琥珀色 | Breathe | 1800 ms | WiFi セットアップポータルが起動中 |
| `WifiConnecting` | 黄琥珀 | Breathe | 1800 ms | 保存済み WiFi ネットワークへの接続を試みている |
| `FindMePending` | シアン | Breathe | 1500 ms | WiFi 接続済み、ゲートウェイを探している |
| `Online` | 緑 | Solid | — | 完全動作中、ゲートウェイにストリーミング中 |
| `Maintenance` | オレンジ | Solid | — | メンテナンスモードが有効 |
| `SafeMode` | マゼンタ | Solid | — | セーフメンテナンスモード |
| `OtaActive` | シアン | Breathe | 1300 ms | OTA ファームウェアのダウンロード中 |
| `OtaSuccess` | 緑 | BlinkBurst | 700 ms · 900 ms | OTA 適用成功、再起動中 |
| `OtaError` | 赤 | Solid | — | OTA ダウンロードまたは検証の失敗 |
| `Error` | 赤 | Solid | — | 回復不能なランタイムエラー |
| `ScanWarning` | 黄オレンジ | Breathe | 1200 ms | マトリックススキャンのオーバーランを検出 |
| `RamDanger` | 黄オレンジ | Breathe | 800 ms | 空きヒープが危機的に少ない |
| `CommandReceived` | 白 | 短いフラッシュ | — | 制御コマンドパケットを受信した |
| `CommandSuccess` | 緑 | 短いフラッシュ | — | コマンドが正常に実行された |
| `CommandFailed` | 赤 | 短いフラッシュ | — | コマンドの実行に失敗した |

> このボードには BQ25180 充電 IC が搭載されていないため、充電関連のシグナル（`ChargingOrMissing`、`ChargeDone`、`SoftOff*`）は適用されません。
