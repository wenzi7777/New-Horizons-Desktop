# VD-CTL/R v2.3.D GCU LTS

VD-CTL/R v2.3.D GCU LTS は New Horizons ファミリーの最新 GCU バリアントです。大型の 15×15 感圧センサーマトリックス、BMI270 IMU と BMM150 磁力計、BQ25180 バッテリー充電、オンボードステータス LED を搭載しています。物理アクションボタン、外部 LED ストリップ、OLED ディスプレイはありません。

## 仕様

| 項目 | 値 |
|------|-----|
| MCU | ESP32-S3 |
| フラッシュ | 4 MB |
| ボードリビジョン | VD-CTL/R v2.3.D GCU LTS |
| キーマトリックス | 15 行 × 15 列（225 センサー） |
| ステータス LED | SK6812（オンボード、GPIO 38） |
| 外部 LED | なし |
| OLED | なし |
| I2C | SCL GPIO 47 · SDA GPIO 48 · 1 MHz |
| アクションボタン | なし |
| IMU | BMI270 + BMM150 |
| 充電 IC | BQ25180 |
| プロトコル | NHO/Arduino/1 |
| ファームウェア | New Horizons OS Arduino v0.9.0 |
| OTA マニフェスト | `arduino-gcu-v23d-lts-latest.json` |

## OTA マニフェスト URL

```
https://raw.githubusercontent.com/wenzi7777/New-Horizons-OS/main/releases/arduino-gcu-v23d-lts-latest.json
```

## サポートされる機能

- オンボード SK6812 ステータス LED
- BMI270 6 軸 IMU（加速度計 + ジャイロスコープ）100 Hz
- BMM150 3 軸磁力計（追加 3-float ペイロードブロック）
- BQ25180 バッテリー充電（充電プロファイル選択対応）
- `power_set_state` コマンドによるリモート電源制御（物理ボタンなし）
- 完全な `DeviceConfig` 対応：スキャンタイミング、ストリームバッファ、ロギング、OTA
- 外部 LED・OLED なし
