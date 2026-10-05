// Geographic Calculations
function degreesToRadians(degrees) {
    return degrees * Math.PI / 180;
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
    const EARTH_RADIUS_METERS = 6_371_000;

    const latitude1 = degreesToRadians(lat1);
    const latitude2 = degreesToRadians(lat2);

    const latitudeDifference = degreesToRadians(lat2 - lat1);
    const longitudeDifference = degreesToRadians(lon2 - lon1);

    const haversine =
        Math.sin(latitudeDifference / 2) ** 2 +
        Math.cos(latitude1) *
        Math.cos(latitude2) *
        Math.sin(longitudeDifference / 2) ** 2;

    const centralAngle =
        2 * Math.atan2(
            Math.sqrt(haversine),
            Math.sqrt(1 - haversine)
        );

    return EARTH_RADIUS_METERS * centralAngle;
}

export function findNearbyStamps(routePoints, stamps, maxDistance = 500) {
    return stamps
        .map(stamp => {
            let minDistance = Infinity;

            for (const point of routePoints) {
                const distance = distanceMeters(
                    stamp.lat,
                    stamp.lon,
                    point.lat,
                    point.lon
                );

                minDistance = Math.min(minDistance, distance);
            }

            return {
                ...stamp,
                distance: minDistance
            };
        })
        .filter(stamp => stamp.distance <= maxDistance)
        .sort((a, b) => a.distance - b.distance);
}