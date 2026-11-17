// GTA VI launch-day Twitch viewers forecast — robust comparables model.
// For each hour h=2..24 we estimate the distribution of the log-ratio of hour-h viewers
// to hour-1 viewers across comparable launches, then output calibrated quantiles.
// Robustness: parametric log-normal per hour from trimmed statistics (median, MAD),
// sigma capped, timeseries lightly smoothed; spread widened for a bigger title.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
// extra log spread for a bigger-than-comparables title (widened tails)
const WIDEN = [-0.12, -0.06, 0.0, 0.06, 0.14];

const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a: number[]) => {
    const b = [...a].sort((x, y) => x - y);
    const n = b.length;
    return n === 0 ? NaN : (b[Math.floor((n - 1) / 2)] + b[Math.ceil((n - 1) / 2)]) / 2;
};
// median absolute deviation, scaled to be a consistent sigma estimate
const madSigma = (a: number[]) => {
    const m = median(a);
    return 1.4826 * median(a.map(x => Math.abs(x - m)));
};
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

interface Row { from: string; viewers: number; channels?: number | null }
interface Comp { name: string; day_start: string; unlock?: string | null; platforms?: string[]; hourly: Row[] }

function hourIndex(rows: Row[], dayStart: Date): (number | null)[] {
    // map each hourly row to its hour index (1..24) relative to dayStart
    const out: (number | null)[] = new Array(24).fill(null);
    for (const r of rows) {
        if (!r || typeof r.viewers !== 'number' || r.viewers <= 0) continue;
        const t = new Date(r.from).getTime();
        const h = Math.floor((t - dayStart.getTime()) / 3600000) + 1;
        if (h >= 1 && h <= 24) out[h - 1] = r.viewers;
    }
    return out;
}

function solve() {
    const files = readdirSync(INPUT_DIR).filter(f => f.endsWith('.in')).sort();
    for (const file of files) {
        const id = file.replace(/\.in$/, '');
        const data = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8'));
        const known = Array.isArray(data.known) ? data.known[0] : data.known;
        const p = Math.max(1, known.viewers);
        const dayStart = new Date(data.day_start);

        // gather log-ratios per hour across comparables, weighting by similarity
        const ratios: number[][] = Array.from({ length: 24 }, () => []);
        const comps: Comp[] = data.comparables ?? [];
        for (const comp of comps) {
            const ownStart = new Date(comp.day_start ?? data.day_start);
            const hrs = hourIndex(comp.hourly ?? [], ownStart);
            const v1 = hrs[0];
            if (!v1 || v1 <= 0) continue;
            for (let h = 2; h <= 24; h++) {
                const vh = hrs[h - 1];
                if (vh && vh > 0) ratios[h - 1].push(Math.log(vh / v1));
            }
        }

        // robust per-hour stats
        const mu: number[] = new Array(25).fill(0);
        const sig: number[] = new Array(25).fill(0);
        for (let h = 2; h <= 24; h++) {
            const a = ratios[h - 1];
            let m = median(a), s = madSigma(a);
            if (!isFinite(m)) m = 0;
            if (!isFinite(s) || s <= 0.02) s = 0.35;
            s = clamp(s, 0.25, 0.65);               // cap tail blowups from outlier comps
            // light smoothing with neighbours to keep the curve sane hour over hour
            mu[h] = m;
            sig[h] = s;
        }
        for (let h = 2; h <= 24; h++) {
            const prev = mu[h - 1] ?? mu[h], next = mu[h + 1] ?? mu[h];
            mu[h] = 0.5 * mu[h] + 0.25 * prev + 0.25 * next;
        }

        const hours: { hour: number; q: number[] }[] = [];
        for (let h = 2; h <= 24; h++) {
            const q = LEVELS.map((tau, i) => {
                const l = mu[h] + Z[i] * sig[h] + WIDEN[i];
                return Math.max(1, Math.min(1e9, p * Math.exp(l)));
            });
            for (let i = 1; i < 5; i++) q[i] = Math.max(q[i], q[i - 1]);
            hours.push({ hour: h, q });
        }
        writeFileSync(join(OUTPUT_DIR, `${id}.out`), JSON.stringify({ hours }));
    }
}

mkdirSync(OUTPUT_DIR, { recursive: true });
solve();
