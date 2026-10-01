import { lazy, Suspense, useMemo, useState } from 'react';
import {
  BellRing,
  Boxes,
  BusFront,
  Clock3,
  LogOut,
  Map,
  NotebookPen,
  Pause,
  Play,
  Radio,
  RefreshCw,
  Route as RouteIcon,
  Search,
  TrainFront,
  TramFront,
  TriangleAlert,
} from 'lucide-react';

import { OperatorLog } from '@/components/OperatorLog';
import { NetworkRoutes } from '@/components/NetworkRoutes';
import { TransitMap } from '@/components/LeafletTransitMap';
import {
  summarizeLineOperations,
  summarizeNetworkOperations,
  summarizeRouteDelays,
  type DelayComparisonMode,
  type LineOperationsSummary,
  type RouteDelaySummary,
} from '@/data/delayAnalytics';
import { TTC_ROUTES } from '@/data/demoNetwork';
import { useAuth } from '@/hooks/AuthContext';
import { useStaticNetwork } from '@/hooks/useStaticNetwork';
import { useTransitFeed } from '@/hooks/useTransitFeed';
import type {
  TransitAgency,
  TransitMode,
  VehicleState,
  VehicleTelemetry,
} from '@/types/transit';

import './HomePage.css';

type Panel = 'fleet' | 'network' | 'alerts' | 'notes';
type ModeFilter = 'all' | TransitMode;
type AgencyFilter = 'all' | TransitAgency;
type MapView = '2d' | '3d';

const agencyNames: Record<TransitAgency, string> = { ttc: 'TTC', go: 'GO Transit', up: 'UP Express' };

const MapLibreTransitMap = lazy(() =>
  import('@/components/MapLibreTransitMap').then((module) => ({
    default: module.MapLibreTransitMap,
  }))
);

const modeIcons = {
  bus: BusFront,
  streetcar: TramFront,
  subway: TrainFront,
  rail: TrainFront,
};

const lineStateOrder: VehicleState[] = [
  'on-time',
  'delayed',
  'early',
  'unknown',
];

const lineStateLabels: Record<VehicleState, string> = {
  'on-time': 'On time',
  delayed: 'Delayed',
  early: 'Early',
  unknown: 'Not reported',
};

function formatDeviation(seconds: number | null) {
  if (seconds == null) return 'Not reported';
  const absoluteMinutes = Math.max(0, Math.round(Math.abs(seconds) / 60));
  if (Math.abs(seconds) < 30) return 'On schedule';
  return `${absoluteMinutes} min ${seconds > 0 ? 'late' : 'early'}`;
}

function FleetRow({
  vehicle,
  selected,
  onSelect,
}: {
  vehicle: VehicleTelemetry;
  selected: boolean;
  onSelect: () => void;
}) {
  const ModeIcon = modeIcons[vehicle.mode];
  return (
    <button type="button" className={`fleet-row ${selected ? 'selected' : ''}`} onClick={onSelect}>
      <span className={`mode-icon ${vehicle.mode}`}><ModeIcon size={15} /></span>
      <span className="fleet-identity">
        <strong>{vehicle.label}</strong>
        <small>{vehicle.id}</small>
      </span>
      <span className={`vehicle-state ${vehicle.state}`}>
        {formatDeviation(vehicle.scheduleDeviationSeconds)}
      </span>
    </button>
  );
}

