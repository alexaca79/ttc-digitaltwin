import type { ServiceAlert, TransitMode, TransitSnapshot, VehicleState } from '../src/types/transit.js';

export interface VehiclePositionEvent {
  eventType: 'VehiclePosition';
  eventId: string;
  observedAt: string;
  vehicleId: string;
  vehicleLabel: string;
  tripId: string;
  routeId: string;
  mode: TransitMode;
  latitude: number;
  longitude: number;
  bearing: number;
  speedKph: number;
  scheduleDeviationSeconds: number | null;
  occupancy: 'low' | 'medium' | 'high' | 'unknown';
  state: VehicleState;
  stopId: string;
  currentStatus: string;
  source: 'ttc-gtfs-rt';
}

export interface TripUpdateEvent {
  eventType: 'TripUpdate';
  eventId: string;
  observedAt: string;
  tripId: string;
  routeId: string;
  vehicleId: string;
  stopId: string;
  stopSequence: number;
  arrivalEpochSeconds: number;
  departureEpochSeconds: number;
  delaySeconds: number | null;
  source: 'ttc-gtfs-rt';
}

export interface ServiceAlertEvent {
  eventType: 'ServiceAlert';
  eventId: string;
  observedAt: string;
  alertId: string;
  severity: ServiceAlert['severity'];
  title: string;
  description: string;
  routeIds: string[];
  cause: string;
  effect: string;
  activeStartEpochSeconds: number;
  activeEndEpochSeconds: number;
  source: 'ttc-gtfs-rt';
}

export type RawFeedName = 'vehicles' | 'trips' | 'alerts';

/**
 * A whole GTFS-realtime protobuf feed forwarded without decoding. The Fabric
 * Spark notebook destination decodes it and derives the typed events below.
 */
export interface RawFeedEvent {
  eventType: 'RawFeed';
  eventId: string;
  observedAt: string;
  feed: RawFeedName;
  encoding: 'gzip+base64';
  rawBytes: number;
  payload: string;
  source: 'ttc-gtfs-rt';
}

export type NormalizedTransitEvent =
  | VehiclePositionEvent
  | TripUpdateEvent
  | ServiceAlertEvent
  | RawFeedEvent;

export interface PollResult {
  snapshot: TransitSnapshot;
  events: NormalizedTransitEvent[];
}