import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TransitMap } from '@/components/LeafletTransitMap';
import { useStaticNetwork } from '@/hooks/useStaticNetwork';
import { useTransitFeed } from '@/hooks/useTransitFeed';
import { HomePage } from '@/pages/HomePage';
import type { StaticNetworkAsset, TransitRoute, TransitSnapshot } from '@/types/transit';

vi.mock('@/hooks/useTransitFeed', () => ({ useTransitFeed: vi.fn() }));
vi.mock('@/hooks/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'operator', name: 'Test Operator' }, signOut: vi.fn() }),
}));
vi.mock('@/hooks/useStaticNetwork', () => ({
  useStaticNetwork: vi.fn(),
}));
vi.mock('@/components/LeafletTransitMap', () => ({ TransitMap: vi.fn(() => null) }));
vi.mock('@/components/OperatorLog', () => ({ OperatorLog: () => null }));

const observedAt = '2026-09-25T13:00:00.000Z';
const snapshot: TransitSnapshot = {
  source: 'ttc-gtfs-rt',
  observedAt,
  vehicles: [0, 240, -121, null].map((deviation, index) => ({
    id: `vehicle-${index}`,
    routeId: index < 2 ? '29' : '504',
    tripId: `trip-${index}`,
    label: `Vehicle ${index}`,
    mode: index < 2 ? 'bus' : 'streetcar',
    latitude: 43.67,
    longitude: -79.39,
    bearing: 0,
    speedKph: 20,
    scheduleDeviationSeconds: deviation,
    occupancy: 'unknown',
    state: 'unknown',
    observedAt,
  })),
  alerts: [{
    id: 'alert-1',
    severity: 'warning',
    title: 'Service notice',
    description: 'Route 29 service change',
    routeIds: ['29'],
    updatedAt: observedAt,
  }],
};

function mockFeed(overrides: Partial<ReturnType<typeof useTransitFeed>> = {}) {
  vi.mocked(useTransitFeed).mockReturnValue({
    snapshot,
    connectionState: 'connected',
    hasSnapshot: true,
    observationAgeSeconds: 15,
    isStale: false,
    refreshing: false,
    paused: false,
    error: null,
    liveConfigured: true,
    setPaused: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  });
}

function metric(name: string) {
  return within(screen.getByRole('region', { name: 'Network summary' }))
    .getByRole('group', { name });
}

beforeEach(() => {
  mockFeed();
  vi.mocked(useStaticNetwork).mockReturnValue({ routes: [], asset: null, error: null });
  vi.mocked(TransitMap).mockClear();
});
afterEach(cleanup);

