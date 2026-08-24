# VD-CTL/R v1.5.F

VD-CTL/R v1.5.F のハードウェア参照入口です。ここでは、回路図で確認できる配線、部品、ネット名だけを記録します。操作手順、定格、I²C アドレス、電池互換性、機構方向は推測しません。

## 根拠と範囲

- 回路図：ワークスペース `pcb/v1.5.F/SCH_Schematic1_1-P1_2026-08-23.png`
- シート：`Schematic1`、ページ `P1`。図枠の参照名：`Ref_PDMS_Sensors_Controller_FPC_1.5.F`。
- この Wiki はこの回路図をハードウェア事実の根拠とします。PCB または回路図を変更する場合は、利用者向けの説明より先にこのページを更新します。

## 回路図で明示されている構成

| ブロック | 確認できる内容 |
|---|---|
| MCU | `ESP32-S3 MINI 1 N8` |
| アナログ入力 | `GIN0`–`GIN13`、`ADC1_0_GPIO1`–`ADC2_13_GPIO14` として配線 |
| デジタル選択 | `SEL_0_GPIO17`–`SEL_13_GPIO45` |
| FPC | `FPC-05F-20PH20` が 2 個：FPC1 は Analog Features、FPC2 は Digital Features |
| センサー | `BMI270` と `BMM350`、ともに `SDA` / `SCL` |
| 電池 | 主電池・バックアップ電池コネクタ、`MAX17048X+T10` Fuel Gauge、Battery Charger ブロック |
| 状態 LED | System Status と Battery Status と表示された `WS2812B-2427-V6` 2 個 |

GPIO、コネクタ pin、電源ネット、および本書の明示的な制限は [ハードウェア参照](hardware.md) を参照してください。
