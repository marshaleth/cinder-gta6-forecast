/* 
 * Robust Twitch viewer forecast engine.
 * Computes hourly log-ratios relative to hour-1, applies robust statistics 
 * (median, MAD-based sigma), smooths the result, and projects quantiles 
 * with tail widening.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const INPUT = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Target quantile definitions and Z-scores
const TARGET_QUANTILES = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z_SCORES = [-1.645, -0.674, 0, 0.674, 1.645];
const TAIL_WIDENING = [-0.12, -0.06, 0.0, 0.06, 0.14];

function getMedian(values: number[]): number {
    if (values.length === 0) return NaN;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 
        ? sorted[mid] 
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

function getRobustSigma(values: number[]): number {
    const med = getMedian(values);
    const deviations = values.map(v => Math.abs(v - med));
    // 1.4826 converts MAD to a standard deviation estimate for normal dist
    return 1.4826 * getMedian(deviations);
}

interface HourlyEntry { from: string; viewers: number }

function mapDataToHourlyBuckets(data: HourlyEntry[], startTime: number): (number | null)[] {
    const buckets: (number | null)[] = new Array(24).fill(null);
    for (const entry of data) {
        if (!entry || typeof entry.viewers !== 'number' || entry.viewers <= 0) continue;
        const entryTime = new Date(entry.from).getTime();
        const hour = Math.floor((entryTime - startTime) / 3600000) + 1;
        if (hour >= 1 && hour <= 24) buckets[hour - 1] = entry.viewers;
    }
    return buckets;
}

function runForecastEngine() {
    if (!fs.existsSync(OUTPUT)) {
        fs.mkdirSync(OUTPUT, { recursive: true });
    }

    const files = fs.readdirSync(INPUT).filter(f => f.endsWith('.in')).sort();
    
    for (const file of files) {
        const id = file.replace(/\.in$/, '');
        const content = JSON.parse(fs.readFileSync(path.join(INPUT, file), 'utf8'));
        
        const knownData = Array.isArray(content.known) ? content.known[0] : content.known;
        const currentViewers = Math.max(1, knownData.viewers);
        const dayStart = new Date(content.day_start).getTime();

        // Accumulate log-ratios across all comparable launches
        const hourLogRatios: number[][] = Array.from({ length: 24 }, () => []);
        const comparables = content.comparables ?? [];

        for (const comp of comparables) {
            const compStart = new Date(comp.day_start ?? content.day_start).getTime();
            const buckets = mapDataToHourlyBuckets(comp.hourly ?? [], compStart);
            const baseViewers = buckets[0];
            
            if (baseViewers && baseViewers > 0) {
                for (let h = 1; h < 24; h++) {
                    const hViewers = buckets[h];
                    if (hViewers && hViewers > 0) {
                        hourLogRatios[h].push(Math.log(hViewers / baseViewers));
                    }
                }
            }
        }

        // Calculate and smooth robust statistics
        const muValues: number[] = new Array(24).fill(0);
        const sigmaValues: number[] = new Array(24).fill(0.35);

        for (let h = 1; h < 24; h++) {
            const ratios = hourLogRatios[h];
            if (ratios.length > 0) {
                let m = getMedian(ratios);
                let s = getRobustSigma(ratios);
                
                if (!isFinite(m)) m = 0;
                if (!isFinite(s) || s <= 0.02) s = 0.35;
                
                sigmaValues[h] = Math.max(0.25, Math.min(0.65, s));
                muValues[h] = m;
            }
        }

        // Apply simple moving average smoothing to mu
        const smoothedMu = [...muValues];
        for (let h = 1; h < 23; h++) {
            smoothedMu[h] = 0.5 * muValues[h] + 0.25 * (muValues[h - 1] ?? muValues[h]) + 0.25 * (muValues[h + 1] ?? muValues[h]);
        }

        // Generate final forecast
        const forecast = [];
        for (let h = 1; h < 24; h++) {
            const q = TARGET_QUANTILES.map((_, i) => {
                const logVal = smoothedMu[h] + Z_SCORES[i] * sigmaValues[h] + TAIL_WIDENING[i];
                return Math.max(1, Math.min(1e9, currentViewers * Math.exp(logVal)));
            });
            
            // Ensure non-decreasing
            for (let i = 1; i < q.length; i++) {
                if (q[i] < q[i - 1]) q[i] = q[i - 1];
            }
            
            forecast.push({ hour: h + 1, q });
        }

        fs.writeFileSync(path.join(OUTPUT, `${id}.out`), JSON.stringify({ hours: forecast }));
    }
}

runForecastEngine();
