# デバイス設定リファレンス

すべての設定はデバイスのフラッシュ上の `/config/device.json` に保存され、起動のたびに読み込まれます。特に記載がない限り、変更は即座に有効になります。

## スキャンタイミング

キーマトリックスのサンプリング速度とデータ送信方法を制御します。

| パラメータ | デフォルト | 範囲 | 説明 |
|-----------|---------|------|------|
| `target_fps` | 60 | 1–90 | 目標マトリックススキャンレート（フレーム/秒） |
| `settle_us` | 20 | — | 列アクティブ化後の ADC 読み取り前の安定待機時間（マイクロ秒） |
| `send_every_n_frames` | 1 | 1–N | N フレームごとに UDP パケットを送信 |

```json
{
  "command": "set_scan_timing",
  "protocol": "NHO/Arduino/1",
  "target_fps": 60,
  "settle_us": 20,
  "send_every_n_frames": 1
}
```

## ストリームバッファ（リングバッファ）

スキャンリングバッファは UDP 送信失敗時にパケットをキューに追加して再試行します。

| パラメータ | デフォルト | 説明 |
|-----------|---------|------|
| `enabled` | true | リングバッファキューを有効にする |
| `mode` | `"standard"` | バッファモード：`standard`（3 フレーム）または `extended`（5 フレーム） |

```json
{
  "command": "set_stream_buffer",
  "protocol": "NHO/Arduino/1",
  "enabled": true,
  "mode": "standard"
}
```

## IMU

v1.0.F ボードには BMI270 加速度計 + ジャイロスコープが搭載されています。`imu.enabled` フラグはライブパケット内の BMI270 テレメトリを制御します。BMM150 磁力計はこのボードには搭載されていないため、`MAG_FLAG` と `mag` ペイロードは利用できません。

## 外部 LED ストリップ

| パラメータ | デフォルト | オプション | 説明 |
|-----------|---------|---------|------|
| `mode` | `"off"` | `off`, `on`, `auto` | LED ストリップの動作モード |
| `preset` | `"stream_health"` | `stream_health` | `auto` モードでの視覚プリセット |
| `brightness` | 0.35 | 0.0–1.0 | ストリップの輝度 |

```json
{
  "command": "set_indicators",
  "protocol": "NHO/Arduino/1",
  "external_led": {"mode": "auto", "preset": "stream_health", "brightness": 0.35}
}
```

## OLED ディスプレイ

| パラメータ | デフォルト | オプション/範囲 | 説明 |
|-----------|---------|--------------|------|
| `mode` | `"off"` | `off`, `on`, `auto` | ディスプレイのオン/オフ/オート |
| `page` | `"live_status"` | `live_status`, `sensor_snapshot`, `log_status` | 表示するコンテンツ |
| `update_hz` | 1 | 1–N | ディスプレイのリフレッシュレート |
| `contrast` | 128 | 0–255 | ディスプレイの輝度 |
| `rotation` | 0 | 0, 1, 2, 3 | ディスプレイの回転（×90°） |

```json
{
  "command": "set_indicators",
  "protocol": "NHO/Arduino/1",
  "oled": {"mode": "on", "page": "live_status", "update_hz": 1, "contrast": 128, "rotation": 0}
}
```

## ロギング

| パラメータ | デフォルト | オプション | 説明 |
|-----------|---------|---------|------|
| `enabled` | true | true/false | 永続ログストレージを有効にする |
| `level` | `"info"` | `error`, `warn`, `info`, `debug` | 保存する最小ログレベル |
| `mode` | `"standard"` | `standard`（12 KB）、`extended`（24 KB） | ログストレージサイズ |

```json
{
  "command": "set_log",
  "protocol": "NHO/Arduino/1",
  "enabled": true,
  "level": "info",
  "mode": "standard"
}
```

この設定に関わらず、シリアル出力は常にすべてのレベルをログに記録します。

## OTA 設定

| パラメータ | デフォルト | 説明 |
|-----------|---------|------|
| `auto_apply_on_boot` | true | 起動時に自動的にアップデートを確認して適用する |
| `manifest_url` | GitHub URL | マニフェスト JSON の URL |

完全な OTA リファレンスは `ota-update.md` を参照してください。

## マトリックスレイアウト

上級者向け：行と列のデフォルト GPIO ピン割り当てをオーバーライドします。通常はボードのデフォルト値が設定されており、カスタムハードウェアを使用していない限り変更しないでください。

```json
{
  "command": "set_matrix_layout",
  "protocol": "NHO/Arduino/1",
  "analog_pins": [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  "select_pins": [13, 14, 15, 16, 17, 18, 19, 20, 21, 26, 47, 33, 34, 48, 35, 36, 37, 38, 39, 40, 41]
}
```
