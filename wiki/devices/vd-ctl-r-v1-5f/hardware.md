# VD-CTL/R v1.5.F 硬體參考

## 證據與讀法

本頁逐項轉錄自 `pcb/v1.5.F/SCH_Schematic1_1-P1_2026-08-23.png`（`Schematic1`、`P1`、`Ref_PDMS_Sensors_Controller_FPC_1.5.F`）。`GPIO`、`GIN`、`SEL`、`VOUT3V3`、`VOUT5V`、`VBAT`、`SDA` 與 `SCL` 均為圖中的網名；表格的 pin 號是接頭符號旁的編號。

> 本頁不把網名延伸成電氣額定值或使用承諾。例如 `VOUT5V` 不代表可任意取用的電流，`BAT_ID` 也不代表已知的電池型號判別規則。

## 核心、類比與選擇路徑

| 項目 | 原理圖明示內容 |
|---|---|
| MCU | U13：`ESP32-S3 MINI 1 N8` |
| 類比前端 | `ADC Handlers` 區塊使用 `TLV9064IRUCR`；輸出網名依序為 `ADC1_0_GPIO1`–`ADC2_13_GPIO14` |
| 類比輸入 | `GIN0`–`GIN13` |
| 數位選擇 | `SEL_0_GPIO17`–`SEL_13_GPIO45` |
| I²C | MCU 端標示 `SDA` 為 IO40、`SCL` 為 IO42 |
| 外部序列 | `EXTERNAL_RX` 連 IO17、`EXTERNAL_TX` 連 IO18 |
| 動作按鈕 | `ACTION_BUTTON` 連 IO41；R27 10 kΩ 上拉至 `VCC_3V3`，SW1（`B3U-1000P`）接地 |
| 狀態資料 | `STAT_GPIO46` 連至系統狀態 WS2812B 的 DIN |

### 類比輸入對應

| FPC1 網名 | ADC 網名 |
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

### 數位選擇對應

| FPC2 網名 | MCU GPIO |
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

`Anti-strapping Pull Down` 區塊將 `SEL_13_GPIO45` 經 R11（10 kΩ）下拉到 GND；因此此路徑不應在未核對啟動需求前任意外加上拉。

## FPC 接頭腳位

兩個接頭的型號皆標為 `FPC-05F-20PH20`。圖中 21、22 腳連到接地符號；下列只列外部 1–20 腳。腳位在接頭符號上的上下方向是原理圖符號方向，不保證等同於實體板、排線或外殼的「上方」。

### FPC1 — Analog Features

| Pin | 網名 |
|---|---|
| 1–14 | GIN0–GIN13（依序） |
| 15 | LED_ARRAY_GPIO16 |
| 16 | EXTERNAL_RX |
| 17 | EXTERNAL_TX |
| 18 | GND |
| 19 | VOUT3V3 |
| 20 | VOUT5V |

### FPC2 — Digital Features

| Pin | 網名 |
|---|---|
| 1–14 | SEL_0_GPIO17–SEL_13_GPIO45（依序） |
| 15 | 未接（圖中以 no-connect 標記） |
| 16 | SDA |
| 17 | SCL |
| 18 | GND |
| 19 | VOUT3V3 |
| 20 | VOUT5V |

## 感測器與狀態指示

| 區塊 | 原理圖明示內容 |
|---|---|
| IMU | U4：`BMI270`；SDX 接 `SDA`、SCX 接 `SCL` |
| 磁力計 | U7：`BMM350`；SDA / SCK 接至共用 I²C 網路，並使用 `VCC_1V8`、`VCC_3V3` |
| Fuel Gauge | U1：`MAX17048X+T10`；CELL 與 VDD 接 `VBAT`，SCL / SDA 接 I²C 網路 |
| 系統狀態燈 | U12：`WS2812B-2427-V6`，DIN 由 `STAT_GPIO46` 經 R4（0 Ω）輸入 |
| 電池狀態燈 | U3：`WS2812B-2427-V6`，由 U12 的 DOUT 串接 |

原理圖沒有提供 LED 顏色語意、感測器量測範圍、I²C 位址或 firmware 的輪詢頻率；這些項目必須另以韌體或元件資料表確認。

## 電源、充電與電池接頭

| 區塊 | 原理圖明示內容 |
|---|---|
| USB | 有 `USB TypeC`、`Overcurrent Protection` 與 `Native USB` 區塊；原生 USB D+ / D− 分別連至 IO20 / IO19 |
| 充電 | 有 `Battery Charger` 區塊；不在此頁推定充電電流、終止電壓或支援的電池化學系統 |
| 主 3.3 V | `Main Power Supply LDO & Switch` 使用 U8 `TLV75733PDRVR` 產生 `VCC_3V3` |
| 1.8 V | U6 `TPS7A0218PDQNR` 自 `VCC_3V3` 產生 `VCC_1V8` |
| 5 V 輸出 | `5V_OUT Protection` 區塊包含 D5 `1N5819HW-7-F` 與 F2 `SMD0805-010-33`，網名輸出為 `VOUT5V` |

### 主電池接頭 U9

U9 型號標為 `YZ92015035T-04025-01`。除了接頭腳位，圖中也顯示 R12（10 kΩ）自 `VCC_3V3` 上拉到 `BAT_ID_ADC2_4_GPIO15`，且 C10（100 nF）接地。

| Pin | 網名 |
|---|---|
| 1 | VBAT |
| 2 | BAT_THERMAL |
| 3 | GND |
| 4 | BAT_ID |

### 備用電池接頭

CN2 型號標為 `XH-2AWT`，其連線為 `VBAT` 與 GND。原理圖沒有定義其使用時機、可接電池型式或是否能與主電池同時使用。

## 不由原理圖推論的事項

- FPC 實體插拔方向、配接排線與插頭料號以外的機構資訊。
- `VOUT3V3` / `VOUT5V` 的可用電流、浪湧能力與外接保護需求。
- 電池容量、電芯化學系統、`BAT_THERMAL` / `BAT_ID` 的實際判讀規則。
- USB-C 的資料角色、供電協商、韌體功能與任何按鍵操作行為。
- 任何未在此圖上標出的感測器校正、LED 顏色或通訊協定。