function LineStory({
  summary,
  vehicles,
  selectedVehicle,
  routeName,
  routeColor,
  onAddNote,
}: {
  summary: LineOperationsSummary;
  vehicles: VehicleTelemetry[];
  selectedVehicle: VehicleTelemetry;
  routeName: string;
  routeColor: string;
  onAddNote: () => void;
}) {
  const ModeIcon = modeIcons[summary.mode];
  const scheduledVehicles = vehicles
    .filter(
      (vehicle): vehicle is VehicleTelemetry & {
        scheduleDeviationSeconds: number;
      } => vehicle.scheduleDeviationSeconds != null
    )
    .sort(
      (left, right) =>
        right.scheduleDeviationSeconds - left.scheduleDeviationSeconds
    );
  const maximumDeviation = Math.max(
    180,
    ...scheduledVehicles.map((vehicle) =>
      Math.abs(vehicle.scheduleDeviationSeconds)
    )
  );
  const modeNoun =
    summary.mode === 'bus'
      ? 'buses'
      : summary.mode === 'streetcar'
        ? 'streetcars'
        : 'trains';
  const delayStory =
    summary.states.delayed === 0
      ? 'No vehicles are more than three minutes late.'
      : `${summary.states.delayed} ${summary.states.delayed === 1 ? 'vehicle is' : 'vehicles are'} more than three minutes late.`;

  return (
    <section
      className="line-story"
      aria-label={`Current story for line ${summary.routeId}`}
    >
      <header>
        <div
          className="line-story-route"
          style={{ backgroundColor: routeColor }}
        >
          <ModeIcon size={13} aria-hidden="true" />
          <strong>{summary.routeId}</strong>
        </div>
        <div className="line-story-title">
          <span>Current line snapshot</span>
          <strong>{routeName}</strong>
        </div>
        <button type="button" onClick={onAddNote} title="Add operator note">
          <NotebookPen size={15} />
        </button>
      </header>

      <div className="line-story-metrics">
        <div><span>Active</span><strong>{summary.activeVehicles}</strong></div>
        <div><span>Coverage</span><strong>{summary.scheduleCoveragePercent}%</strong></div>
        <div>
          <span>Avg delay</span>
          <strong>
            {summary.scheduledVehicles > 0
              ? `${summary.averagePositiveDelayMinutes.toFixed(1)}m`
              : 'N/A'}
          </strong>
        </div>
      </div>

      <div className="line-status-chart-block">
        <div
          className="line-status-chart"
          role="img"
          aria-label={lineStateOrder
            .map(
              (state) =>
                `${lineStateLabels[state]} ${summary.statePercentages[state]} percent`
            )
            .join(', ')}
        >
          {lineStateOrder.map((state) => (
            <span
              key={state}
              className={state}
              style={{ width: `${summary.statePercentages[state]}%` }}
            />
          ))}
        </div>
        <div className="line-status-key">
          {lineStateOrder.map((state) => (
            <span key={state}>
              <i className={state} aria-hidden="true" />
              {lineStateLabels[state]}
              <strong>{summary.states[state]}</strong>
              <small>{summary.statePercentages[state]}%</small>
            </span>
          ))}
        </div>
      </div>

      <div className="line-deviation-spread">
        <span>Vehicle delay spread</span>
        {scheduledVehicles.length > 0 ? (
          <div
            className="line-deviation-bars"
            aria-label="Vehicle schedule deviation chart"
          >
            {scheduledVehicles.slice(0, 24).map((vehicle) => (
              <i
                key={vehicle.id}
                className={vehicle.state}
                style={{
                  height: `${Math.max(
                    3,
                    (Math.abs(vehicle.scheduleDeviationSeconds) /
                      maximumDeviation) *
                      15
                  )}px`,
                }}
                title={`${vehicle.id}: ${formatDeviation(vehicle.scheduleDeviationSeconds)}`}
              />
            ))}
          </div>
        ) : (
          <small>Schedule estimates unavailable</small>
        )}
      </div>

      <div className="selected-vehicle-story">
        <div>
          <span>Vehicle {selectedVehicle.id}</span>
          <strong>{formatDeviation(selectedVehicle.scheduleDeviationSeconds)}</strong>
        </div>
        <dl>
          <div><dt>Speed</dt><dd>{selectedVehicle.speedKph} km/h</dd></div>
          <div><dt>Load</dt><dd>{selectedVehicle.occupancy}</dd></div>
          <div><dt>Trip</dt><dd>{selectedVehicle.tripId}</dd></div>
        </dl>
      </div>
      <p>
        {summary.activeVehicles} active {modeNoun}. {delayStory} Selected
        vehicle {selectedVehicle.id} is{' '}
        {formatDeviation(selectedVehicle.scheduleDeviationSeconds).toLowerCase()}.
      </p>
    </section>
  );
}

