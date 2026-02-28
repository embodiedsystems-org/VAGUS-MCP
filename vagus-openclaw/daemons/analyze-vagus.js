#!/usr/bin/env node
/**
 * Analyze VAGUS CSV log for somatic correlations
 */

const fs = require('fs');
const path = require('path');

const CSV_PATH = '/data/.openclaw/workspace/vagus_log.csv';

function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = lines[0].split(',');
  const data = lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v === '' ? NaN : parseFloat(v));
    const row = {};
    headers.forEach((h, i) => row[h.trim()] = vals[i]);
    return row;
  });
  return { headers, data };
}

function mean(arr) {
  return arr.reduce((a,b)=>a+b,0) / arr.length;
}

function variance(arr) {
  const m = mean(arr);
  return arr.reduce((a,b)=>a+(b-m)**2,0) / arr.length;
}

function pearsonCorr(x, y) {
  const n = Math.min(x.length, y.length);
  const xMean = mean(x.slice(0,n));
  const yMean = mean(y.slice(0,n));
  let numerator = 0, denomX = 0, denomY = 0;
  for (let i=0; i<n; i++) {
    const dx = x[i] - xMean;
    const dy = y[i] - yMean;
    numerator += dx * dy;
    denomX += dx*dx;
    denomY += dy*dy;
  }
  if (denomX === 0 || denomY === 0) return 0;
  return numerator / Math.sqrt(denomX * denomY);
}

// Load CSV
const content = fs.readFileSync(CSV_PATH, 'utf-8');
const { headers, data } = parseCSV(content);

console.log(`📊 VAGUS Data Analysis`);
console.log(`Rows: ${data.length}`);

if (data.length < 2) {
  console.log('Not enough data for analysis yet.');
  process.exit(0);
}

// Extract series
const lightCh1 = data.map(d => d.light_ch1).filter(v => !isNaN(v));
const lightCh0 = data.map(d => d.light_ch0).filter(v => !isNaN(v));
const flickerVar = (() => {
  const n = 20;
  if (lightCh1.length < n) return [];
  const vars = [];
  for (let i=n-1; i<lightCh1.length; i++) {
    const slice = lightCh1.slice(i-n+1, i+1);
    const m = mean(slice);
    const v = variance(slice);
    vars.push(v);
  }
  return vars;
})();

const magnetHeading = data.map(d => {
  if (isNaN(d.magnet_x) || isNaN(d.magnet_y)) return NaN;
  return Math.atan2(d.magnet_y, d.magnet_x) * (180/Math.PI);
}).filter(v => !isNaN(v));

const colorRB = data.map(d => {
  if (d.color_b > 0) return d.color_r / d.color_b;
  return NaN;
}).filter(v => !isNaN(v));

const proximity = data.map(d => d.prox_dist).filter(v => !isNaN(v));

const attentionAvail = data.map(d => d.attention_availability === 'available' ? 1 : 0);

console.log('\n--- Basic Stats ---');
console.log(`Light (ch0) mean: ${mean(lightCh0).toFixed(2)} lx, var: ${variance(lightCh0).toFixed(2)}`);
console.log(`Light flicker variance (20-sample rolling mean): ${mean(flickerVar).toFixed(1)}`);
console.log(`Magnetometer heading mean: ${mean(magnetHeading).toFixed(1)}°, var: ${variance(magnetHeading).toFixed(3)}`);
console.log(`Color R/B ratio mean: ${mean(colorRB).toFixed(3)}, var: ${variance(colorRB).toFixed(3)}`);
console.log(`Proximity mean: ${mean(proximity).toFixed(1)} cm`);

console.log('\n--- Correlations ---');
if (flickerVar.length > 1 && lightCh0.length >= flickerVar.length) {
  const corr_flicker_light = pearsonCorr(flickerVar, lightCh0.slice(-flickerVar.length));
  console.log(`Flicker variance vs Light level: ${corr_flicker_light.toFixed(3)}`);
}

if (magnetHeading.length > 1 && proximity.length >= magnetHeading.length) {
  const corr_head_prox = pearsonCorr(magnetHeading, proximity.slice(-magnetHeading.length));
  console.log(`Magnet heading vs Proximity: ${corr_head_prox.toFixed(3)}`);
}

if (colorRB.length > 1 && lightCh0.length >= colorRB.length) {
  const corr_rb_light = pearsonCorr(colorRB, lightCh0.slice(-colorRB.length));
  console.log(`R/B ratio vs Light level: ${corr_rb_light.toFixed(3)}`);
}

// Event counts (transitions)
let screenOnCount = 0, screenOffCount = 0;
let lastScreen = null;
data.forEach(d => {
  const screen = d.screen_on;
  if (lastScreen !== null && screen !== lastScreen) {
    if (screen === 1) screenOnCount++;
    else screenOffCount++;
  }
  lastScreen = screen;
});
console.log('\n--- Events ---');
console.log(`Screen transitions: ON ${screenOnCount}, OFF ${screenOffCount}`);

console.log('\n--- Sample Rows ---');
console.log(data.slice(0,5).map(d => JSON.stringify(d)).join('\n'));
console.log('...');
console.log('(End of analysis)');
