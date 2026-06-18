# NHO/Arduino/1 プロトコルリファレンス

デバイスはセンサーデータのストリーミングに UDP を使用する `NHO/Arduino/1` プロトコルと、制御コマンドの JSON over TCP チャンネルで通信します。

## ネットワークポート

| ポート | プロトコル | 方向 | 用途 |
|--------|----------|------|------|
| 13250 | UDP | デバイス → ゲートウェイ/バックエンド | バイナリセンサーデータストリーム |
| 22346 | UDP | デバイス ↔ ネットワーク | FindMe デバイス発見 |
| 22345 | TCP | デスクトップ → デバイス | JSON 制御コマンド |

## バイナリパケット形式（センサーストリーム）

### ヘッダー（20 バイト、固定）

| オフセット | サイズ | 型 | 値/説明 |
|-----------|------|-----|---------|
| 0–1 | 2 | u16 LE | マジック `0xA55A` |
| 2 | 1 | u8 | パケットバージョン `3` |
| 3 | 1 | u8 | フラグ（下記参照） |
| 4–9 | 6 | バイト | デバイス UID（16 進文字列バイト、例：`3CDC7545CCD0`） |
| 10–13 | 4 | u32 LE | フレーム ID（シーケンス番号） |
| 14–17 | 4 | u32 LE | タイムスタンプ（起動からのミリ秒） |
| 18–19 | 2 | u16 LE | ペイロード長（ヘッダー後のバイト数） |

### フラグバイト（オフセット 3）

| ビット | 値 | 名前 | 意味 |
|--------|-----|------|------|
| 0 | 0x01 | `IMU_FLAG` | ペイロードに IMU データを含む（7 float） |
| 1 | 0x02 | `BATTERY_FLAG` | ペイロードにバッテリーデータを含む（4 バイト） |
| 2 | 0x04 | `MAG_FLAG` | ペイロードに磁力計データを含む（3 float、IMU_FLAG が設定されている場合のみ） |
| 6 | 0x40 | `HMAC_FLAG` | ペイロードに HMAC-SHA256 を含む（16 バイト）—予約済み、現在未使用 |
| 7 | 0x80 | `HEARTBEAT_FLAG` | ハートビートパケット—ペイロードなし |

### ペイロードレイアウト（順序通り）

1. **マトリックスデータ** — `センサー数 × 4` バイト、各値は IEEE 754 float32 LE（行優先順）
2. **IMU データ** — 28 バイト、`IMU_FLAG` が設定されている場合のみ：
   - `acc[3]` — 加速度計 X、Y、Z（各 float32）
   - `gyro[3]` — ジャイロスコープ X、Y、Z（各 float32）
   - `temperature_c` — 温度（°C、float32）
3. **磁力計データ** — 12 バイト、`IMU_FLAG` と `MAG_FLAG` の両方が設定されている場合のみ：
   - `mag[3]` — 磁場 X、Y、Z（各 float32）
4. **バッテリーデータ** — 4 バイト、`BATTERY_FLAG` が設定されている場合のみ：
   - `status`（u8）、`fault`（u8）、`vbat_mv`（u16 LE）

### ハートビートパケット

5000 ms ごとに送信されます。ヘッダーのみでペイロードはありません。フラグに `HEARTBEAT_FLAG`（0x80）が設定されています。ゲートウェイとバックエンドがデバイスの存在を検出するために使用されます。

## JSON 制御プロトコル（TCP ポート 22345）

### リクエスト形式

```json
{"command": "<cmd>", "protocol": "NHO/Arduino/1", "request_id": "<省略可>", ...パラメータ}
```

リクエストは改行終端の UTF-8 JSON です。`protocol` フィールドは必須です。

### レスポンス形式

```json
{"ok": true, "cmd": "<cmd>", "message": "<msg>", "data": {...}, "error": ""}
```

### 主要コマンド一覧

| コマンド | モード | 説明 |
|---------|------|------|
| `status` | 全モード | デバイスの完全なステータススナップショット |
| `scan_health` | 全モード | マトリックススキャンのパフォーマンス指標 |
| `memory_status` | 全モード | 空きヒープとメモリ情報 |
| `storage_status` | 全モード | フラッシュストレージ使用状況 |
| `log_tail` | 全モード | 最近のログエントリを読み取る |
| `log_clear` | 全モード | 保存ログを消去する |
| `check_update` | 全モード | OTA アップデートを確認する |
| `apply_update` | 全モード | 保留中の OTA アップデートを適用する |
| `reboot` | 全モード | デバイスを再起動する |
| `set_scan_timing` | Normal | スキャン FPS と安定時間を更新 |
| `set_stream_buffer` | Normal | リングバッファを設定 |
| `set_matrix_layout` | Normal | GPIO ピン割り当てをオーバーライド |
| `set_indicators` | Normal | 外部 LED と OLED を設定 |
| `set_charge_profile` | Normal | BQ25180 の充電プロファイルを設定 |
| `power_set_state` | Normal | ソフトオフまたはウェイクをトリガー |
| `enter_maintenance` | Normal | メンテナンスモードに切り替え |
| `exit_maintenance` | Maintenance | Normal モードに戻る |
| `calibration_*` | Maintenance | キャリブレーションセッションコマンド |
| `file_*` | 全/Maintenance | ファイルの読み取り/書き込み/一覧/削除 |

## FindMe 発見プロトコル（UDP ポート 22346）

デバイスは定期的に `findme_discover` パケットをブロードキャストします。ゲートウェイは `findme_offer` で応答します。デバイスは優先度と `preferred_gateway_id` に基づいて最適なゲートウェイを選択します。

```json
{"type": "findme_discover", "device_uid": "3CDC7545CCD0", "current_gateway_id": "...", "preferred_gateway_id": "...", "claim_id": "..."}
```
