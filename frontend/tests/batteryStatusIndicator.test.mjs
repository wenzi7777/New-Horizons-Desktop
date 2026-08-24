import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { createServer } from "vite";

async function renderBattery(fillPercent) {
  const server = await createServer({ root: process.cwd(), logLevel: "error" });
  try {
    const { BatteryStatusIndicator } = await server.ssrLoadModule("/src/components/BatteryStatusIndicator.tsx");
    return renderToStaticMarkup(createElement(BatteryStatusIndicator, {
      fillPercent,
      charging: false,
      ariaLabel: "Battery",
    }));
  } finally {
    await server.close();
  }
}

test("battery fill shrinks horizontally while keeping the battery height", async () => {
  const markup = await renderBattery(50);

  assert.match(markup, /class="battery-status-indicator-fill" x="4" y="5" width="8" height="12"/);
});
