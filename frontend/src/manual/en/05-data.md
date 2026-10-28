# Recordings and analysis

## CSV Export

**CSV Export** has every recording saved on this server.

Each recording is one folder:

```
<device UID>/<date>/<time>/
  <time>.data.csv     sensor data
  <time>.events.csv   app events (only if there were any)
  <time>.meta.json    device and recording details
```

Dates and times in folder names are in UTC.

- Double-click a folder to open it, or a file to download it.
- The zip button next to a folder downloads the whole folder.
- Select a recording to see its timeline and details on the right.
- The analyze button opens the recording in **Tools > Data Analysis**.

## Data Analysis

Open **Tools**, then **Data Analysis**. Pick a recording from this server, or open `.data.csv` files from your computer.

It shows:

- How long the recording is, the sample rate, and whether frames were lost.
- Total pressure, peak and contact area over time. Drag across the chart to zoom in, double-click to see everything.
- A heatmap at the cursor, or the mean or peak over the selected range.
- A table of every sensor. Click sensors in the heatmap or the table to plot them (up to 8).
- IMU data and app events, if the recording has them.

**Export range** saves only the part you zoomed into as a new CSV.

## Sensor numbers

Sensors are numbered P1, P2, … row by row, starting at the top left. The same numbers are used in the CSV columns, the heatmap and the profile editor.
