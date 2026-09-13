#!/usr/bin/env node
/**
 * Converts HWN GPX waypoints to JSON format
 * Run: node scripts/convert-gpx-to-json.js
 */

const fs = require('fs');
const path = require('path');

const gpxPath = path.join(__dirname, '../data/raw/HWN2025.gpx');
const jsonPath = path.join(__dirname, '../data/stampingpoints.json');

const gpxContent = fs.readFileSync(gpxPath, 'utf-8');

// Extract all <wpt>...</wpt> blocks
const wptRegex = /<wpt\s+lat="([^"]+)"\s+lon="([^"]+)"[^>]*>([\s\S]*?)<\/wpt>/g;
const stamps = [];

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

    stamps.push({
        id: hwnMatch ? `HWN${hwnMatch[1]}` : null,
        number: hwnMatch ? parseInt(hwnMatch[1], 10) : null,
        name: hwnMatch ? hwnMatch[2] : rawName,
        description,
        lat,
        lon,
        elevation
    });
}

// Sort by number
stamps.sort((a, b) => (a.number || 999) - (b.number || 999));

fs.writeFileSync(jsonPath, JSON.stringify(stamps, null, 2));
console.log(`Converted ${stamps.length} stamps to ${jsonPath}`);
