import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Page } from 'playwright-core';
import { PNG } from 'pngjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = join(root, 'artifacts');
const appUrl = process.env.UI_TEST_URL ?? 'http://localhost:5173';
const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH
  ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

interface ValidationResult {
  viewport: { width: number; height: number };
  canvas: { width: number; height: number };
  scrollWidth: number;
  scrollHeight: number;
  uniqueCanvasColors: number;
  status: string;
  vehicleCount: string;
  fleetRows: number;
  unknownScheduleRows: number;
  scheduleMetricText: string[];
  legendText: string;
  lineStoryText?: string;
  lineStatusSegments?: number;
  threeDimensionalCanvasColors?: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function compositedColorCount(buffer: Buffer) {
  const image = PNG.sync.read(buffer);
  const colors = new Set<string>();
  const pixelCount = image.width * image.height;
  const stride = Math.max(1, Math.floor(pixelCount / 10_000));
  for (let pixel = 0; pixel < pixelCount; pixel += stride) {
    const index = pixel * 4;
    colors.add(
      `${image.data[index]},${image.data[index + 1]},${image.data[index + 2]},${image.data[index + 3]}`
    );
    if (colors.size > 80) break;
  }
  return colors.size;
}

async function deselectFromMap(page: Page, name: string) {
  const mapBounds = await page.locator('.transit-map').boundingBox();
  assert(mapBounds, `${name}: map bounds are unavailable.`);
  const candidatePoints = [
    [0.84, 0.38],
    [0.68, 0.24],
    [0.52, 0.42],
  ];
  for (const [horizontal, vertical] of candidatePoints) {
    await page.mouse.click(
      mapBounds.x + mapBounds.width * horizontal,
      mapBounds.y + mapBounds.height * vertical
    );
    await page.waitForTimeout(250);
    if (await page.locator('.line-story').count() === 0) return;
  }
  throw new Error(`${name}: map background did not clear vehicle selection.`);
}

async function validateViewport(
  page: Page,
  name: string,
  viewport: { width: number; height: number },
  exerciseInteractions: boolean
): Promise<ValidationResult> {
  await page.setViewportSize(viewport);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main.operations-shell');
  await page.waitForSelector('.transit-map-shell[data-map-ready="true"]', { timeout: 30_000 });
  await page.waitForTimeout(3000);

  let lineStoryText: string | undefined;
  let lineStatusSegments: number | undefined;
  let threeDimensionalCanvasColors: number | undefined;
  if (exerciseInteractions) {
    await page.getByTitle('Pause playback').click();
    const firstVehicle = page.locator('.fleet-row').first();
    await firstVehicle.evaluate((element) => (element as HTMLButtonElement).click());
    await page.waitForSelector('.line-story');
    lineStoryText = (await page.locator('.line-story').textContent()) ?? '';
    lineStatusSegments = await page.locator('.line-status-chart > span').count();
    assert(lineStoryText.includes('Current line snapshot'), `${name}: line story heading is missing.`);
    assert(lineStoryText.includes('Vehicle'), `${name}: selected vehicle context is missing.`);
    assert(lineStatusSegments === 4, `${name}: line status chart has ${lineStatusSegments} segments.`);

    await deselectFromMap(page, `${name} 2D`);

    await firstVehicle.evaluate((element) => (element as HTMLButtonElement).click());
    await page.waitForSelector('.line-story');
    await page.getByTitle('Operator log').click();
    await page.getByLabel('Note title').fill('UI validation note');
    await page.getByLabel('Note details').fill('Created by the native Playwright smoke test.');
    await page.getByRole('button', { name: 'Save note' }).click();
    await page.getByText('UI validation note').waitFor();
    await page.getByTitle('Fleet map').click();

    await page.locator('.map-view-control button', { hasText: '3D' })
      .evaluate((element) => (element as HTMLButtonElement).click());
    await page.waitForSelector('.maplibregl-canvas');
    await page.waitForSelector('.maplibre-map-shell[data-map-ready="true"]', {
      timeout: 30_000,
    });
    await page.waitForTimeout(5000);
    threeDimensionalCanvasColors = compositedColorCount(
      await page.locator('.maplibregl-canvas').screenshot()
    );
    assert(
      threeDimensionalCanvasColors > 20,
      `${name}: 3D map appears blank (${threeDimensionalCanvasColors} sampled colors).`
    );
    await page.screenshot({
      path: join(outputDirectory, `ttc-digital-twin-${name}-3d.png`),
      fullPage: true,
    });
    await deselectFromMap(page, `${name} 3D`);
    await page.locator('.map-view-control button', { hasText: '2D' })
      .evaluate((element) => (element as HTMLButtonElement).click());
    await page.waitForSelector('.leaflet-container');
  }

  const metrics = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')?.getBoundingClientRect();
    return {
      viewport: { width: innerWidth, height: innerHeight },
      canvas: { width: canvas?.width ?? 0, height: canvas?.height ?? 0 },
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      status: document.querySelector('.source-status strong')?.textContent ?? '',
      vehicleCount: document.querySelector('.metric-strip strong')?.textContent ?? '',
      fleetRows: document.querySelectorAll('.fleet-row').length,
      unknownScheduleRows: document.querySelectorAll('.vehicle-state.unknown').length,
      scheduleMetricText: Array.from(document.querySelectorAll('.metric-strip > div'))
        .slice(1, 3)
        .map((element) => element.textContent ?? ''),
      legendText: document.querySelector('.map-legend')?.textContent ?? '',
    };
  });
  const mapScreenshot = await page.locator('.map-stage').screenshot();
  const uniqueCanvasColors = compositedColorCount(mapScreenshot);
  const result = {
    ...metrics,
    uniqueCanvasColors,
    lineStoryText,
    lineStatusSegments,
    threeDimensionalCanvasColors,
  };

  assert(metrics.viewport.width === viewport.width, `${name}: viewport width mismatch.`);
  assert(metrics.canvas.width >= Math.min(220, viewport.width / 2), `${name}: map canvas is too narrow.`);
  assert(metrics.canvas.height >= 400, `${name}: map canvas is too short.`);
  assert(metrics.scrollWidth <= viewport.width, `${name}: horizontal overflow detected.`);
  assert(uniqueCanvasColors > 20, `${name}: composited map appears blank (${uniqueCanvasColors} sampled colors).`);
  assert(Number(metrics.vehicleCount) > 0, `${name}: no fleet telemetry rendered.`);
  assert(
    metrics.fleetRows === Number(metrics.vehicleCount),
    `${name}: fleet panel shows ${metrics.fleetRows} of ${metrics.vehicleCount} tracked vehicles.`
  );
  for (const label of ['Bus', 'Streetcar', 'Subway', 'Stop', 'Delayed', 'Not reported']) {
    assert(metrics.legendText.includes(label), `${name}: map legend is missing '${label}'.`);
  }
  if (metrics.unknownScheduleRows === metrics.fleetRows) {
    assert(
      metrics.scheduleMetricText.every((metric) => metric.includes('N/A') && metric.includes('Estimate unavailable')),
      `${name}: all schedule data is unknown but summary metrics still claim schedule performance.`
    );
  } else {
    assert(
      metrics.scheduleMetricText.every((metric) => !metric.includes('N/A')),
      `${name}: computed schedule data exists but summary metrics still show N/A.`
    );
  }

  await page.screenshot({
    path: join(outputDirectory, `ttc-digital-twin-${name}.png`),
    fullPage: true,
  });
  return result;
}