function DelayBars({
  mode,
  routes,
  maximumDelay,
}: {
  mode: DelayComparisonMode;
  routes: RouteDelaySummary[];
  maximumDelay: number;
}) {
  const ModeIcon = modeIcons[mode];
  return (
    <div className={`delay-mode ${mode}`}>
      <div className="delay-mode-heading">
        <ModeIcon size={13} aria-hidden="true" />
        <span>{mode}</span>
      </div>
      <div className="delay-route-bars">
        {routes.length > 0 ? routes.map((route) => (
          <div
            className="delay-route-row"
            key={`${mode}-${route.routeId}`}
            aria-label={`${mode} route ${route.routeId}: ${route.averageDelayMinutes.toFixed(1)} minutes average delay across ${route.trackedVehicles} vehicles`}
          >
            <strong>{route.routeId}</strong>
            <span className="delay-bar-track" aria-hidden="true">
              <span
                className="delay-bar-fill"
                style={{
                  width: `${Math.max(6, (route.averageDelayMinutes / maximumDelay) * 100)}%`,
                }}
              />
            </span>
            <span>{route.averageDelayMinutes.toFixed(1)}m</span>
          </div>
        )) : <p>No delayed lines</p>}
      </div>
    </div>
  );
}

function DelayComparisonChart({ vehicles }: { vehicles: VehicleTelemetry[] }) {
  const busRoutes = useMemo(
    () => summarizeRouteDelays(vehicles, 'bus'),
    [vehicles]
  );
  const streetcarRoutes = useMemo(
    () => summarizeRouteDelays(vehicles, 'streetcar'),
    [vehicles]
  );
  const maximumDelay = Math.max(
    1,
    ...busRoutes.map((route) => route.averageDelayMinutes),
    ...streetcarRoutes.map((route) => route.averageDelayMinutes)
  );

  return (
    <section
      className="delay-comparison"
      aria-label="Most delayed bus and streetcar lines"
    >
      <header>
        <div>
          <span>Live delay comparison</span>
          <strong>Most delayed lines</strong>
        </div>
        <small>Avg positive delay</small>
      </header>
      <div className="delay-comparison-grid">
        <DelayBars mode="bus" routes={busRoutes} maximumDelay={maximumDelay} />
        <DelayBars
          mode="streetcar"
          routes={streetcarRoutes}
          maximumDelay={maximumDelay}
        />
      </div>
    </section>
  );
}

