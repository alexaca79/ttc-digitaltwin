export type TransitMode = 'bus' | 'streetcar' | 'subway' | 'rail';
export type TransitAgency = 'ttc' | 'go' | 'up';
export type FeedSource = 'simulated' | 'ttc-gtfs-rt';
export type VehicleState = 'on-time' | 'delayed' | 'early' | 'unknown';

export type Coordinate = [longitude: number, latitude: number];

export interface TransitRoute {
  id: string;
  agency?: TransitAgency;
  gtfsRouteId?: string;
  scheduledTrips?: number;
  shortName: string;
  longName: string;
  mode: TransitMode;
  color: string;
  path: Coordinate[];
  paths?: Coordinate[][];
}

export interface VehicleTelemetry {
  id: string;
  agency?: TransitAgency;
  routeId: string;
  tripId: string;
  label: string;
  mode: TransitMode;
  latitude: number;
  longitude: number;
  bearing: number;
  speedKph: number;
  scheduleDeviationSeconds: number | null;
  occupancy: 'low' | 'medium' | 'high' | 'unknown';
  state: VehicleState;
  observedAt: string;
}

export interface ServiceAlert {
  id: string;
  agency?: TransitAgency;
  severity: 'info' | 'warning' | 'critical';
  title: string;
  description: string;
  routeIds: string[];
  updatedAt: string;
}

export interface TransitSnapshot {
  source: FeedSource;
  observedAt: string;
  vehicles: VehicleTelemetry[];
  alerts: ServiceAlert[];
}

export interface TransitStop {
  id: string;
  agency?: TransitAgency;
  gtfsStopId?: string;
  name: string;
  latitude: number;
  longitude: number;
  parentStation?: string;
  wheelchairBoarding?: string;
  routeIds?: string[];
}

export interface TransitFeedMetadata {
  agency: TransitAgency;
  name: string;
  sourceUrl: string;
  licenseUrl: string;
  generatedAt: string;
  validFrom?: string;
  validThrough?: string;
  version?: string;
  files: string[];
  routes: number;
  stops: number;
  trips: number;
  services: number;
  shapes: number;
}

export interface StaticNetworkAsset {
  generatedAt: string;
  sourceUrl: string;
  licenseUrl: string;
  feeds?: TransitFeedMetadata[];
  routes: TransitRoute[];
  stops: TransitStop[];
  statistics: {
    routes: number;
    stops: number;
    trips: number;
    services: number;
  };
}