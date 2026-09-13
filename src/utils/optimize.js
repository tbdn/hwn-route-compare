// Route Optimization utilities
// Optimizes the order of stamps to minimize total detour distance

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

/**
 * Optimize stamp visit order using nearest neighbor heuristic
 * Starts from the first stamp along the route and visits nearest unvisited stamp
 * @param {Array} stamps - Array of stamps with routePosition property
 * @returns {Array} - Stamps in optimized order
 */
export function optimizeStampOrder(stamps) {
    if (stamps.length <= 2) return [...stamps];

    // Sort by route position first to get natural order
    const sorted = [...stamps].sort((a, b) => a.routePosition - b.routePosition);

    const optimized = [];
    const remaining = new Set(sorted.map((_, i) => i));

    // Start with the first stamp along the route
    let currentIdx = 0;
    optimized.push(sorted[currentIdx]);
    remaining.delete(currentIdx);

    // Nearest neighbor algorithm
    while (remaining.size > 0) {
        let nearestIdx = null;
        let nearestDist = Infinity;

        const current = sorted[currentIdx];

        for (const idx of remaining) {
            const candidate = sorted[idx];
            const dist = distanceMeters(current.lat, current.lon, candidate.lat, candidate.lon);

            if (dist < nearestDist) {
                nearestDist = dist;
                nearestIdx = idx;
            }
        }

        if (nearestIdx !== null) {
            optimized.push(sorted[nearestIdx]);
            remaining.delete(nearestIdx);
            currentIdx = nearestIdx;
        }
    }

    return optimized;
}

/**
 * Calculate total distance of visiting stamps in given order
 * @param {Array} stamps - Array of stamps in visit order
 * @param {Object} startPoint - Optional start point {lat, lon}
 * @param {Object} endPoint - Optional end point {lat, lon}
 * @returns {number} - Total distance in meters
 */
export function calculateTotalDistance(stamps, startPoint = null, endPoint = null) {
    if (stamps.length === 0) return 0;

    let total = 0;

    // Distance from start to first stamp
    if (startPoint) {
        total += distanceMeters(startPoint.lat, startPoint.lon, stamps[0].lat, stamps[0].lon);
    }

    // Distance between stamps
    for (let i = 0; i < stamps.length - 1; i++) {
        total += distanceMeters(stamps[i].lat, stamps[i].lon, stamps[i + 1].lat, stamps[i + 1].lon);
    }

    // Distance from last stamp to end
    if (endPoint) {
        const last = stamps[stamps.length - 1];
        total += distanceMeters(last.lat, last.lon, endPoint.lat, endPoint.lon);
    }

    return total;
}

/**
 * Calculate estimated detour for visiting all stamps
 * Sum of all individual detour distances
 * @param {Array} stamps - Array of stamps with detourDistance property
 * @returns {number} - Total detour in meters
 */
export function calculateTotalDetour(stamps) {
    return stamps.reduce((sum, s) => sum + (s.detourDistance || s.distance * 2), 0);
}

/**
 * Generate GPX file content from optimized route
 * @param {Array} stamps - Stamps in visit order
 * @param {Object} options - {name, description}
 * @returns {string} - GPX XML content
 */
export function generateGPX(stamps, options = {}) {
    const name = options.name || 'HWN Optimierte Route';
    const desc = options.description || `Route mit ${stamps.length} Stempelstellen`;

    const waypoints = stamps.map((stamp, i) => `
    <wpt lat="${stamp.lat}" lon="${stamp.lon}">
        <ele>${stamp.elevation || 0}</ele>
        <name>${i + 1}. ${stamp.name}</name>
        <desc>${stamp.id} - ${stamp.description || stamp.name}</desc>
        <sym>Flag</sym>
    </wpt>`).join('');

    // Create a route (for navigation apps)
    const routePoints = stamps.map(stamp => `
        <rtept lat="${stamp.lat}" lon="${stamp.lon}">
            <ele>${stamp.elevation || 0}</ele>
            <name>${stamp.name}</name>
        </rtept>`).join('');

    return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="HWN Route Compare"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
    <metadata>
        <name>${escapeXml(name)}</name>
        <desc>${escapeXml(desc)}</desc>
        <time>${new Date().toISOString()}</time>
    </metadata>
${waypoints}
    <rte>
        <name>${escapeXml(name)}</name>
        <desc>${escapeXml(desc)}</desc>
${routePoints}
    </rte>
</gpx>`;
}

function escapeXml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Download GPX file
 * @param {string} gpxContent - GPX XML content
 * @param {string} filename - Filename without extension
 */
export function downloadGPX(gpxContent, filename = 'hwn-route') {
    const blob = new Blob([gpxContent], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.gpx`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    URL.revokeObjectURL(url);
}