describe('network summary metrics', () => {
  it('renders measured counts, a schedule denominator, and coverage', () => {
    render(<HomePage />);

    expect(metric('Tracked vehicles').querySelector('strong')).toHaveTextContent('4');
    expect(metric('On schedule').querySelector('strong')).toHaveTextContent('33%');
    expect(metric('On schedule')).toHaveTextContent('1 of 3 estimated');
    expect(metric('Delayed').querySelector('strong')).toHaveTextContent('1');
    expect(metric('Delayed')).toHaveTextContent('75% coverage');
    expect(metric('Active alerts').querySelector('strong')).toHaveTextContent('1');
    expect(screen.getByRole('status')).toHaveTextContent('Observed 15s ago');
  });

  it('keeps network totals independent of map filters', () => {
    render(<HomePage />);
    fireEvent.click(screen.getByTitle('Fleet map'));
    fireEvent.click(screen.getByRole('button', { name: /^bus$/ }));

    expect(screen.getByText('2 in view')).toBeInTheDocument();
    expect(metric('Tracked vehicles').querySelector('strong')).toHaveTextContent('4');
    expect(metric('On schedule').querySelector('strong')).toHaveTextContent('33%');
  });

  it('shows loading placeholders instead of zero counts before the first observation', () => {
    mockFeed({
      snapshot: { ...snapshot, observedAt: '', vehicles: [], alerts: [] },
      connectionState: 'connecting',
      hasSnapshot: false,
      observationAgeSeconds: null,
      refreshing: true,
    });
    render(<HomePage />);

    expect(screen.getByRole('region', { name: 'Network summary' })).toHaveAttribute('aria-busy', 'true');
    for (const name of ['Tracked vehicles', 'On schedule', 'Delayed', 'Active alerts']) {
      expect(metric(name).querySelector('strong')).toHaveTextContent('...');
      expect(metric(name)).toHaveTextContent('Awaiting telemetry');
    }
    expect(screen.queryByText(/Invalid Date/)).not.toBeInTheDocument();
    expect(screen.getByTitle('Refresh feed')).toBeDisabled();
  });

  it('distinguishes an unavailable feed from a healthy empty fleet', () => {
    mockFeed({
      snapshot: { ...snapshot, observedAt: '', vehicles: [], alerts: [] },
      connectionState: 'degraded',
      hasSnapshot: false,
      error: 'Feed unavailable',
    });
    const { rerender } = render(<HomePage />);
    expect(metric('Tracked vehicles').querySelector('strong')).toHaveTextContent('N/A');
    expect(metric('Active alerts').querySelector('strong')).toHaveTextContent('N/A');
    expect(screen.getByRole('alert')).toHaveTextContent('Live metrics are unavailable.');

    mockFeed({ snapshot: { ...snapshot, vehicles: [], alerts: [] } });
    rerender(<HomePage />);
    expect(metric('Tracked vehicles').querySelector('strong')).toHaveTextContent('0');
    expect(metric('Active alerts').querySelector('strong')).toHaveTextContent('0');
    expect(metric('On schedule').querySelector('strong')).toHaveTextContent('N/A');
    expect(metric('Delayed').querySelector('strong')).toHaveTextContent('N/A');
  });

  it('does not claim schedule performance when all estimates are missing', () => {
    mockFeed({ snapshot: {
      ...snapshot,
      vehicles: snapshot.vehicles.map((vehicle) => ({ ...vehicle, scheduleDeviationSeconds: null })),
    } });
    render(<HomePage />);

    expect(metric('Tracked vehicles').querySelector('strong')).toHaveTextContent('4');
    for (const name of ['On schedule', 'Delayed']) {
      expect(metric(name).querySelector('strong')).toHaveTextContent('N/A');
      expect(metric(name)).toHaveTextContent('Estimate unavailable');
    }
  });

  it('labels retained data during an outage without claiming simulation', () => {
    mockFeed({ connectionState: 'degraded', error: 'Feed unavailable' });
    render(<HomePage />);

    expect(metric('Tracked vehicles')).toHaveTextContent('Last known fleet');
    expect(metric('Active alerts')).toHaveTextContent('Last known notices');
    expect(screen.getByRole('status')).toHaveTextContent('Live feed degraded');
    expect(screen.getByRole('alert')).toHaveTextContent('Showing the last successful snapshot.');
    expect(screen.queryByText(/simulation/i)).not.toBeInTheDocument();
  });

  it.each([
    { connectionState: 'stale' as const, isStale: true, paused: false, label: 'Live data stale' },
    { connectionState: 'connected' as const, isStale: false, paused: true, label: 'Updates paused' },
  ])('labels $label snapshots with their age', ({ label, ...overrides }) => {
    mockFeed({ ...overrides, observationAgeSeconds: 300 });
    render(<HomePage />);

    expect(screen.getByRole('status')).toHaveTextContent(label);
    expect(screen.getByRole('status')).toHaveTextContent('Last known 5m ago');
    expect(metric('Tracked vehicles')).toHaveTextContent('Last known fleet');
  });

  it('explicitly labels demo values as simulated', () => {
    mockFeed({ snapshot: { ...snapshot, source: 'simulated' }, connectionState: 'simulated', liveConfigured: false });
    render(<HomePage />);

    expect(screen.getByRole('status')).toHaveTextContent('Simulated data, not live');
    expect(metric('Tracked vehicles')).toHaveTextContent('Simulated fleet');
    expect(metric('Active alerts')).toHaveTextContent('Simulated notices');
  });

  it('filters stop-to-route links consistently with bus, streetcar, and subway lines', () => {
    const routes: TransitRoute[] = [
      { id: '29', shortName: '29', longName: 'Dufferin', mode: 'bus', color: '#ED1C24', path: [[-79.4, 43.65], [-79.4, 43.66]] },
      { id: '504', shortName: '504', longName: 'King', mode: 'streetcar', color: '#ED1C24', path: [[-79.4, 43.65], [-79.39, 43.65]] },
      { id: '1', shortName: '1', longName: 'Yonge-University', mode: 'subway', color: '#D5C82B', path: [[-79.38, 43.65], [-79.38, 43.66]] },
    ];
    const asset: StaticNetworkAsset = {
      generatedAt: observedAt, sourceUrl: 'https://example.test/gtfs.zip', licenseUrl: 'https://example.test/license', routes,
      stops: [
        { id: 'bus-stop', name: 'Bus stop', latitude: 43.65, longitude: -79.4, routeIds: ['29'] },
        { id: 'streetcar-stop', name: 'Streetcar stop', latitude: 43.65, longitude: -79.39, routeIds: ['504'] },
        { id: 'rail-stop', name: 'Rail stop', latitude: 43.66, longitude: -79.38, routeIds: ['1'] },
        { id: 'interchange', name: 'Interchange', latitude: 43.65, longitude: -79.38, routeIds: ['29', '1'] },
      ],
      statistics: { routes: 3, stops: 4, trips: 3, services: 1 },
    };
    vi.mocked(useStaticNetwork).mockReturnValue({ routes, asset, error: null });
    render(<HomePage />);

    const renderedStops = () => vi.mocked(TransitMap).mock.calls.at(-1)?.[0].stops.map((stop) => stop.id);
    expect(renderedStops()).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: /^bus$/ }));
    expect(renderedStops()).toEqual(['bus-stop', 'interchange']);
    fireEvent.click(screen.getByRole('button', { name: /^streetcar$/ }));
    expect(renderedStops()).toEqual(['streetcar-stop']);
    fireEvent.click(screen.getByRole('button', { name: /^subway$/ }));
    expect(renderedStops()).toEqual(['rail-stop', 'interchange']);
  });

  it('reports unavailable route geometry without hiding live metrics', () => {
    vi.mocked(useStaticNetwork).mockReturnValue({ routes: [], asset: null, error: 'GTA route geometry is unavailable.' });
    render(<HomePage />);

    expect(screen.getByRole('alert')).toHaveTextContent('GTA route geometry is unavailable.');
    expect(metric('Tracked vehicles').querySelector('strong')).toHaveTextContent('4');
  });

  it('shows GO and UP scheduled routes without fabricating regional live vehicles', () => {
    const routes: TransitRoute[] = [
      { id: '29', agency: 'ttc', shortName: '29', longName: 'Dufferin', mode: 'bus', color: '#ED1C24', path: [[-79.4, 43.65], [-79.4, 43.66]] },
      { id: 'go:LW', agency: 'go', shortName: 'LW', longName: 'Lakeshore West', mode: 'rail', color: '#007934', scheduledTrips: 50, path: [[-79.38, 43.65], [-79.6, 43.55]] },
      { id: 'up:UP', agency: 'up', shortName: 'UP', longName: 'Union Pearson Express', mode: 'rail', color: '#5B4B36', scheduledTrips: 25, path: [[-79.38, 43.65], [-79.63, 43.68]] },
    ];
    const names = { ttc: 'TTC', go: 'GO Transit', up: 'UP Express' };
    const asset: StaticNetworkAsset = {
      generatedAt: observedAt, sourceUrl: 'https://example.test/ttc.zip', licenseUrl: 'https://example.test/license', routes,
      stops: [
        { id: 'ttc-stop', agency: 'ttc', name: 'Dufferin', latitude: 43.65, longitude: -79.4, routeIds: ['29'] },
        { id: 'go:union', agency: 'go', name: 'Union GO', latitude: 43.65, longitude: -79.38, routeIds: ['go:LW'] },
        { id: 'up:pearson', agency: 'up', name: 'Pearson', latitude: 43.68, longitude: -79.63, routeIds: ['up:UP'] },
      ],
      statistics: { routes: 3, stops: 3, trips: 76, services: 3 },
      feeds: (['ttc', 'go', 'up'] as const).map((agency) => ({
        agency, name: names[agency], sourceUrl: `https://example.test/${agency}.zip`,
        licenseUrl: 'https://example.test/license', generatedAt: observedAt,
        files: ['routes.txt', 'trips.txt', 'stop_times.txt'], routes: 1, stops: 1, trips: 25, services: 1, shapes: 1,
      })),
    };
    vi.mocked(useStaticNetwork).mockReturnValue({ routes, asset, error: null });
    render(<HomePage />);

    expect(screen.getByRole('heading', { name: 'GTA transit digital twin' })).toBeInTheDocument();
    expect(screen.getByText('Scheduled network')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Focus GO Transit route LW: Lakeshore West' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Focus UP Express route UP: Union Pearson Express' })).toBeInTheDocument();
    const agencies = screen.getByRole('radiogroup', { name: 'Route agencies' });
    expect(within(agencies).getByRole('radio', { name: 'All' })).toBeChecked();
    fireEvent.click(within(agencies).getByRole('radio', { name: 'GO Transit' }));
    expect(screen.getByRole('combobox', { name: 'Transit agency' })).toHaveValue('go');
    const goRoute = screen.getByRole('button', { name: 'Focus GO Transit route LW: Lakeshore West' });
    fireEvent.click(goRoute);
    expect(vi.mocked(TransitMap).mock.calls.at(-1)?.[0]).toMatchObject({
      focusedRouteId: 'go:LW', vehicles: [], stops: [{ id: 'go:union' }],
    });
    expect(within(screen.getByRole('region', { name: 'Route details' })).getByText('Union GO')).toBeInTheDocument();
    expect(metric('Tracked vehicles').querySelector('strong')).toHaveTextContent('4');

    fireEvent.click(screen.getByRole('button', { name: /^bus$/ }));
    fireEvent.click(within(agencies).getByRole('radio', { name: 'UP Express' }));
    fireEvent.click(screen.getByRole('button', { name: 'Focus UP Express route UP: Union Pearson Express' }));
    expect(vi.mocked(TransitMap).mock.calls.at(-1)?.[0]).toMatchObject({
      focusedRouteId: 'up:UP', vehicles: [], stops: [{ id: 'up:pearson' }],
    });
    expect(within(screen.getByRole('region', { name: 'Route details' })).getByText('Pearson')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear route selection' }));
    expect(vi.mocked(TransitMap).mock.calls.at(-1)?.[0].focusedRouteId).toBeNull();
  });
});