async function main() {
  mkdirSync(outputDirectory, { recursive: true });
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors: string[] = [];
    const mapResponses: string[] = [];
    const failedRequests: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });
    page.on('response', (response) => {
      if (response.url().includes('openfreemap')) {
        mapResponses.push(`${response.status()} ${response.request().resourceType()} ${response.url()}`);
      }
    });
    page.on('requestfailed', (request) => {
      failedRequests.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`);
    });

    let desktop: ValidationResult;
    let mobile: ValidationResult;
    try {
      desktop = await validateViewport(page, 'desktop', { width: 1440, height: 900 }, true);
      mobile = await validateViewport(page, 'mobile', { width: 390, height: 844 }, false);
    } catch (error) {
      const warning = await page.locator('.map-warning').textContent().catch(() => null);
      const ready = await page.locator('.transit-map-shell').getAttribute('data-map-ready').catch(() => null);
      console.error(JSON.stringify({ warning, ready, errors, mapResponses, failedRequests }, null, 2));
      throw error;
    }
    assert(errors.length === 0, `Browser errors: ${errors.join(' | ')}`);
    assert(
      mapResponses.some((response) => response.includes('.pbf')),
      '3D validation did not receive any vector tiles.'
    );
    console.log(JSON.stringify({ desktop, mobile }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});