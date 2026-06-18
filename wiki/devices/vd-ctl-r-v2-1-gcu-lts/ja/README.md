# VD-CTL/R v2.1 GCU LTS

VD-CTL/R v2.1 GCU LTS は New Horizons ファミリーのコンパクトな GCU（汎用制御ユニット）バリアントです。10×12 の感圧センサーマトリックス、BMI270 IMU と BMM150 磁力計、オンボードステータス LED を搭載しています。物理アクションボタン、外部 LED ストリップ、OLED ディスプレイはありません。

## 仕様

| 項目 | 値 |
|------|-----|
| MCU | ESP32-S3 |
| フラッシュ | 4 MB |
| ボードリビジョン | VD-CTL/R v2.1 GCU LTS |
| キーマトリックス | 10 行 × 12 列（120 センサー） |
| ステータス LED | SK6812（オンボード、GPIO 38） |
| 外部 LED | なし |
| OLED | なし |
| I2C | SCL GPIO 47 · SDA GPIO 48 · 1 MHz |
| アクションボタン | なし |
| IMU | BMI270 + BMM150 |
| 充電 IC | なし（BQ25180 非搭載） |
| プロトコル | NHO/Arduino/1 |
| ファームウェア | New Horizons OS Arduino v0.9.0 |
| OTA マニフェスト | `arduino-gcu-v21-lts-latest.json` |

## OTA マニフェスト URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v21-lts-latest.json
```

## サポートされる機能

- オンボード SK6812 ステータス LED
- BMI270 6 軸 IMU（加速度計 + ジャイロスコープ）100 Hz
- BMM150 3 軸磁力計（追加 3-float ペイロードブロック）
- `power_set_state` コマンドによるリモート電源制御（物理ボタンなし）
- 完全な `DeviceConfig` 対応：スキャンタイミング、ストリームバッファ、ロギング、OTA
- 充電管理なし（BQ25180 非搭載）
- 外部 LED・OLED なし
