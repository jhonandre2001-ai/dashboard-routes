use strict';

const fs   = require('fs');
const path = require('path');

// ── Constantes ─────────────────────────────────────────────────────────────────
const GEOFENCE_RADIUS_M = 200;

// ── Helpers Matemáticos y Logísticos ──────────────────────────────────────────
function calculateDistance(lat1, lon1, lat2, lon2) {
    if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null;

    const R     = 6371000;
    const toRad = (d) => d * (Math.PI / 180);
    const dLat  = toRad(lat2 - lat1);
    const dLon  = toRad(lon2 - lon1);
    const a     = Math.sin(dLat / 2) ** 2 +
                  Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
                  Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function isOnTime(dispatch) {
    const deadline  = dispatch.max_delivery_time ?? dispatch.estimated_at;
    const arrivedAt = dispatch.arrived_at;
    if (deadline == null || arrivedAt == null) return null;

    const dMs = new Date(deadline).getTime();
    const aMs = new Date(arrivedAt).getTime();
    if (isNaN(dMs) || isNaN(aMs)) return null;

    return aMs <= dMs;
}

// ── Acumulador base (factory para evitar mutación compartida) ─────────────────
const ZERO_ACC = () => ({
    total: 0, on_time: 0, late: 0, missing_time: 0,
    inside_200m: 0, outside_200m: 0, missing_coords: 0,
    total_distance_m: 0, distance_count: 0
});

// ── Derivar porcentajes sobre un acumulador (evita duplicación) ───────────────
function derivePercentages(acc) {
    const geo      = acc.inside_200m + acc.outside_200m;
    const otdTotal = acc.on_time + acc.late;

    acc.otd_pct       = otdTotal > 0          ? +((acc.on_time         / otdTotal)           * 100).toFixed(1) : null;
    acc.adherence_pct = geo > 0               ? +((acc.inside_200m      / geo)                * 100).toFixed(1) : null;
    // Dividir por distance_count, no por total: solo los despachos con distanceToNext válido contribuyen
    acc.drop_density  = acc.distance_count > 0 ? +(acc.total_distance_m / acc.distance_count  / 1000).toFixed(2) : null;
}

// ── Validación de estructura del payload de entrada ────────────────────────────
function validateInput(data) {
    if (!data || typeof data !== 'object') throw new Error('El payload raíz no es un objeto válido.');
    if (!Array.isArray(data.routes))       throw new Error('El payload no contiene un arreglo "routes".');
}

// ── Motor de Procesamiento (Transformación ETL) ────────────────────────────────
function processRoutes(data) {
    return data.routes.reduce((payload, route, routeIndex) => {
        if (!Array.isArray(route.dispatches)) {
            console.warn(`⚠️  Ruta sin despachos omitida (índice ${routeIndex}, id: ${route.id ?? 'N/A'})`);
            return payload;
        }

        const kpi = route.dispatches.reduce((k, dispatch) => {
            k.total++;

            // KPI 1 — OTD (Cumplimiento de Ventana)
            const otd = isOnTime(dispatch);
            if      (otd === true)  k.on_time++;
            else if (otd === false) k.late++;
            else                    k.missing_time++;

            // KPI 2 — Adherencia de Geocerca
            const dist = calculateDistance(
                dispatch.planned_lat, dispatch.planned_lng,
                dispatch.actual_lat,  dispatch.actual_lng
            );
            if      (dist === null)             k.missing_coords++;
            else if (dist <= GEOFENCE_RADIUS_M) k.inside_200m++;
            else                                k.outside_200m++;

            // KPI 3 — Drop Density (solo acumular si el valor es numérico)
            const d2next = dispatch.distanceToNext;
            if (typeof d2next === 'number' && !isNaN(d2next)) {
                k.total_distance_m += d2next;
                k.distance_count++;
            }

            return k;
        }, ZERO_ACC());

        derivePercentages(kpi);
        payload.push({ route_id: route.id ?? 'N/A', kpis: kpi });
        return payload;
    }, []);
}

function buildPayload(data) {
    const routes = processRoutes(data);

    const summary = routes.reduce((acc, { kpis }) => {
        acc.total            += kpis.total;
        acc.on_time          += kpis.on_time;
        acc.late             += kpis.late;
        acc.inside_200m      += kpis.inside_200m;
        acc.outside_200m     += kpis.outside_200m;
        acc.missing_coords   += kpis.missing_coords;
        acc.missing_time     += kpis.missing_time;
        acc.total_distance_m += kpis.total_distance_m;
        acc.distance_count   += kpis.distance_count;
        return acc;
    }, ZERO_ACC());

    derivePercentages(summary);

    return {
        generated_at: new Date().toISOString(),
        global_kpis:  summary,
        routes
    };
}

// ── I/O y Ejecución ────────────────────────────────────────────────────────────
const INPUT  = path.join(__dirname, 'data', 'raw.json');
const OUTPUT = path.join(__dirname, 'data', 'kpis.json');

if (!fs.existsSync(INPUT)) {
    console.error(`❌ Error de Ingesta: Archivo de origen no encontrado en ${INPUT}`);
    process.exit(1);
}

try {
    const raw = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

    validateInput(raw);

    const payload = buildPayload(raw);
    fs.writeFileSync(OUTPUT, JSON.stringify(payload, null, 2), 'utf8');

    const g = payload.global_kpis;
    console.log(
        `✅ kpis.json generado — ${payload.routes.length} rutas | ${g.total} despachos` +
        ` | OTD: ${g.otd_pct ?? 'N/A'}% | Geocerca: ${g.adherence_pct ?? 'N/A'}%` +
        ` | Densidad: ${g.drop_density ?? 'N/A'} km/despacho`
    );

} catch (err) {
    const msg = err instanceof SyntaxError
        ? `JSON malformado en raw.json: ${err.message}`
        : err.message;
    console.error(`❌ Error transformando el payload de LastMile: ${msg}`);
    process.exit(1);
}
