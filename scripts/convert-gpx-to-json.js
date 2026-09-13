#!/usr/bin/env node
/**
 * Converts HWN GPX waypoints to GeoJSON FeatureCollection
 * Run: node scripts/convert-gpx-to-json.js
 */

const fs = require('fs');
const path = require('path');

const gpxPath = path.join(__dirname, '../data/raw/HWN2025.gpx');
const geojsonPath = path.join(__dirname, '../src/data/stamps.geojson');

const gpxContent = fs.readFileSync(gpxPath, 'utf-8');

// Extract all <wpt>...</wpt> blocks
const wptRegex = /<wpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/wpt>/g;
const features = [];

let match;
while ((match = wptRegex.exec(gpxContent)) !== null) {
    const lat = parseFloat(match[1]);
    const lon = parseFloat(match[2]);
    const content = match[3];

    // Extract elevation
    const eleMatch = content.match(/<ele>([^<]+)<\/ele>/);
    const elevation = eleMatch ? parseFloat(eleMatch[1]) : null;

    // Extract name
    const nameMatch = content.match(/<name>([^<]+)<\/name>/);
    const rawName = nameMatch ? nameMatch[1].trim() : '';

    // Extract description
    const descMatch = content.match(/<desc>([^<]+)<\/desc>/);
    const description = descMatch ? descMatch[1].trim() : '';

    // Parse "HWN001 Eckertalsperre" format
    const hwnMatch = rawName.match(/^HWN(\d+)\s+(.+)$/);

    features.push({
        type: 'Feature',
        geometry: {
            type: 'Point',
            coordinates: elevation !== null
                ? [lon, lat, elevation]
                : [lon, lat]
        },
        properties: {
            id: hwnMatch ? `HWN${hwnMatch[1]}` : null,
            number: hwnMatch ? parseInt(hwnMatch[1], 10) : null,
            name: hwnMatch ? hwnMatch[2] : rawName,
            description
        }
    });
}

// Sort by number
features.sort((a, b) => (a.properties.number || 999) - (b.properties.number || 999));

const geojson = {
    type: 'FeatureCollection',
    features
};

fs.writeFileSync(geojsonPath, JSON.stringify(geojson, null, 2));
console.log(`Converted ${features.length} stamps to GeoJSON: ${geojsonPath}`);
