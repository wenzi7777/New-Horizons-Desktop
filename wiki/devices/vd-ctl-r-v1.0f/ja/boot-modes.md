# 起動モード

ファームウェアは 3 つの動作モードをサポートしています。起動時にアクティブなモードが決定され、次の再起動まで維持されます。

## モード一覧

| モード | LED 色 | 説明 |
|--------|--------|------|
| Normal（通常） | 緑（Online）※起動後 | フル動作：スキャン、WiFi、ストリーミング |
| Maintenance（メンテナンス） | オレンジ（Solid） | 設定変更、キャリブレーション、ファイル転送 |
| Safe Maintenance（セーフメンテナンス） | マゼンタ（Solid） | 起動失敗を繰り返した際の緊急フォールバック |

## Normal モード

デフォルトの動作モードです。すべてのサブシステムが動作します：キーマトリックススキャン、WiFi、IMU（存在する場合）、UDP ストリーミング、OTA、制御サーバー。LED は Boot → WifiConnecting → FindMePending → Online と進行します。

## Maintenance モード

キャリブレーション、ファイル管理、レイアウト変更などの追加コマンドを有効にします。スキャンと UDP ストリーミングは継続されますが、メンテナンス操作が優先されます。

### Maintenance モードへの移行（Normal から）

**アクションボタン操作：**
- デバイスの電源が入った状態で、アクションボタンを **1500 ms 以上** 長押しします。

**制御コマンド経由：**
```json
{"command": "enter_maintenance", "protocol": "NHO/Arduino/1"}
```

### Maintenance モードの終了

```json
{"command": "exit_maintenance", "protocol": "NHO/Arduino/1"}
```

または、デバイスを再起動します（デフォルトで Normal に戻ります）。

## Safe Maintenance モード

ファームウェアが **3 回以上連続した起動失敗** を検出した場合に自動的に移行します。これにより、不正な設定によってデバイスが回復不能になるのを防ぎます。利用可能なコマンドは WiFi セットアップ、OTA、基本ステータスのみです。

### トリガーの仕組み

起動失敗カウンターは起動のたびにインクリメントされます。マトリックススキャンが正常に開始された場合にのみリセットされます。カウンターが **3** に達すると、次の起動で Safe Maintenance に移行します。

### 回復手順

1. Desktop アプリまたは TCP クライアントでポート **22345** に接続します。
2. ステータスを確認：`{"command": "status", "protocol": "NHO/Arduino/1"}`
3. 設定が破損している場合はリセット：`set_matrix_layout` コマンドか、ファイルコマンドで `/config/device.json` を削除します。
4. 再起動：`{"command": "reboot", "protocol": "NHO/Arduino/1"}`

## WiFi セットアップモード

WiFi の認証情報が保存されていない場合、または明示的にトリガーされた場合に使用します。

**ボタンによるトリガー：** 起動後 **最初の 3 秒以内** にアクションボタンを押し続けます。LED が琥珀色（WifiSetup）になり、デバイスが `NewHorizonsOS-<UID>` という名前の AP をブロードキャストします。

**ポータルへの接続：**
- SSID：`NewHorizonsOS-<device_uid>`
- URL：`http://newhorizons.os`（または `http://192.168.4.1`）
