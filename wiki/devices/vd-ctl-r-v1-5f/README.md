# VD-CTL/R v1.5.F

這是 VD-CTL/R v1.5.F 的硬體參考入口。本文只整理已能在原理圖核對的連線、元件與網名；操作流程、額定電流、I²C 位址、電池相容性與機構方向均不在此推定。

## 來源與範圍

- 原理圖：工作區 `pcb/v1.5.F/SCH_Schematic1_1-P1_2026-08-23.png`
- 圖紙：`Schematic1`，頁次 `P1`；圖框參考名稱為 `Ref_PDMS_Sensors_Controller_FPC_1.5.F`。
- 本 Wiki 以這張原理圖為硬體事實來源。若日後 PCB 或原理圖修訂，應先更新本頁，再更新任何使用說明。

## 原理圖明示的組成

| 區塊 | 原理圖可核對內容 |
|---|---|
| 主控 | `ESP32-S3 MINI 1 N8` |
| 類比輸入 | `GIN0`–`GIN13`，各自連到標示為 `ADC1_0_GPIO1`–`ADC2_13_GPIO14` 的路徑 |
| 數位選擇 | `SEL_0_GPIO17`–`SEL_13_GPIO45` |
| FPC | 兩個 `FPC-05F-20PH20`：FPC1 標示為 Analog Features，FPC2 標示為 Digital Features |
| 感測器 | `BMI270` 與 `BMM350`，皆接到 `SDA` / `SCL` 網路 |
| 電池 | 主電池接頭、備用電池接頭、Fuel Gauge（`MAX17048X+T10`）及 Battery Charger 區塊 |
| 狀態燈 | 兩顆 `WS2812B-2427-V6`，標示為 System Status 與 Battery Status |

詳細 GPIO、接頭腳位、電源及限制請見 [硬體參考](hardware.md)。
