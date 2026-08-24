# VD-CTL/R v1.5.F ハードウェア参照

## 根拠と表記

以下の各項目は `pcb/v1.5.F/SCH_Schematic1_1-P1_2026-08-23.png`（`Schematic1`、`P1`、`Ref_PDMS_Sensors_Controller_FPC_1.5.F`）から転記しています。`GPIO`、`GIN`、`SEL`、`VOUT3V3`、`VOUT5V`、`VBAT`、`SDA`、`SCL` は回路図のネット名であり、pin 番号はコネクタ記号に記された番号です。

> ネット名は電気的な定格や用途の保証ではありません。特に `VOUT5V` は利用可能電流を、`BAT_ID` は電池識別規則を定義しません。

## コア、アナログ、選択経路

| 項目 | 回路図上の根拠 |
|---|---|
| MCU | U13：`ESP32-S3 MINI 1 N8` |
| アナログ前段 | `ADC Handlers` は `TLV9064IRUCR` を使用し、出力ネットは `ADC1_0_GPIO1`–`ADC2_13_GPIO14` |
| アナログ入力 | `GIN0`–`GIN13` |
| デジタル選択 | `SEL_0_GPIO17`–`SEL_13_GPIO45` |
| I²C | MCU 上で `SDA` は IO40、`SCL` は IO42 |
| 外部シリアル | `EXTERNAL_RX` は IO17、`EXTERNAL_TX` は IO18 |
| Action Button | `ACTION_BUTTON` は IO41。R27 10 kΩ は `VCC_3V3` へプルアップし、SW1（`B3U-1000P`）は GND へ接続 |
| Status data | `STAT_GPIO46` は System Status WS2812B の DIN へ入力 |

### アナログ入力対応

| FPC1 ネット | ADC ネット |
|---|---|
| GIN0 | ADC1_0_GPIO1 |
| GIN1 | ADC1_1_GPIO2 |
| GIN2 | ADC1_2_GPIO3 |
| GIN3 | ADC1_3_GPIO4 |
| GIN4 | ADC1_4_GPIO5 |
| GIN5 | ADC1_5_GPIO6 |
| GIN6 | ADC1_6_GPIO7 |
| GIN7 | ADC1_7_GPIO8 |
| GIN8 | ADC1_8_GPIO9 |
| GIN9 | ADC1_9_GPIO10 |
| GIN10 | ADC2_10_GPIO11 |
| GIN11 | ADC2_11_GPIO12 |
| GIN12 | ADC2_12_GPIO13 |
| GIN13 | ADC2_13_GPIO14 |

### デジタル選択対応

| FPC2 ネット | MCU GPIO |
|---|---|
| SEL_0 | GPIO17 |
| SEL_1 | GPIO18 |
| SEL_2 | GPIO21 |
| SEL_3 | GPIO26 |
| SEL_4 | GPIO47 |
| SEL_5 | GPIO33 |
| SEL_6 | GPIO34 |
| SEL_7 | GPIO48 |
| SEL_8 | GPIO35 |
| SEL_9 | GPIO36 |
| SEL_10 | GPIO37 |
| SEL_11 | GPIO38 |
| SEL_12 | GPIO39 |
| SEL_13 | GPIO45 |

`Anti-strapping Pull Down` ブロックは R11（10 kΩ）を介して `SEL_13_GPIO45` を GND へプルダウンします。起動要件を確認せずに、この経路へ外部プルアップを追加しないでください。

## FPC コネクタ pinout

両コネクタは `FPC-05F-20PH20` と表示されています。pin 21 と 22 は GND 記号へ接続され、下表では外部 pin 1–20 のみを示します。回路図記号内の上下方向は、基板、ケーブル、筐体における物理的な「上」を保証しません。

### FPC1 — Analog Features

| Pin | ネット |
|---|---|
| 1–14 | GIN0–GIN13（順番） |
| 15 | LED_ARRAY_GPIO16 |
| 16 | EXTERNAL_RX |
| 17 | EXTERNAL_TX |
| 18 | GND |
| 19 | VOUT3V3 |
| 20 | VOUT5V |

### FPC2 — Digital Features

| Pin | ネット |
|---|---|
| 1–14 | SEL_0_GPIO17–SEL_13_GPIO45（順番） |
| 15 | 未接続（no-connect マーク） |
| 16 | SDA |
| 17 | SCL |
| 18 | GND |
| 19 | VOUT3V3 |
| 20 | VOUT5V |

## センサーと状態表示

| ブロック | 回路図上の根拠 |
|---|---|
| IMU | U4：`BMI270`、SDX は `SDA`、SCX は `SCL` へ接続 |
| 磁気センサー | U7：`BMM350`、SDA / SCK は共有 I²C ネット、電源は `VCC_1V8` と `VCC_3V3` |
| Fuel Gauge | U1：`MAX17048X+T10`、CELL / VDD は `VBAT`、SCL / SDA は I²C へ接続 |
| System LED | U12：`WS2812B-2427-V6`、DIN は R4（0 Ω）経由の `STAT_GPIO46` |
| Battery LED | U3：`WS2812B-2427-V6`、U12 DOUT から直列接続 |

回路図は LED の色の意味、センサー範囲、I²C アドレス、firmware のポーリング周期を定義していません。これらは firmware または部品資料で確認してください。

## 電源、充電、電池コネクタ

| ブロック | 回路図上の根拠 |
|---|---|
| USB | `USB TypeC`、`Overcurrent Protection`、`Native USB` ブロック。Native USB D+ / D− は IO20 / IO19 へ配線 |
| 充電 | `Battery Charger` ブロックあり。充電電流、終止電圧、対応化学系はここで断定しない |
| 主 3.3 V | `Main Power Supply LDO & Switch` の U8 `TLV75733PDRVR` が `VCC_3V3` を生成 |
| 1.8 V | U6 `TPS7A0218PDQNR` が `VCC_3V3` から `VCC_1V8` を生成 |
| 5 V 出力 | `5V_OUT Protection` は D5 `1N5819HW-7-F` と F2 `SMD0805-010-33` を含み、出力ネットは `VOUT5V` |

### 主電池コネクタ U9

U9 は `YZ92015035T-04025-01` と表示されています。R12（10 kΩ）は `BAT_ID_ADC2_4_GPIO15` を `VCC_3V3` へプルアップし、C10（100 nF）は GND へ接続されています。

| Pin | ネット |
|---|---|
| 1 | VBAT |
| 2 | BAT_THERMAL |
| 3 | GND |
| 4 | BAT_ID |

### バックアップ電池コネクタ

CN2 は `XH-2AWT` と表示され、`VBAT` と GND に配線されています。回路図は役割、電池種別、主電池との同時使用可否を定義していません。

## この回路図から推論しない事項

- FPC の物理方向、相手ケーブル、筐体の詳細。
- `VOUT3V3` / `VOUT5V` の供給可能電流、突入耐性、外部保護要件。
- 電池容量、化学系、`BAT_THERMAL` / `BAT_ID` の実際の判定。
- USB-C の役割、電力交渉、firmware 動作、ボタン操作。
- シートに記されていないセンサー校正、LED 色、通信プロトコル。
