export type TransitMode = 'bus' | 'streetcar' | 'subway';
export type FeedSource = 'simulated' | 'ttc-gtfs-rt';
export type VehicleState = 'on-time' | 'delayed' | 'early' | 'unknown';

export type Coordinate = [longitude: number, latitude: number];

export interface TransitRoute {
  id: string;
  shortName: string;
  longName: string;
  mode: TransitMode;
  color: string;
  path: Coordinate[];
}

export interface VehicleTelemetry {
  id: string;
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
  name: string;
  latitude: number;
  longitude: number;
  parentStation?: string;
  wheelchairBoarding?: string;
}

export interface StaticNetworkAsset {
  generatedAt: string;
  sourceUrl: string;
  licenseUrl: string;
  routes: TransitRoute[];
  stops: TransitStop[];
  statistics: {
    routes: number;
    stops: number;
    trips: number;
    services: number;
  };
}