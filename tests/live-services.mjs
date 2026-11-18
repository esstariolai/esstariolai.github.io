// Проверка внешних сервисов, от которых зависит сайт тропинок.
// Если что-то из этого перестало отвечать или поменяло формат — сайт частично сломается.
const AREA = { s: 60.284, w: 10.600, n: 60.292, e: 10.620 }; // Роа
const checks = [
  ['Карта угодий AR5 (NIBIO), картинка', async () => {
    const r = await fetch(`https://wms.nibio.no/cgi-bin/ar5?service=WMS&version=1.1.1&request=GetMap&layers=Jordbruksareal&styles=&srs=EPSG:4326&format=image/png&transparent=true&bbox=${AREA.w},${AREA.s},${AREA.e},${AREA.n}&width=200&height=200`);
    if (!r.ok || !(r.headers.get('content-type') || '').includes('image/png')) throw new Error(`HTTP ${r.status} ${r.headers.get('content-type')}`);
  }],
  ['AR5: тип участка по точке (GetFeatureInfo)', async () => {
    const t = await (await fetch(`https://wms.nibio.no/cgi-bin/ar5?service=WMS&version=1.1.1&request=GetFeatureInfo&layers=Arealtype&query_layers=Arealtype&styles=&srs=EPSG:4326&bbox=${AREA.w},${AREA.s},${AREA.e},${AREA.n}&width=400&height=400&x=200&y=200&info_format=application/vnd.ogc.gml`)).text();
    if (!t.includes('artype_beskrivelse')) throw new Error('нет поля artype_beskrivelse');
  }],
  ['Кадастр Matrikkelen (Kartverket)', async () => {
    const crs = 'urn:ogc:def:crs:EPSG::4326';
    const t = await (await fetch(`https://wfs.geonorge.no/skwms1/wfs.matrikkelen-eiendomskart-teig?service=WFS&version=2.0.0&request=GetFeature&typeNames=app:Teig&count=3&srsName=${crs}&bbox=60.287,10.605,60.291,10.615,${crs}`)).text();
    if (!/Teig/.test(t) || !/posList/.test(t)) throw new Error('нет участков или координат');
  }],
  ['OpenStreetMap Overpass (хотя бы одно из 3 зеркал)', async () => {
    const q = `[out:json][timeout:20];way["leisure"="pitch"](${AREA.s},${AREA.w},${AREA.n},${AREA.e});out geom 1;`;
    const res = [];
    for (const u of ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
      try { const r = await fetch(u, { method: 'POST', signal: AbortSignal.timeout(7000), body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'esstariolai-tropinki-check (github.com/esstariolai)' } });
        const t = await r.text(); if (r.ok && t.trim()[0] === '{' && Array.isArray(JSON.parse(t).elements)) return; res.push(`${new URL(u).host}: HTTP ${r.status}`); }
      catch (e) { res.push(`${new URL(u).host}: ${e.name === 'TimeoutError' ? 'нет ответа' : e.message}`); }
    }
    const e = new Error('ни одно зеркало не ответило (' + res.join('; ') + ')');
    e.message = 'с серверов GitHub не отвечает (' + res.join('; ') + '). OSM часто режет облачные запросы — проверь сайт в браузере; у сайта есть запасные зеркала'; e.warn = true;
    throw e;
  }],
  ['Название места (Nominatim)', async () => {
    const r = await fetch('https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&lat=60.288&lon=10.611', { headers: { 'User-Agent': 'esstariolai-tropinki-check' } });
    const j = await r.json(); if (!j.address) throw new Error('нет address');
  }],
  ['Высоты рельефа (Kartverket)', async () => {
    const j = await (await fetch('https://ws.geonorge.no/hoydedata/v1/punkt?koordsys=4258&geojson=false&punkter=' + encodeURIComponent(JSON.stringify([[10.611, 60.288], [10.62, 60.284]])))).json();
    if (!j.punkter || j.punkter.length !== 2 || j.punkter.some(q => typeof q.z !== 'number')) throw new Error('нет высот');
  }],
  ['Leaflet (библиотека карты)', async () => {
    const r = await fetch('https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'); if (!r.ok) throw new Error(`HTTP ${r.status}`);
  }],
];
import { appendFileSync } from 'node:fs';
let bad = 0; const lines = [];
for (const [name, fn] of checks) {
  const t0 = Date.now();
  try { await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('нет ответа 25 с')), 25000))]); lines.push(`✅ ${name} (${Date.now() - t0} мс)`); }
  catch (e) { if (e.warn) lines.push(`⚠️ ${name}: ${e.message}`); else { bad++; lines.push(`❌ ${name}: ${e.message}`); } }
}
lines.push(bad ? `\nНе работает: ${bad} из ${checks.length}` : '\nВсе внешние сервисы отвечают.');
console.log(lines.join('\n'));
if (process.env.GITHUB_ACTIONS) for (const l of lines) { if (l.startsWith('❌')) console.log(`::error title=Внешний сервис::${l.slice(2)}`); else if (l.startsWith('⚠️')) console.log(`::warning title=Внешний сервис::${l.slice(3)}`); else if (l.startsWith('✅')) console.log(`::notice title=Внешний сервис::${l.slice(2)}`); }
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, '### Внешние сервисы\n\n' + lines.join('\n\n') + '\n');
if (bad) process.exit(1);
