import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, type Page, type Route } from 'playwright-core';
import { PNG } from 'pngjs';

import type { StaticNetworkAsset, TransitSnapshot } from '../src/types/transit.js';

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

function metricFixture(count = 4, ageSeconds = 0): TransitSnapshot {
  const observedAt = new Date(Date.now() - ageSeconds * 1000).toISOString();
  return {
    source: 'ttc-gtfs-rt',
    observedAt,
    vehicles: Array.from({ length: count }, (_, index) => {
      const deviation = [0, 240, -121, null][index % 4];
      return {
        id: `fixture-${index}`,
        routeId: index % 2 === 0 ? '29' : '504',
        tripId: `fixture-trip-${index}`,
        label: `Test vehicle ${index}`,
        mode: index % 2 === 0 ? 'bus' : 'streetcar',
        latitude: 43.645 + (index % 20) * 0.003,
        longitude: -79.43 + (index % 30) * 0.003,
        bearing: 0,
        speedKph: 20,
        scheduleDeviationSeconds: deviation,
        occupancy: 'unknown',
        state: deviation === null ? 'unknown' : deviation > 180 ? 'delayed' : deviation < -120 ? 'early' : 'on-time',
        observedAt,
      };
    }),
    alerts: [{
      id: 'fixture-alert',
      severity: 'warning',
      title: 'Test service alert',
      description: 'Browser validation fixture, not a live notice.',
      routeIds: ['29'],
      updatedAt: observedAt,
    }],
  };
}

async function validateMetricLayout(page: Page, name: string) {
  const layout = await page.evaluate(() => {
    const issues: string[] = [];
    const metrics = Array.from(document.querySelectorAll<HTMLElement>('.network-metric'));
    for (const metric of metrics) {
      const bounds = metric.getBoundingClientRect();
      if (bounds.width === 0 || bounds.height === 0) issues.push(`${metric.ariaLabel}: hidden`);
      const children = Array.from(metric.children).map((child) => child.getBoundingClientRect());
      for (const [index, child] of children.entries()) {
        if (child.left < bounds.left - 1 || child.right > bounds.right + 1 || child.bottom > bounds.bottom + 1) {
          issues.push(`${metric.ariaLabel}: clipped content`);
        }
        for (const sibling of children.slice(index + 1)) {
          if (Math.min(child.right, sibling.right) - Math.max(child.left, sibling.left) > 1 &&
              Math.min(child.bottom, sibling.bottom) - Math.max(child.top, sibling.top) > 1) {
            issues.push(`${metric.ariaLabel}: overlapping content`);
          }
        }
      }
    }
    const status = document.querySelector('.source-status')?.getBoundingClientRect();
    return {
      issues,
      count: metrics.length,
      statusVisible: Boolean(status && status.height > 0 && status.bottom <= innerHeight),
      width: innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      values: metrics.map((metric) => metric.querySelector('strong')?.textContent),
    };
  });
  assert(layout.count === 4, `${name}: expected four network metrics.`);
  assert(layout.statusVisible, `${name}: telemetry source status is hidden.`);
  assert(layout.scrollWidth <= layout.width, `${name}: horizontal overflow detected.`);
  assert(layout.issues.length === 0, `${name}: ${layout.issues.join(', ')}`);
  await page.screenshot({ path: join(outputDirectory, `ttc-metrics-${name}.png`) });
  return layout;
}

