import { useState } from 'react';
import { BusFront, ChevronRight, Download, Search, TrainFront, TramFront, X } from 'lucide-react';

import type { TransitAgency, TransitFeedMetadata, TransitRoute, TransitStop } from '@/types/transit';

interface NetworkRoutesProps {
  routes: TransitRoute[];
  stops: TransitStop[];
  feeds: TransitFeedMetadata[];
  selectedAgency: 'all' | TransitAgency;
  onSelectAgency: (agency: 'all' | TransitAgency) => void;
  selectedRouteId: string | null;
  onSelectRoute: (routeId: string) => void;
  onClearRoute: () => void;
}

const modeIcons = { bus: BusFront, streetcar: TramFront, subway: TrainFront, rail: TrainFront };

export function NetworkRoutes({ routes, stops, feeds, selectedAgency, onSelectAgency, selectedRouteId, onSelectRoute, onClearRoute }: NetworkRoutesProps) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const matchingStopRoutes = new Set(stops
    .filter((stop) => stop.name.toLowerCase().includes(query))
    .flatMap((stop) => stop.routeIds ?? []));
  const matchingRoutes = routes.filter((route) =>
    `${route.shortName} ${route.longName}`.toLowerCase().includes(query) || matchingStopRoutes.has(route.id)
  );
  const agencyName = (route: TransitRoute) => feeds.find((feed) => feed.agency === (route.agency ?? 'ttc'))?.name
    ?? (route.agency ?? 'ttc').toUpperCase();
  const selectedFeeds = feeds.filter((feed) => selectedAgency === 'all' || feed.agency === selectedAgency);
  const selectedRoute = routes.find((route) => route.id === selectedRouteId);
  const selectedStops = stops.filter((stop) => stop.routeIds?.includes(selectedRouteId ?? ''))
    .sort((left, right) => left.name.localeCompare(right.name));
  const agencyOptions = [
    { id: 'all' as const, name: 'All', routes: feeds.reduce((count, feed) => count + feed.routes, 0) },
    ...(['ttc', 'go', 'up'] as const).map((agency) => ({
      id: agency,
      name: { ttc: 'TTC', go: 'GO Transit', up: 'UP Express' }[agency],
      routes: feeds.find((feed) => feed.agency === agency)?.routes ?? 0,
    })),
  ];

  return (
    <div className="network-panel-body">
      <div className="route-agencies" role="radiogroup" aria-label="Route agencies">
        {agencyOptions.map((agency) => (
          <label className="route-agency-option" key={agency.id}>
            <input type="radio" name="route-agency" value={agency.id} aria-label={agency.name} checked={selectedAgency === agency.id} onChange={() => onSelectAgency(agency.id)} />
            <span>{agency.name}</span>
            <strong>{agency.routes.toLocaleString()}</strong>
          </label>
        ))}
      </div>
      <details className="network-feed-details">
        <summary>GTFS feeds <strong>{selectedFeeds.length}</strong></summary>
        <div className="network-feed-list">
          {selectedFeeds.map((feed) => (
            <section className="network-feed" key={feed.agency} aria-label={`${feed.name} GTFS coverage`}>
              <header>
                <strong>{feed.name}</strong>
                <a href={feed.sourceUrl} target="_blank" rel="noreferrer" title={`Download ${feed.name} GTFS`} aria-label={`Download ${feed.name} GTFS`}><Download size={14} /></a>
              </header>
              <span>{feed.routes} routes / {feed.stops.toLocaleString()} stops / {feed.trips.toLocaleString()} trips</span>
              <span>{feed.services} service calendars / {feed.shapes} shapes</span>
              <span>Service dates: {feed.validFrom ?? 'Not supplied'} to {feed.validThrough ?? 'Not supplied'}</span>
              <span>Imported <time dateTime={feed.generatedAt}>{feed.generatedAt.slice(0, 10)}</time></span>
              <small>{feed.files.join(', ')}</small>
              <a href={feed.licenseUrl} target="_blank" rel="noreferrer">Source licence</a>
            </section>
          ))}
        </div>
      </details>
      <label className="fleet-search">
        <Search size={15} aria-hidden="true" />
        <input aria-label="Search network routes or stations" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Route or station" />
      </label>
      <div className="network-route-list">
        {selectedRoute && (
          <section className="selected-route-details" aria-label="Route details">
            <header>
              <strong>{agencyName(selectedRoute)} {selectedRoute.shortName}</strong>
              <button type="button" onClick={onClearRoute} title="Clear route selection" aria-label="Clear route selection"><X size={14} /></button>
            </header>
            <span>{selectedRoute.longName}</span>
            <small>{selectedRoute.paths?.length ?? 1} shapes / {(selectedRoute.scheduledTrips ?? 0).toLocaleString()} scheduled trips in feed</small>
            <details open>
              <summary>Stops and stations <strong>{selectedStops.length}</strong></summary>
              <ul>{selectedStops.map((stop) => <li key={stop.id}>{stop.name}</li>)}</ul>
            </details>
          </section>
        )}
        {matchingRoutes.map((route) => {
          const ModeIcon = modeIcons[route.mode];
          return (
            <button
              type="button"
              key={route.id}
              className={`network-route-row ${selectedRouteId === route.id ? 'selected' : ''}`}
              style={{ borderLeftColor: route.color }}
              aria-pressed={selectedRouteId === route.id}
              aria-label={`Focus ${agencyName(route)} route ${route.shortName}: ${route.longName}`}
              onClick={() => onSelectRoute(route.id)}
            >
              <ModeIcon size={17} aria-hidden="true" />
              <span>
                <strong>{route.shortName} <span>{route.longName}</span></strong>
                <small>{agencyName(route)} / {route.mode} / {(route.scheduledTrips ?? 0).toLocaleString()} trips in feed</small>
              </span>
              <ChevronRight size={15} aria-hidden="true" />
            </button>
          );
        })}
        {matchingRoutes.length === 0 && <p className="empty-panel">No matching scheduled routes.</p>}
      </div>
    </div>
  );
}
