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
import { TransitMap } from '@/components/LeafletTransitMap';
import {
  summarizeLineOperations,
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
  TransitMode,
  VehicleState,
  VehicleTelemetry,
} from '@/types/transit';

import './HomePage.css';

type Panel = 'fleet' | 'alerts' | 'notes';
type ModeFilter = 'all' | TransitMode;
type MapView = '2d' | '3d';

const MapLibreTransitMap = lazy(() =>
  import('@/components/MapLibreTransitMap').then((module) => ({
    default: module.MapLibreTransitMap,
  }))
);

const modeIcons = {
  bus: BusFront,
  streetcar: TramFront,
  subway: TrainFront,
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
    paused,
    error,
    liveConfigured,
    setPaused,
    refresh,
  } = useTransitFeed();
  const { routes: networkRoutes, asset: staticNetwork } = useStaticNetwork();
  const [activePanel, setActivePanel] = useState<Panel>('fleet');
  const [modeFilter, setModeFilter] = useState<ModeFilter>('all');
  const [mapView, setMapView] = useState<MapView>('2d');
  const [mapNotice, setMapNotice] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);

  const visibleRoutes = useMemo(
    () => networkRoutes.filter((route) =>
      (modeFilter === 'all' || route.mode === modeFilter)
    ),
    [modeFilter, networkRoutes]
  );
  const visibleVehicles = useMemo(
    () => snapshot.vehicles.filter((vehicle) =>
      (modeFilter === 'all' || vehicle.mode === modeFilter) &&
      (search.trim() === '' ||
        vehicle.label.toLowerCase().includes(search.toLowerCase()) ||
        vehicle.id.toLowerCase().includes(search.toLowerCase()))
    ),
    [modeFilter, search, snapshot.vehicles]
  );
  const selectedVehicle =
    snapshot.vehicles.find((vehicle) => vehicle.id === selectedVehicleId) ?? null;
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
      vehicle.scheduleDeviationSeconds != null
  );
  const onTimeVehicles = vehiclesWithSchedule.filter(
    (vehicle) => vehicle.state === 'on-time'
  ).length;
  const delayedVehicles = vehiclesWithSchedule.filter(
    (vehicle) => vehicle.state === 'delayed'
  ).length;
  const onTimePercent = vehiclesWithSchedule.length
    ? Math.round((onTimeVehicles / vehiclesWithSchedule.length) * 100)
    : null;
  const scheduleCoveragePercent = snapshot.vehicles.length
    ? Math.round((vehiclesWithSchedule.length / snapshot.vehicles.length) * 100)
    : 0;
  return (
    <main className="operations-shell">
      <aside className="tool-rail" aria-label="Workspace tools">
        <div className="ttc-mark" aria-label="TTC Digital Twin"><span>TTC</span></div>
        <nav>
          <button className={activePanel === 'fleet' ? 'active' : ''} onClick={() => setActivePanel('fleet')} title="Fleet map"><Map size={20} /></button>
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
            <h1>Toronto transit digital twin</h1>
          </div>
          <div className="source-status">
            <span className={`status-dot ${connectionState}`} />
            <div>
              <strong>{connectionState === 'connected' ? 'GTFS-RT live' : connectionState === 'degraded' ? 'Live feed degraded' : 'Simulation mode'}</strong>
              <small>{liveConfigured ? 'TTC BusTime + static GTFS' : 'Deterministic open-data model'}</small>
            </div>
          </div>
          <div className="observation-time">
            <Clock3 size={15} />
            <time>{new Date(snapshot.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
          </div>
          <div className="operator-identity">
            <span>{user?.name ?? 'Operator'}</span>
            <div>{(user?.name ?? 'OP').slice(0, 2).toUpperCase()}</div>
          </div>
        </header>

        <div className="metric-strip" aria-label="Network summary">
          <div><span>Tracked vehicles</span><strong>{snapshot.vehicles.length}</strong><Radio size={15} /></div>
          <div><span>On schedule</span><strong>{onTimePercent == null ? 'N/A' : `${onTimePercent}%`}</strong><small>{onTimePercent == null ? 'Estimate unavailable' : `${onTimeVehicles} of ${vehiclesWithSchedule.length} estimated`}</small></div>
          <div className={delayedVehicles > 0 ? 'attention' : ''}><span>Delayed</span><strong>{onTimePercent == null ? 'N/A' : delayedVehicles}</strong><small>{onTimePercent == null ? 'Estimate unavailable' : `> 3 min · ${scheduleCoveragePercent}% coverage`}</small></div>
          <div><span>Active alerts</span><strong>{snapshot.alerts.length}</strong><TriangleAlert size={15} /></div>
          <div className="scope-note"><Boxes size={16} /><p><strong>Macro operations twin</strong><span>{staticNetwork ? `${staticNetwork.statistics.routes} GTFS routes · ${staticNetwork.statistics.stops} stops` : 'No asset-health or tunnel claims'}</span></p></div>
        </div>

        <div className="work-area">
          <section className={`map-stage ${selectedVehicle ? 'has-selection' : ''}`}>
            {mapView === '2d' ? (
              <TransitMap
                vehicles={visibleVehicles}
                visibleRoutes={visibleRoutes}
                stops={staticNetwork?.stops ?? []}
                selectedVehicleId={selectedVehicleId}
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
                  stops={staticNetwork?.stops ?? []}
                  selectedVehicleId={selectedVehicleId}
                  onVehicleSelect={setSelectedVehicleId}
                  onUnavailable={(message) => {
                    setMapNotice(message);
                    setMapView('2d');
                  }}
                />
              </Suspense>
            )}

            <div className="map-filter-bar">
              <div className="segmented-control" aria-label="Transport mode">
                {(['all', 'subway', 'streetcar', 'bus'] as ModeFilter[]).map((mode) => (
                  <button key={mode} className={modeFilter === mode ? 'active' : ''} onClick={() => setModeFilter(mode)}>
                    {mode === 'all' ? 'All modes' : mode}
                  </button>
                ))}
              </div>
              <button className={`icon-control ${paused ? 'paused' : ''}`} onClick={() => setPaused(!paused)} title={paused ? 'Resume playback' : 'Pause playback'}>
                {paused ? <Play size={17} /> : <Pause size={17} />}
              </button>
              <button className="icon-control" onClick={() => void refresh()} title="Refresh feed"><RefreshCw size={17} /></button>
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

            {mapNotice && <div className="map-mode-notice">{mapNotice}</div>}
            {error && <div className="feed-error">{error} Showing labeled simulation data.</div>}

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
                <span>{activePanel === 'fleet' ? 'Fleet monitor' : activePanel === 'alerts' ? 'Service notices' : 'Operator log'}</span>
                <strong>{activePanel === 'fleet' ? `${visibleVehicles.length} in view` : activePanel === 'alerts' ? `${snapshot.alerts.length} active` : 'Shift context'}</strong>
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
                </div>
              </div>
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
