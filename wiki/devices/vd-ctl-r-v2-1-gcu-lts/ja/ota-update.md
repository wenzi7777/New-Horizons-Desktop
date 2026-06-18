# OTA ファームウェアアップデート

デバイスは GitHub にホストされた JSON マニフェストファイルを使用して、無線でのファームウェアアップデートをサポートしています。

## マニフェスト URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v21-lts-latest.json
```

## 起動時の自動アップデート

デフォルト（`autoApplyOnBoot: true`）では、毎回の起動時（WiFi 接続後）にマニフェスト URL を確認します。新しいバージョンが利用可能な場合、自動的にダウンロードしてフラッシュし、再起動します。

アップデート中の LED：**シアンの呼吸**（`OtaActive`）
成功時の LED：**緑のブリンクバースト**（`OtaSuccess`）
失敗時の LED：**赤の点灯**（`OtaError`）

## 制御コマンドによる手動アップデート

アップデートを確認するには：
```json
{"command": "check_update", "protocol": "NHO/Arduino/1"}
```

保留中のアップデートを適用するには：
```json
{"command": "apply_update", "protocol": "NHO/Arduino/1"}
```

## OTA の設定

```json
{
  "command": "set_ota_config",
  "protocol": "NHO/Arduino/1",
  "auto_apply_on_boot": false,
  "manifest_url": "https://example.com/custom-manifest.json"
}
```

## ダウンロードタイムアウト

| パラメータ | 値 |
|-----------|-----|
| チャンクサイズ | 4096 バイト |
| アイドルタイムアウト | 15 000 ms |
| 全体タイムアウト | 180 000 ms（3 分） |
