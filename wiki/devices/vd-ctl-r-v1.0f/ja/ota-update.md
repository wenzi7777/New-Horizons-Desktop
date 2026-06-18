# OTA ファームウェアアップデート

デバイスは GitHub にホストされた JSON マニフェストファイルを使用して、無線でのファームウェアアップデートをサポートしています。

## マニフェスト URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f-latest.json
```

マニフェストはファームウェアのバージョン、バイナリのダウンロード URL、SHA-256 ハッシュ、ファイルサイズを含む JSON ファイルです。

## 起動時の自動アップデート

デフォルト（`autoApplyOnBoot: true`）では、毎回の起動時（WiFi 接続後）にマニフェスト URL を確認します。新しいバージョンが利用可能な場合、自動的にダウンロードしてフラッシュし、再起動します。

アップデート中の LED：**シアンの呼吸**（`OtaActive`）
成功時の LED：**緑のブリンクバースト**（`OtaSuccess`）
失敗時の LED：**赤の点灯**（`OtaError`）

## 制御コマンドによる手動アップデート

適用せずにアップデートを確認するには：
```json
{"command": "check_update", "protocol": "NHO/Arduino/1"}
```

レスポンスには `available`、`version`、`url`、`sha256`、`size` が含まれます。

保留中のアップデートを即座に適用するには：
```json
{"command": "apply_update", "protocol": "NHO/Arduino/1"}
```

## OTA の設定

マニフェスト URL を変更したり自動アップデートを無効にするには：
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

ダウンロードが 15 秒以上停止した場合、または合計 3 分を超えた場合、アップデートは中断され `OtaError` が表示されます。

## バージョン形式

ファームウェアのバージョンは `vMAJOR.MINOR.PATCH` 形式（例：`v0.9.0`）です。デバイスはマニフェストのバージョン文字列をコンパイル済みの `kFirmwareVersion` 定数と比較して、アップデートが必要かどうかを判断します。
