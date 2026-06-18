# VD-CTL/R v1.0.F 2026.4

VD-CTL/R v1.0.F 2026.4 は New Horizons ファミリーの主力ハードウェアリビジョンです。フルサイズのキーマトリックス、オンボードステータス LED、外部アドレサブル LED ストリップ、OLED ディスプレイ、BMI270 IMU、物理アクションボタン、BQ25180 ベースの充電回路を搭載しています。

## 仕様

| 項目 | 値 |
|------|-----|
| MCU | ESP32-S3 Mini 1 N8 |
| フラッシュ | 8 MB |
| ボードリビジョン | VD-CTL/R v1.0.F 2026.4 |
| キーマトリックス | 10 行 × 21 列（210 センサー） |
| ステータス LED | SK6812（オンボード、GPIO 11） |
| 外部 LED | WS2812B 互換ストリップ（GPIO 12、3 ピクセル） |
| OLED | SSD1306 128×64、I2C |
| IMU | BMI270 加速度計 + ジャイロスコープ。BMM150 磁力計は非搭載 |
| I2C | SCL GPIO 42 · SDA GPIO 45 · 400 kHz |
| アクションボタン | GPIO 46 |
| 充電 IC | BQ25180 |
| プロトコル | NHO/Arduino/1 |
| ファームウェア | New Horizons OS Arduino v0.9.0 |
| OTA マニフェスト | `arduino-v10f-latest.json` |

## OTA マニフェスト URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-v10f-latest.json
```

## サポートされる機能

- オンボード SK6812 ステータス LED（フルアニメーション対応）
- 外部 WS2812B LED ストリップ（3 ピクセル、モードと輝度を設定可能）
- SSD1306 OLED ディスプレイ（ページ、コントラスト、回転、更新レートを設定可能）
- 物理アクションボタン（ウェイク、メンテナンス移行、WiFi セットアップ）
- BQ25180 バッテリー充電（充電プロファイル選択対応）
- ソフトオフ／ソフトウェイク（電源アニメーション付き）
- BMI270 IMU テレメトリ。BMM150 磁力計はこのボードには搭載されていません
- 完全な `DeviceConfig` 対応：スキャンタイミング、ストリームバッファ、ロギング、OTA
