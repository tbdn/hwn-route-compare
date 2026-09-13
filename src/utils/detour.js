// Detour Analysis
// Finds the closest point on a route to each stamp and calculates detour distance

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(degrees) {
    return degrees * Math.PI / 180;
}

// Haversine distance in meters
function distanceMeters(lat1, lon1, lat2, lon2) {
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
              Math.sin(dLon / 2) ** 2;
    return EARTH_RADIUS_METERS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Convert lat/lon to local Cartesian coordinates (meters) for geometric calculations
// Uses a simple equirectangular projection centered on the route
function toLocalMeters(lat, lon, centerLat) {
    const latScale = EARTH_RADIUS_METERS * Math.PI / 180;
    const lonScale = latScale * Math.cos(toRadians(centerLat));
    return {
        x: lon * lonScale,
        y: lat * latScale
    };
}

// Convert local Cartesian back to lat/lon
function fromLocalMeters(x, y, centerLat) {
    const latScale = EARTH_RADIUS_METERS * Math.PI / 180;
    const lonScale = latScale * Math.cos(toRadians(centerLat));
    return {
        lat: y / latScale,
        lon: x / lonScale
    };
}

// Find closest point on line segment AB to point P
// Returns { point: {lat, lon}, distance: meters, t: position along segment [0-1] }
function closestPointOnSegment(p, a, b, centerLat) {
    const pLocal = toLocalMeters(p.lat, p.lon, centerLat);
    const aLocal = toLocalMeters(a.lat, a.lon, centerLat);
    const bLocal = toLocalMeters(b.lat, b.lon, centerLat);

    const abX = bLocal.x - aLocal.x;
    const abY = bLocal.y - aLocal.y;
    const apX = pLocal.x - aLocal.x;
    const apY = pLocal.y - aLocal.y;

    const abLenSq = abX * abX + abY * abY;

    // Handle degenerate segment (A == B)
    if (abLenSq < 0.0001) {
        return {
            point: { lat: a.lat, lon: a.lon },
            distance: distanceMeters(p.lat, p.lon, a.lat, a.lon),
            t: 0
        };
    }

    // Project P onto line AB, clamped to segment
    let t = (apX * abX + apY * abY) / abLenSq;
    t = Math.max(0, Math.min(1, t));

    // Calculate closest point
    const closestLocal = {
        x: aLocal.x + t * abX,
        y: aLocal.y + t * abY
    };
    const closest = fromLocalMeters(closestLocal.x, closestLocal.y, centerLat);

    return {
        point: closest,
        distance: distanceMeters(p.lat, p.lon, closest.lat, closest.lon),
        t: t
    };
}

/**
 * Find the exit point on a route for a given stamp
 * @param {Object} stamp - {lat, lon, ...}
 * @param {Array} routePoints - [{lat, lon}, ...]
 * @returns {Object} - { exitPoint, distance, segmentIndex, routePosition }
 */
export function findExitPoint(stamp, routePoints) {
    if (!routePoints || routePoints.length < 2) {
        return null;
    }

    // Calculate center latitude for projection
    const centerLat = routePoints.reduce((sum, p) => sum + p.lat, 0) / routePoints.length;

    let minDistance = Infinity;
    let bestExitPoint = null;
    let bestSegmentIndex = 0;
    let bestT = 0;

    // Check each segment
    for (let i = 0; i < routePoints.length - 1; i++) {
        const result = closestPointOnSegment(
            stamp,
            routePoints[i],
            routePoints[i + 1],
            centerLat
        );

        if (result.distance < minDistance) {
            minDistance = result.distance;
            bestExitPoint = result.point;
            bestSegmentIndex = i;
            bestT = result.t;
        }
    }

    // Calculate position along route (0 = start, 1 = end)
    const totalSegments = routePoints.length - 1;
    const routePosition = (bestSegmentIndex + bestT) / totalSegments;

    return {
        exitPoint: bestExitPoint,
        distance: minDistance,
        segmentIndex: bestSegmentIndex,
        routePosition: routePosition,
        // Round-trip detour estimate (go there and back)
        detourDistance: minDistance * 2
    };
}

/**
 * Analyze all stamps against a route, adding exit point and detour info
 * @param {Array} stamps - stamps with distance already calculated
 * @param {Array} routePoints - full route points
 * @returns {Array} - stamps enriched with exitPoint, detourDistance, routePosition
 */
export function analyzeDetours(stamps, routePoints) {
    return stamps.map(stamp => {
        const analysis = findExitPoint(stamp, routePoints);
        if (!analysis) return stamp;

        return {
            ...stamp,
            exitPoint: analysis.exitPoint,
            detourDistance: analysis.detourDistance,
            routePosition: analysis.routePosition,
            segmentIndex: analysis.segmentIndex,
            // Update distance to use the more accurate segment-based calculation
            distance: analysis.distance
        };
    }).sort((a, b) => a.routePosition - b.routePosition); // Sort by position along route
}

/**
 * Calculate cumulative distance along route up to a given segment
 * @param {Array} routePoints
 * @param {number} segmentIndex
 * @param {number} t - position within segment [0-1]
 * @returns {number} distance in meters from route start
 */
export function distanceAlongRoute(routePoints, segmentIndex, t = 0) {
    let distance = 0;

    for (let i = 0; i < segmentIndex && i < routePoints.length - 1; i++) {
        distance += distanceMeters(
            routePoints[i].lat, routePoints[i].lon,
            routePoints[i + 1].lat, routePoints[i + 1].lon
        );
    }

    // Add partial segment
    if (segmentIndex < routePoints.length - 1 && t > 0) {
        const segmentLength = distanceMeters(
            routePoints[segmentIndex].lat, routePoints[segmentIndex].lon,
            routePoints[segmentIndex + 1].lat, routePoints[segmentIndex + 1].lon
        );
        distance += segmentLength * t;
    }

    return distance;
}

/**
 * Get detour effort category
 * @param {number} detourDistance in meters
 * @returns {string} 'easy' | 'moderate' | 'significant'
 */
export function getDetourEffort(detourDistance) {
    if (detourDistance < 200) return 'easy';        // < 200m round trip
    if (detourDistance < 600) return 'moderate';    // 200-600m round trip
    return 'significant';                            // > 600m round trip
}
