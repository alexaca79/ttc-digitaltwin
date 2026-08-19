import type {
  Coordinate,
  ServiceAlert,
  TransitRoute,
  VehicleTelemetry,
} from '@/types/transit';

export const TTC_ROUTES: TransitRoute[] = [
  {
    id: '1',
    shortName: '1',
    longName: 'Yonge-University',
    mode: 'subway',
    color: '#f2c94c',
    path: [
      [-79.4154, 43.7808], [-79.4111, 43.7669], [-79.4071, 43.7546],
      [-79.4042, 43.7443], [-79.4015, 43.733], [-79.3993, 43.7218],
      [-79.3954, 43.7061], [-79.3932, 43.6879], [-79.3867, 43.6707],
      [-79.379, 43.6548], [-79.3803, 43.6457], [-79.3909, 43.645],
      [-79.402, 43.6509], [-79.4111, 43.6599], [-79.4151, 43.6663],
      [-79.4197, 43.6771], [-79.424, 43.6938], [-79.4438, 43.7247],
      [-79.4478, 43.7502],
    ],
  },
  {
    id: '2',
    shortName: '2',
    longName: 'Bloor-Danforth',
    mode: 'subway',
    color: '#3f9f58',
    path: [
      [-79.535, 43.637], [-79.5101, 43.6454], [-79.4932, 43.6495],
      [-79.4746, 43.6503], [-79.4521, 43.6536], [-79.4338, 43.6568],
      [-79.4124, 43.6601], [-79.3983, 43.6632], [-79.3828, 43.6701],
      [-79.3686, 43.6766], [-79.3467, 43.6802], [-79.3217, 43.6879],
      [-79.3, 43.7023], [-79.2804, 43.7322],
    ],
  },
  {
    id: '501',
    shortName: '501',
    longName: 'Queen',
    mode: 'streetcar',
    color: '#d71920',
    path: [
      [-79.5441, 43.5916], [-79.5062, 43.615], [-79.4752, 43.6306],
      [-79.447, 43.6386], [-79.4211, 43.6427], [-79.3986, 43.6486],
      [-79.382, 43.6522], [-79.3645, 43.6587], [-79.3382, 43.6667],
      [-79.3105, 43.6763], [-79.2803, 43.6804],
    ],
  },
  {
    id: '504',
    shortName: '504',
    longName: 'King',
    mode: 'streetcar',
    color: '#e53935',
    path: [
      [-79.4513, 43.6569], [-79.4331, 43.6508], [-79.4163, 43.6437],
      [-79.4026, 43.6422], [-79.3871, 43.6457], [-79.3753, 43.6491],
      [-79.3613, 43.6549], [-79.3501, 43.6634], [-79.3443, 43.6769],
    ],
  },
  {
    id: '29',
    shortName: '29',
    longName: 'Dufferin',
    mode: 'bus',
    color: '#1b74bb',
    path: [
      [-79.4263, 43.6293], [-79.4269, 43.6432], [-79.4292, 43.6569],
      [-79.4318, 43.6701], [-79.4355, 43.6871], [-79.4375, 43.7004],
      [-79.4397, 43.715], [-79.4407, 43.7314], [-79.445, 43.7495],
    ],
  },
];

const VEHICLES_PER_ROUTE: Record<string, number> = {
  '1': 14,
  '2': 12,
  '501': 10,
  '504': 9,
  '29': 8,
};

function distance([longitudeA, latitudeA]: Coordinate, [longitudeB, latitudeB]: Coordinate) {
  const longitudeScale = Math.cos(((latitudeA + latitudeB) / 2) * (Math.PI / 180));
  return Math.hypot((longitudeB - longitudeA) * longitudeScale, latitudeB - latitudeA);
}

function pointAlongPath(path: Coordinate[], progress: number) {
  const segmentLengths = path.slice(1).map((point, index) => distance(path[index], point));
  const totalLength = segmentLengths.reduce((total, length) => total + length, 0);
  let remaining = progress * totalLength;

  for (let index = 0; index < segmentLengths.length; index += 1) {
    if (remaining <= segmentLengths[index]) {
      const segmentProgress = segmentLengths[index] === 0 ? 0 : remaining / segmentLengths[index];
      const [startLongitude, startLatitude] = path[index];
      const [endLongitude, endLatitude] = path[index + 1];
      const longitude = startLongitude + (endLongitude - startLongitude) * segmentProgress;
      const latitude = startLatitude + (endLatitude - startLatitude) * segmentProgress;
      const bearing = (Math.atan2(endLongitude - startLongitude, endLatitude - startLatitude) * 180) / Math.PI;
      return { longitude, latitude, bearing: (bearing + 360) % 360 };
    }
    remaining -= segmentLengths[index];
  }

  const [longitude, latitude] = path.at(-1) ?? path[0];
  return { longitude, latitude, bearing: 0 };
}

export function createSimulatedVehicles(observedAt: Date): VehicleTelemetry[] {
  const elapsedSeconds = observedAt.getTime() / 1000;

  return TTC_ROUTES.flatMap((route, routeIndex) => {
    const vehicleCount = VEHICLES_PER_ROUTE[route.id];
    return Array.from({ length: vehicleCount }, (_, vehicleIndex) => {
      const cycle = (elapsedSeconds / (680 + routeIndex * 65) + vehicleIndex / vehicleCount) % 2;
      const progress = cycle <= 1 ? cycle : 2 - cycle;
      const position = pointAlongPath(route.path, progress);
      const scheduleDeviationSeconds = Math.round(
        Math.sin(elapsedSeconds / 93 + vehicleIndex * 1.61 + routeIndex) * 210 +
          (vehicleIndex % 8 === 0 ? 150 : 0)
      );
      const state = scheduleDeviationSeconds > 180
        ? 'delayed'
        : scheduleDeviationSeconds < -120
          ? 'early'
          : 'on-time';

      return {
        id: `${route.id}-${String(2100 + vehicleIndex).padStart(4, '0')}`,
        routeId: route.id,
        tripId: `SIM-${route.id}-${vehicleIndex + 1}`,
        label: `${route.shortName} · ${2100 + vehicleIndex}`,
        mode: route.mode,
        latitude: position.latitude,
        longitude: position.longitude,
        bearing: position.bearing,
        speedKph: Math.max(4, Math.round(22 + Math.sin(elapsedSeconds / 17 + vehicleIndex) * 11)),
        scheduleDeviationSeconds,
        occupancy: (['low', 'medium', 'high'] as const)[(vehicleIndex + routeIndex) % 3],
        state,
        observedAt: observedAt.toISOString(),
      };
    });
  });
}

export function createSimulatedAlerts(observedAt: Date): ServiceAlert[] {
  return [
    {
      id: 'sim-alert-1',
      severity: 'warning',
      title: 'Slower service through the King corridor',
      description: 'Synthetic demonstration alert caused by modeled downtown congestion.',
      routeIds: ['504'],
      updatedAt: observedAt.toISOString(),
    },
    {
      id: 'sim-alert-2',
      severity: 'info',
      title: 'Line 1 headways under observation',
      description: 'Synthetic demonstration alert for schedule-adherence monitoring.',
      routeIds: ['1'],
      updatedAt: observedAt.toISOString(),
    },
  ];
}