async function validateNetworkMetrics(page: Page) {
  let fixture = metricFixture();
  let unavailable = false;
  let loading = true;
  const pending: Route[] = [];
  await page.route(/\/api\/(live|snapshot)(?:\?.*)?$/, async (route) => {
    if (loading) {
      pending.push(route);
      return;
    }
    if (unavailable) {
      await route.fulfill({ status: 503, json: { error: 'Test outage' } });
      return;
    }
    await route.fulfill({ json: fixture });
  });
  const summary = page.getByRole('region', { name: 'Network summary' });
  const values = () => summary.locator('.network-metric > strong').allTextContents();
  const expectValues = async (expected: string[], name: string) => {
    const actual = await values();
    assert(JSON.stringify(actual) === JSON.stringify(expected), `${name}: ${JSON.stringify(actual)}`);
  };

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await summary.waitFor();
  await expectValues(['...', '...', '...', '...'], 'loading');
  await page.screenshot({ path: join(outputDirectory, 'ttc-metrics-loading.png') });
  loading = false;
  for (const route of pending) await route.fulfill({ json: fixture });
  await page.locator('.metric-strip[data-state="connected"]').waitFor();
  await expectValues(['4', '33%', '1', '1'], 'connected');

  unavailable = true;
  await page.getByTitle('Refresh feed').click();
  await page.locator('.metric-strip[data-state="degraded"]').waitFor();
  await expectValues(['4', '33%', '1', '1'], 'retained snapshot');
  assert((await summary.textContent())?.includes('Last known fleet'), 'Outage lost last-known provenance.');
  await page.screenshot({ path: join(outputDirectory, 'ttc-metrics-last-known.png') });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.metric-strip[data-state="degraded"]').waitFor();
  await expectValues(['N/A', 'N/A', 'N/A', 'N/A'], 'unavailable');

  unavailable = false;
  fixture = { ...metricFixture(0), alerts: [] };
  await page.getByTitle('Refresh feed').click();
  await page.locator('.metric-strip[data-state="connected"]').waitFor();
  await expectValues(['0', 'N/A', 'N/A', '0'], 'empty snapshot');

  fixture = metricFixture();
  fixture.vehicles = fixture.vehicles.map((vehicle) => ({ ...vehicle, scheduleDeviationSeconds: null, state: 'unknown' }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.metric-strip[data-state="connected"]').waitFor();
  await expectValues(['4', 'N/A', 'N/A', '1'], 'missing estimates');

  fixture = metricFixture(4, 300);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.locator('.metric-strip[data-state="stale"]').waitFor();
  assert((await page.getByRole('status').textContent())?.includes('Last known 5m ago'), 'Stale age is missing.');
  await page.screenshot({ path: join(outputDirectory, 'ttc-metrics-stale.png') });

  await page.getByTitle('Pause playback').click();
  await page.locator('.metric-strip[data-state="paused"]').waitFor();
  assert((await page.getByRole('status').textContent())?.includes('Updates paused'), 'Pause status is missing.');

  fixture = metricFixture(1248);
  const layouts: Array<Awaited<ReturnType<typeof validateMetricLayout>>> = [];
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: width >= 768 ? 900 : 844 });
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.metric-strip[data-state="connected"]').waitFor();
    await expectValues(['1,248', '33%', '312', '1'], `viewport ${width}`);
    layouts.push(await validateMetricLayout(page, String(width)));
  }
  fixture = metricFixture();
  return { states: ['loading', 'connected', 'last-known', 'unavailable', 'empty', 'unknown', 'stale', 'paused'], layouts };
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
  await page.getByTitle('Fleet map', { exact: true }).click();
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
  const vehicleCount = Number(metrics.vehicleCount.replaceAll(',', ''));
  assert(vehicleCount > 0, `${name}: no fleet telemetry rendered.`);
  assert(
    metrics.fleetRows === vehicleCount,
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

async function validateSpatialData(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/\/api\/(live|snapshot)(?:\?.*)?$/, (route) =>
    route.fulfill({ json: { ...metricFixture(0), alerts: [] } })
  );
  const response = await page.request.get(`${appUrl}/data/gta-network.json`);
  assert(response.ok(), 'The real spatial asset could not be loaded.');
  const network = await response.json() as StaticNetworkAsset;
  assert(network.routes.every((route) => route.paths?.length), 'Route shape associations are missing.');
  assert(network.stops.every((stop) => stop.routeIds?.length), 'Stop route associations are missing.');
  const results: Array<{
    width: number;
    view: string;
    mode: 'all' | 'bus' | 'streetcar' | 'subway' | 'rail';
    agency?: 'ttc' | 'go' | 'up';
    focusedRouteId?: string;
    focusedStops?: number;
    routes: number;
    paths: number;
    stops: number;
    canvasColors: number;
  }> = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('radiogroup', { name: 'Route agencies' }).waitFor();
    assert(await page.getByRole('radio', { name: 'GO Transit', exact: true }).isVisible(), 'GO route choice is not visible on first load.');
    assert(await page.getByRole('radio', { name: 'UP Express', exact: true }).isVisible(), 'UP route choice is not visible on first load.');
    for (const view of ['2D', '3D']) {
      await page.getByRole('combobox', { name: 'Transit agency' }).selectOption('all');
      await page.locator('.map-view-control').getByRole('button', { name: view, exact: true }).click();
      const selector = view === '3D' ? '.maplibre-map-shell' : '.transit-map-shell:not(.maplibre-map-shell)';
      await page.locator(`${selector}[data-map-ready="true"]`).waitFor({ timeout: 45_000 });
      for (const mode of ['bus', 'streetcar', 'subway', 'rail'] as const) {
        const routes = network.routes.filter((route) => route.mode === mode);
        const routeIds = new Set(routes.map((route) => route.id));
        const stops = network.stops.filter((stop) => stop.routeIds?.some((routeId) => routeIds.has(routeId)));
        const paths = routes.reduce((count, route) => count + (route.paths?.length ?? 1), 0);
        await page.getByRole('button', { name: mode, exact: true }).click();
        await page.waitForFunction(({ selector, routes, paths, stops }) => {
          const map = document.querySelector<HTMLElement>(selector);
          return map?.dataset.routeCount === String(routes) &&
            map.dataset.routePathCount === String(paths) && map.dataset.stopCount === String(stops);
        }, { selector, routes: routes.length, paths, stops: stops.length });
        await page.waitForLoadState('networkidle');
        const canvas = page.locator(`${selector} canvas`).first();
        await canvas.waitFor();
        const colors = compositedColorCount(await canvas.screenshot());
        assert(colors > 20, `${view} ${mode}: map canvas is blank (${colors} colors).`);
        const overflows = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
        assert(!overflows, `${view} ${mode}: horizontal overflow.`);
        await page.screenshot({ path: join(outputDirectory, `gta-spatial-${viewport.width}-${view}-${mode}.png`), fullPage: true });
        results.push({ width: viewport.width, view, mode, routes: routes.length, paths, stops: stops.length, canvasColors: colors });
      }
      await page.getByRole('button', { name: 'All modes', exact: true }).click();
      for (const agency of ['ttc', 'go', 'up'] as const) {
        const routes = network.routes.filter((route) => route.agency === agency);
        const routeIds = new Set(routes.map((route) => route.id));
        const stops = network.stops.filter((stop) => stop.routeIds?.some((routeId) => routeIds.has(routeId)));
        const paths = routes.reduce((count, route) => count + (route.paths?.length ?? 1), 0);
        assert(routes.length > 0, `No ${agency} routes were imported.`);
        await page.getByTitle('Network routes', { exact: true }).click();
        await page.getByRole('radio', { name: { ttc: 'TTC', go: 'GO Transit', up: 'UP Express' }[agency], exact: true }).check();
        await page.getByTitle('Network routes', { exact: true }).click();
        await page.waitForFunction(({ selector, routes, paths, stops }) => {
          const map = document.querySelector<HTMLElement>(selector);
          return map?.dataset.routeCount === String(routes) &&
            map.dataset.routePathCount === String(paths) && map.dataset.stopCount === String(stops);
        }, { selector, routes: routes.length, paths, stops: stops.length });
        const feed = network.feeds?.find((candidate) => candidate.agency === agency);
        assert(feed, `Missing ${agency} feed provenance.`);
        await page.locator('.network-feed-details summary').click();
        const download = page.getByRole('link', { name: `Download ${feed.name} GTFS`, exact: true });
        assert(await download.getAttribute('href') === feed.sourceUrl, `${agency}: wrong feed download link.`);
        await page.locator('.network-feed-details summary').click();
        const focused = routes[0];
        const focusedStops = stops.filter((stop) => stop.routeIds?.includes(focused.id)).length;
        await page.getByRole('button', { name: `Focus ${feed.name} route ${focused.shortName}: ${focused.longName}`, exact: true }).click();
        await page.waitForFunction(({ selector, routeId, stopCount }) => {
          const map = document.querySelector<HTMLElement>(selector);
          return map?.dataset.focusedRoute === routeId && map.dataset.stopCount === String(stopCount);
        }, { selector, routeId: focused.id, stopCount: focusedStops });
        assert(await page.getByRole('region', { name: 'Route details' }).isVisible(), `${agency}: route details are hidden.`);
        await page.waitForLoadState('networkidle');
        const colors = compositedColorCount(await page.locator(`${selector} canvas`).first().screenshot());
        assert(colors > 20, `${view} ${agency}: focused map is blank.`);
        const layout = await page.evaluate(() => {
          const controls = document.querySelector('.map-filter-bar')!.getBoundingClientRect();
          const legend = document.querySelector('.map-legend')!.getBoundingClientRect();
          return { overflow: document.documentElement.scrollWidth > innerWidth, overlapping: controls.bottom > legend.top + 1 };
        });
        assert(!layout.overflow && !layout.overlapping, `${view} ${agency}: overlapping controls or horizontal overflow.`);
        await page.screenshot({ path: join(outputDirectory, `gta-agency-${viewport.width}-${view}-${agency}.png`), fullPage: true });
        results.push({ width: viewport.width, view, mode: 'all', agency, focusedRouteId: focused.id, focusedStops, routes: routes.length, paths, stops: stops.length, canvasColors: colors });
        await page.getByRole('button', { name: 'Clear route selection', exact: true }).click();
      }
    }
  }
  assert(errors.length === 0, `Spatial browser errors: ${errors.join(' | ')}`);
  return results;
}

async function main() {
  mkdirSync(outputDirectory, { recursive: true });
  const browser = await chromium.launch({
    executablePath,
    headless: true,
    args: ['--enable-webgl', '--ignore-gpu-blocklist', '--use-angle=swiftshader'],
  });
  try {
    const context = await browser.newContext({ locale: 'en-US' });
    const page = await context.newPage();
    if (process.env.UI_TEST_SPATIAL_ONLY === 'true') {
      const spatial = await validateSpatialData(page);
      console.log(JSON.stringify({ fixtureTelemetry: true, officialSpatialData: true, spatial }, null, 2));
      return;
    }
    const networkMetrics = process.env.UI_TEST_FIXTURES === 'true'
      ? await validateNetworkMetrics(page)
      : undefined;
    if (process.env.UI_TEST_METRICS_ONLY === 'true') {
      assert(networkMetrics, 'Metrics-only validation requires UI_TEST_FIXTURES=true.');
      console.log(JSON.stringify({ fixtureData: true, networkMetrics }, null, 2));
      return;
    }
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
    console.log(JSON.stringify({ desktop, mobile, networkMetrics }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});