export function HomePage() {
  const { signOut, user } = useAuth();
  const {
    snapshot,
    connectionState,
    hasSnapshot,
    observationAgeSeconds,
    isStale,
    refreshing,
    paused,
    error,
    liveConfigured,
    setPaused,
    refresh,
  } = useTransitFeed();
  const { routes: networkRoutes, asset: staticNetwork, error: networkError } = useStaticNetwork();
  const [activePanel, setActivePanel] = useState<Panel>('network');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [agencyFilter, setAgencyFilter] = useState<AgencyFilter>('all');
  const [focusedRouteId, setFocusedRouteId] = useState<string | null>(null);
  const [mapView, setMapView] = useState<MapView>('2d');
  const [mapNotice, setMapNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  function selectAgency(agency: AgencyFilter) {
    setAgencyFilter(agency);
    setModeFilter('all');
    setFocusedRouteId(null);
    setSelectedVehicleId(null);
    setActivePanel('network');
  }

  const visibleRoutes = useMemo(
    () => networkRoutes.filter((route) =>
      (modeFilter === 'all' || route.mode === modeFilter) &&
      (agencyFilter === 'all' || (route.agency ?? 'ttc') === agencyFilter)
    ),
    [agencyFilter, modeFilter, networkRoutes]
  );
  const focusedRoute = visibleRoutes.find((route) => route.id === focusedRouteId) ?? null;
  const visibleStops = useMemo(() => {
    const routeIds = new Set(visibleRoutes.map((route) => route.id));
    return (staticNetwork?.stops ?? []).filter((stop) =>
      stop.routeIds?.some((routeId) => routeIds.has(routeId))
    );
  }, [staticNetwork, visibleRoutes]);
  const mapStops = focusedRoute
    ? visibleStops.filter((stop) => stop.routeIds?.includes(focusedRoute.id))
    : visibleStops;
  const visibleVehicles = useMemo(
    () => snapshot.vehicles.filter((vehicle) =>
      (modeFilter === 'all' || vehicle.mode === modeFilter) &&
      (agencyFilter === 'all' || (vehicle.agency ?? 'ttc') === agencyFilter) &&
      (search.trim() === '' ||
        vehicle.label.toLowerCase().includes(search.toLowerCase()) ||
        vehicle.id.toLowerCase().includes(search.toLowerCase()))
    ),
    [agencyFilter, modeFilter, search, snapshot.vehicles]
  );
  const selectedVehicle =
    visibleVehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null;
  const selectedLineSummary = selectedVehicle
    ? summarizeLineOperations(
        snapshot.vehicles,
        selectedVehicle.routeId,
        selectedVehicle.mode
      )
    : null;
  const selectedLineVehicles = selectedVehicle
    ? snapshot.vehicles.filter(
        (vehicle) =>
          vehicle.routeId === selectedVehicle.routeId &&
          vehicle.mode === selectedVehicle.mode
      )
    : [];
  const selectedRoute = selectedVehicle
    ? networkRoutes.find(
        (route) =>
          route.id === selectedVehicle.routeId &&
          route.mode === selectedVehicle.mode
      ) ?? TTC_ROUTES.find((route) => route.id === selectedVehicle.routeId)
    : null;
  const vehiclesWithSchedule = snapshot.vehicles.filter(
    (vehicle): vehicle is VehicleTelemetry & { scheduleDeviationSeconds: number } =>
      vehicle.scheduleDeviationSeconds != null && Number.isFinite(vehicle.scheduleDeviationSeconds)
  );
  const metrics = useMemo(() => summarizeNetworkOperations(snapshot.vehicles), [snapshot.vehicles]);
  const unavailableValue = connectionState === 'connecting' ? '...' : 'N/A';
  const unavailableDetail = connectionState === 'connecting' ? 'Awaiting telemetry' : 'Feed unavailable';
  const lastKnown = hasSnapshot && (paused || isStale || Boolean(error));
  const sourceLabel = paused
    ? 'Updates paused'
    : connectionState === 'connecting'
      ? 'Connecting to live feed'
      : connectionState === 'connected'
        ? 'TTC GTFS-RT live'
        : connectionState === 'stale'
          ? 'Live data stale'
          : connectionState === 'degraded'
            ? hasSnapshot ? 'Live feed degraded' : 'Live feed unavailable'
            : 'Simulation mode';
  const observationAge = observationAgeSeconds == null
    ? ''
    : observationAgeSeconds < 60
      ? `${observationAgeSeconds}s ago`
      : observationAgeSeconds < 3600
        ? `${Math.floor(observationAgeSeconds / 60)}m ago`
        : `${Math.floor(observationAgeSeconds / 3600)}h ago`;
  const sourceDetail = !liveConfigured
    ? 'Simulated data, not live'
    : !hasSnapshot
      ? 'No live observations received'
      : `${lastKnown ? 'Last known' : 'Observed'} ${observationAge} | TTC GTFS-RT`;
  return (
    <main className="operations-shell">
      <aside className="tool-rail" aria-label="Workspace tools">
        <div className="ttc-mark" aria-label="GTA Transit Digital Twin"><span>GTA</span></div>
        <nav>
          <button className={activePanel === 'fleet' ? 'active' : ''} onClick={() => setActivePanel('fleet')} title="Fleet map"><Map size={20} /></button>
          <button className={activePanel === 'network' ? 'active' : ''} onClick={() => setActivePanel('network')} title="Network routes"><RouteIcon size={20} /></button>
          <button className={activePanel === 'alerts' ? 'active' : ''} onClick={() => setActivePanel('alerts')} title="Service alerts">
            <BellRing size={20} />
            {snapshot.alerts.length > 0 && <span className="rail-count">{snapshot.alerts.length}</span>}
          </button>
          <button className={activePanel === 'notes' ? 'active' : ''} onClick={() => setActivePanel('notes')} title="Operator log"><NotebookPen size={20} /></button>
        </nav>
        <div className="rail-bottom">
          <button onClick={() => void signOut()} title="Sign out"><LogOut size={19} /></button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="product-title">
            <span className="eyebrow">Operations control</span>
            <h1>GTA transit digital twin</h1>
          </div>
          <div className="source-status" id="network-data-status" role="status">
            <span className={`status-dot ${paused ? 'paused' : connectionState}`} aria-hidden="true" />
            <div>
              <strong>{sourceLabel}</strong>
              <small>{sourceDetail}</small>
            </div>
          </div>
          <div className="observation-time">
            <Clock3 size={15} aria-hidden="true" />
            {hasSnapshot ? (
              <time dateTime={snapshot.observedAt} title={new Date(snapshot.observedAt).toLocaleString()}>
                {new Date(snapshot.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </time>
            ) : <span>No observation</span>}
          </div>
          <div className="operator-identity">
            <span>{user?.name ?? 'Operator'}</span>
            <div>{(user?.name ?? 'OP').slice(0, 2).toUpperCase()}</div>
          </div>
        </header>

        <section
          className="metric-strip"
          aria-label="Network summary"
          aria-describedby="network-data-status"
          aria-busy={connectionState === 'connecting'}
          data-state={paused ? 'paused' : connectionState}
        >
          <div className="network-metric" role="group" aria-label="Tracked vehicles">
            <span>Tracked vehicles</span>
            <strong>{hasSnapshot ? metrics.trackedVehicles.toLocaleString() : unavailableValue}</strong>
            <Radio size={15} aria-hidden="true" />
            <small>{!hasSnapshot ? unavailableDetail : !liveConfigured ? 'Simulated fleet' : lastKnown ? 'Last known fleet' : 'TTC live fleet'}</small>
          </div>
          <div className="network-metric" role="group" aria-label="On schedule" title="Between 2 minutes early and 3 minutes late, among vehicles with a schedule estimate.">
            <span>On schedule</span>
            <strong>{!hasSnapshot ? unavailableValue : metrics.onTimePercent == null ? 'N/A' : `${metrics.onTimePercent}%`}</strong>
            <Clock3 size={15} aria-hidden="true" />
            <small>{!hasSnapshot ? unavailableDetail : metrics.onTimePercent == null ? 'Estimate unavailable' : `${metrics.onTimeVehicles.toLocaleString()} of ${metrics.scheduledVehicles.toLocaleString()} estimated`}</small>
          </div>
          <div className={`network-metric ${hasSnapshot && metrics.delayedVehicles > 0 ? 'attention' : ''}`} role="group" aria-label="Delayed" title="More than 3 minutes late. Coverage is the share of tracked vehicles with a schedule estimate.">
            <span>Delayed</span>
            <strong>{!hasSnapshot ? unavailableValue : metrics.onTimePercent == null ? 'N/A' : metrics.delayedVehicles.toLocaleString()}</strong>
            <TriangleAlert size={15} aria-hidden="true" />
            <small>{!hasSnapshot ? unavailableDetail : metrics.onTimePercent == null ? 'Estimate unavailable' : `> 3 min · ${metrics.scheduleCoveragePercent}% coverage`}</small>
          </div>
          <div className="network-metric" role="group" aria-label="Active alerts">
            <span>Active alerts</span>
            <strong>{hasSnapshot ? snapshot.alerts.length.toLocaleString() : unavailableValue}</strong>
            <BellRing size={15} aria-hidden="true" />
            <small>{!hasSnapshot ? unavailableDetail : !liveConfigured ? 'Simulated notices' : lastKnown ? 'Last known notices' : 'Reported by TTC'}</small>
          </div>
          <div className="scope-note"><Boxes size={16} aria-hidden="true" /><p><strong>Live coverage: TTC</strong><span>{staticNetwork ? `${staticNetwork.statistics.routes.toLocaleString()} GTA routes · ${staticNetwork.statistics.stops.toLocaleString()} stops` : 'TTC / GO Transit / UP Express'}</span></p></div>
        </section>

        <div className="work-area">
          <section className={`map-stage ${selectedVehicle ? 'has-selection' : ''} ${focusedRoute ? 'has-route-selection' : ''}`}>
            {mapView === '2d' ? (
              <TransitMap
                vehicles={visibleVehicles}
                visibleRoutes={visibleRoutes}
                stops={mapStops}
                selectedVehicleId={selectedVehicleId}
                focusedRouteId={focusedRoute?.id ?? null}
                onVehicleSelect={setSelectedVehicleId}
              />
            ) : (
              <Suspense
                fallback={(
                  <div className="transit-map-shell">
                    <div className="map-loading">Loading 3D scene...</div>
                  </div>
                )}
              >
                <MapLibreTransitMap
                  vehicles={visibleVehicles}
                  visibleRoutes={visibleRoutes}
                  stops={mapStops}
                  selectedVehicleId={selectedVehicleId}
                  focusedRouteId={focusedRoute?.id ?? null}
                  onVehicleSelect={setSelectedVehicleId}
                  onUnavailable={(message) => {
                    setMapNotice(message);
                    setMapView('2d');
                  }}
                />
              </Suspense>
            )}

            <div className="map-filter-bar">
              <select
                className="agency-select"
                aria-label="Transit agency"
                value={agencyFilter}
                onChange={(event) => selectAgency(event.target.value as AgencyFilter)}
              >
                <option value="all">All agencies</option>
                {(['ttc', 'go', 'up'] as const).map((agency) => <option key={agency} value={agency}>{agencyNames[agency]}</option>)}
              </select>
              <div className="segmented-control" aria-label="Transport mode">
                {(['all', 'subway', 'streetcar', 'bus', 'rail'] as ModeFilter[]).map((mode) => (
                  <button key={mode} className={modeFilter === mode ? 'active' : ''} onClick={() => { setModeFilter(mode); setFocusedRouteId(null); setSelectedVehicleId(null); }}>
                    {mode === 'all' ? 'All modes' : mode}
                  </button>
                ))}
              </div>
              <button type="button" className={`icon-control ${paused ? 'paused' : ''}`} aria-pressed={paused} onClick={() => setPaused(!paused)} title={paused ? 'Resume playback' : 'Pause playback'}>
                {paused ? <Play size={17} /> : <Pause size={17} />}
              </button>
              <button type="button" className="icon-control" disabled={refreshing} aria-busy={refreshing} onClick={() => void refresh()} title="Refresh feed"><RefreshCw size={17} /></button>
              <div className="segmented-control map-view-control" aria-label="Map view">
                {(['2d', '3d'] as MapView[]).map((view) => (
                  <button
                    key={view}
                    className={mapView === view ? 'active' : ''}
                    onClick={() => {
                      setMapNotice(null);
                      setMapView(view);
                    }}
                  >
                    {view.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>

            <aside className="map-legend" aria-label="Map legend">
              <strong className="legend-title">Legend</strong>
              <div className="legend-section">
                <span className="legend-section-label">Mode</span>
                <div className="legend-items">
                  <span className="legend-item"><span className="legend-mode bus"><BusFront size={12} aria-hidden="true" /></span>Bus</span>
                  <span className="legend-item"><span className="legend-mode streetcar"><TramFront size={12} aria-hidden="true" /></span>Streetcar</span>
                  <span className="legend-item"><span className="legend-mode subway"><TrainFront size={12} aria-hidden="true" /></span>Subway</span>
                  <span className="legend-item"><span className="legend-mode rail"><TrainFront size={12} aria-hidden="true" /></span>Rail</span>
                </div>
              </div>
              <div className="legend-section">
                <span className="legend-section-label">Map</span>
                <div className="legend-items">
                  <span className="legend-item"><span className="legend-dot on-time" aria-hidden="true" />On time</span>
                  <span className="legend-item"><span className="legend-dot delayed" aria-hidden="true" />Delayed</span>
                  <span className="legend-item"><span className="legend-dot early" aria-hidden="true" />Early</span>
                  <span className="legend-item"><span className="legend-dot unknown" aria-hidden="true" />Not reported</span>
                  <span className="legend-item"><span className="legend-dot stop" aria-hidden="true" />Stop</span>
                  <span className="legend-item"><span className="legend-line" aria-hidden="true" />Route</span>
                </div>
              </div>
            </aside>

            {selectedVehicle && selectedLineSummary && (
              <LineStory
                summary={selectedLineSummary}
                vehicles={selectedLineVehicles}
                selectedVehicle={selectedVehicle}
                routeName={selectedRoute?.longName ?? selectedVehicle.label}
                routeColor={selectedRoute?.color ?? '#d71920'}
                onAddNote={() => setActivePanel('notes')}
              />
            )}

            {focusedRoute && !selectedVehicle && (
              <aside className="route-focus" aria-label="Selected scheduled route">
                <strong>{agencyNames[focusedRoute.agency ?? 'ttc']} {focusedRoute.shortName}</strong>
                <span>{focusedRoute.longName}</span>
                <small>Scheduled route / {visibleStops.filter((stop) => stop.routeIds?.includes(focusedRoute.id)).length} stops</small>
              </aside>
            )}

            {mapNotice && <div className="map-mode-notice">{mapNotice}</div>}
            {(error || networkError) && (
              <div className="feed-error" role="alert">
                {error && <>{error} {hasSnapshot ? 'Showing the last successful snapshot.' : 'Live metrics are unavailable.'} </>}
                {networkError}
              </div>
            )}

            <div className="timeline-band">
              <div className="timeline-label"><Clock3 size={14} /><span>Schedule deviation</span></div>
              <div className="deviation-bars">
                {vehiclesWithSchedule.length > 0
                  ? vehiclesWithSchedule.slice(0, 34).map((vehicle) => (
                      <span
                        key={vehicle.id}
                        className={vehicle.state}
                        style={{ height: `${Math.max(4, Math.min(30, Math.abs(vehicle.scheduleDeviationSeconds) / 10))}px` }}
                        title={`${vehicle.label}: ${formatDeviation(vehicle.scheduleDeviationSeconds)}`}
                      />
                    ))
                  : <div className="deviation-unavailable">TTC delay data not reported</div>}
              </div>
              <div className="timeline-scale"><span>-5m</span><span>now</span><span>+5m</span></div>
            </div>
          </section>

          <aside className="context-panel">
            <header className="panel-header">
              <div>
                <span>{activePanel === 'fleet' ? 'TTC live fleet' : activePanel === 'network' ? 'Scheduled network' : activePanel === 'alerts' ? 'TTC service notices' : 'Operator log'}</span>
                <strong>{activePanel === 'fleet' ? `${visibleVehicles.length} in view` : activePanel === 'network' ? `${visibleRoutes.length} routes` : activePanel === 'alerts' ? `${snapshot.alerts.length} active` : 'Shift context'}</strong>
              </div>
              {activePanel === 'fleet' && <RouteIcon size={19} />}
              {activePanel === 'alerts' && <TriangleAlert size={19} />}
              {activePanel === 'notes' && <NotebookPen size={19} />}
            </header>

            {activePanel === 'fleet' && (
              <div className="fleet-panel-body">
                <DelayComparisonChart vehicles={snapshot.vehicles} />
                <label className="fleet-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search route or vehicle" /></label>
                <div className="fleet-list">
                  {visibleVehicles.map((vehicle) => (
                    <FleetRow key={vehicle.id} vehicle={vehicle} selected={selectedVehicleId === vehicle.id} onSelect={() => setSelectedVehicleId(vehicle.id)} />
                  ))}
                  {visibleVehicles.length === 0 && <p className="empty-panel">No live vehicles in this view. Live coverage: TTC buses and streetcars.</p>}
                </div>
              </div>
            )}

            {activePanel === 'network' && (
              <NetworkRoutes
                routes={visibleRoutes}
                stops={visibleStops}
                feeds={staticNetwork?.feeds ?? []}
                selectedAgency={agencyFilter}
                onSelectAgency={selectAgency}
                selectedRouteId={focusedRoute?.id ?? null}
                onSelectRoute={(routeId) => { setFocusedRouteId(routeId); setSelectedVehicleId(null); }}
                onClearRoute={() => setFocusedRouteId(null)}
              />
            )}

            {activePanel === 'alerts' && (
              <div className="alert-list">
                {snapshot.alerts.map((alert) => (
                  <article className="alert-row" key={alert.id}>
                    <div className={`alert-severity ${alert.severity}`}><TriangleAlert size={15} /></div>
                    <div>
                      <span>{alert.routeIds.map((route) => `Route ${route}`).join(' · ')}</span>
                      <h2>{alert.title}</h2>
                      <p>{alert.description}</p>
                      <time>Updated {new Date(alert.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    </div>
                  </article>
                ))}
              </div>
            )}

            {activePanel === 'notes' && user && <OperatorLog userId={user.id} selectedVehicle={selectedVehicle} />}
          </aside>
        </div>
      </section>
    </main>
  );
}
