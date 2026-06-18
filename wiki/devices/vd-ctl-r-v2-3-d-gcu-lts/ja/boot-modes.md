# 起動モード

ファームウェアは 3 つの動作モードをサポートしています。v2.3.D GCU LTS には**物理アクションボタンがない**ため、モードの切り替えにはコマンドまたはマルチサイクル起動による方法を使用します。

## モード一覧

| モード | LED 色 | 説明 |
|--------|--------|------|
| Normal（通常） | 緑（Online）※起動後 | フル動作：スキャン、WiFi、IMU、ストリーミング |
| Maintenance（メンテナンス） | オレンジ（Solid） | 設定変更、キャリブレーション、ファイル転送 |
| Safe Maintenance（セーフメンテナンス） | マゼンタ（Solid） | 起動失敗を繰り返した際の緊急フォールバック |

## Normal モード

デフォルトの動作モードです。すべてのサブシステムが動作します：キーマトリックススキャン（15×15）、WiFi、BMI270+BMM150 IMU、UDP ストリーミング、OTA、制御サーバー。

## Maintenance モード

### Maintenance モードへの移行

**制御コマンド経由（主な方法）：**
```json
{"command": "enter_maintenance", "protocol": "NHO/Arduino/1"}
```

**マルチサイクル起動トリガー（オフライン回復）：**
3 秒の起動ウィンドウ内でデバイスを **5 回連続**して電源サイクルします。5 回目のサイクルでデバイスは自動的に Maintenance モードに移行します。

### Maintenance モードの終了

```json
{"command": "exit_maintenance", "protocol": "NHO/Arduino/1"}
```

または再起動します（デフォルトで Normal に戻ります）。

## Safe Maintenance モード

**3 回連続した起動失敗**後に自動的に移行します。利用可能なコマンドは WiFi セットアップ、OTA、基本ステータスのみです。

### 回復手順

1. TCP クライアントでポート **22345** に接続します。
2. ステータスを確認：`{"command": "status", "protocol": "NHO/Arduino/1"}`
3. 設定が破損している場合はファイルコマンドで `/config/device.json` を削除します。
4. 再起動：`{"command": "reboot", "protocol": "NHO/Arduino/1"}`

## WiFi セットアップモード

**マルチサイクルトリガー：** 3 秒の起動ウィンドウ内でデバイスを **5 回連続**して電源サイクルします。5 回目のサイクルでデバイスは WiFi セットアップ AP をブロードキャストします。

- SSID：`NewHorizonsOS-<device_uid>`
- URL：`http://newhorizons.os`（または `http://192.168.4.1`）
