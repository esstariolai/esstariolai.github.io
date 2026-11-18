// Автотесты для «Генератора тропинок в снегу» (tropinki/index.html).
// Запуск: cd tests && npm install && npx playwright install chromium && npm test
// Внешние сервисы (карты, AR5, кадастр, OSM) в этих тестах отключены — проверяется только наш код.
// Живые сервисы проверяет отдельный скрипт live-services.mjs.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const PAGE = pathToFileURL(path.join(here, '..', 'tropinki', 'index.html')).href;
const LEAFLET = readFileSync(path.join(here, 'node_modules', 'leaflet', 'dist', 'leaflet.js'), 'utf8');
const FIX = n => path.join(here, 'fixtures', n);

// Г-образное поле у Роа (широта, долгота)
const LSHAPE = [[60.2900, 10.6100], [60.2908, 10.6097], [60.2909, 10.6112], [60.2904, 10.6113], [60.2903, 10.6122], [60.2898, 10.6120], [60.2899, 10.6110]];

let browser;
before(async () => { browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}); });
after(async () => { await browser?.close(); });

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 640, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  await page.route('**/*', r => {
    const u = r.request().url();
    if (u.startsWith('file:')) return r.continue();
    if (u.includes('leaflet.min.js')) return r.fulfill({ body: LEAFLET, contentType: 'application/javascript' });
    return r.abort();
  });
  await page.goto(PAGE);
  await page.waitForTimeout(300);
  return { page, errors, ev: js => page.evaluate(js) };
}

async function withGeoField(ev, ll = LSHAPE) {
  await ev(`initMap&&initMap();fieldFromLL(${JSON.stringify(ll)},'Тест');afterField();`);
}

// Все «новые» точки маршрута внутри разрешённой области, длина конечна
async function checkRoute(ev, label) {
  const r = await ev(`(()=>{applyField();if(!cur)return{none:true};let out=0,pts=0;cur.R.ST.forEach(s=>{if(s.k!=='new')return;s.p.forEach(q=>{pts++;if(!allowedAt(q,CFG)&&bdist(q,CFG.poly).d>0.6)out++;});});return{steps:cur.R.ST.length,total:cur.R.total,out,pts,name:cur.R.name,texts:cur.R.ST.map(s=>s.t)};})()`);
  assert.ok(!r.none, `${label}: маршрут не построен`);
  assert.ok(r.steps >= 3, `${label}: слишком мало шагов (${r.steps})`);
  assert.ok(Number.isFinite(r.total) && r.total > 5, `${label}: длина ${r.total}`);
  assert.equal(r.out, 0, `${label}: ${r.out} из ${r.pts} точек вне поля`);
  for (const t of r.texts) {
    assert.ok(!/undefined|NaN|\.\./.test(t), `${label}: кривой текст подсказки: «${t}»`);
  }
  return r;
}

test('страница открывается без ошибок', async () => {
  const { page, errors, ev } = await openPage();
  const title = await ev('document.title');
  assert.match(title, /тропинок/);
  assert.deepEqual(errors, []);
  await page.close();
});

test('«Мои поля»: переименовать, удалить, вернуть через «Назад», пережить перезагрузку', async () => {
  const { page, errors, ev } = await openPage();
  assert.equal(await ev(`$('preset').value`), 'f:rink');
  await page.fill('#fName', 'Мой каток');
  assert.ok((await ev(`[...$('preset').options].map(o=>o.textContent).join('|')`)).includes('Мой каток'));
  await ev(`$('fDel').click()`);
  assert.equal(await ev(`SAVED.length`), 0);
  await ev(`$('undo').click()`);
  assert.equal(await ev(`SAVED.length`), 1);
  await withGeoField(ev);
  const sid = await ev('FIELD.sid');
  assert.ok(sid, 'поле с карты не сохранилось автоматически');
  await ev(`$('reset').click()`);
  assert.equal(await ev(`SAVED.length`), 2, '«Сброс» не должен стирать список полей');
  await page.reload(); await page.waitForTimeout(300);
  assert.equal(await ev(`SAVED.length`), 2, 'список полей пропал после перезагрузки');
  assert.deepEqual(errors, []);
  await page.close();
});

test('классические узоры на поле неровной формы', async () => {
  const { page, errors, ev } = await openPage();
  await withGeoField(ev);
  await ev(`$('sOwn').click()`); await checkRoute(ev, 'Отскоки');
  await ev(`$('sRings').click()`); await checkRoute(ev, 'Кольца');
  await ev(`$('sPm').click();$('pmSel').value=PATS[3].s;$('pmSel').onchange()`); await checkRoute(ev, 'pattern.monster');
  assert.deepEqual(errors, []);
  await page.close();
});

test('круглые узоры: все виды и все режимы размера', async () => {
  const { page, errors, ev } = await openPage();
  await withGeoField(ev);
  await ev(`$('sGl').click()`);
  for (const kind of ['spiro', 'epi', 'rose', 'wave', 'barley', 'moire']) {
    for (const fit of ['in', 'fill', 'pack', 'grid']) {
      if (kind === 'moire' && fit !== 'fill') continue;
      await ev(`$('glKind').value='${kind}';$('glFit').value='${fit}';$('glS').value='';$('glK').value=6;$('glM').value=2;$('glKind').onchange()`);
      const t0 = Date.now();
      await checkRoute(ev, `Круглые ${kind}/${fit}`);
      assert.ok(Date.now() - t0 < 8000, `${kind}/${fit}: слишком медленно`);
    }
  }
  assert.deepEqual(errors, []);
  await page.close();
});

test('узор из картинки: смайлик по центру линий и контуры', async () => {
  const { page, errors, ev } = await openPage();
  await withGeoField(ev);
  await ev(`$('sImg').click()`);
  await page.setInputFiles('#imgF', FIX('smile.png'));
  await page.waitForTimeout(800);
  let note = await ev(`$('imgNote').textContent`);
  assert.match(note, /по центру линий/);
  await checkRoute(ev, 'Картинка (линии)');
  await ev(`$('imgM').value='outline';$('imgM').onchange()`);
  await page.waitForTimeout(500);
  note = await ev(`$('imgNote').textContent`);
  assert.match(note, /контуры/);
  await checkRoute(ev, 'Картинка (контуры)');
  await ev(`$('imgFit').value='fill';$('imgFit').onchange()`);
  await checkRoute(ev, 'Картинка на всё поле');
  assert.deepEqual(errors, []);
  await page.close();
});

test('способы: пешком, снегоступы, лыжи, лопата', async () => {
  const { page, errors, ev } = await openPage();
  await withGeoField(ev);
  const res = {};
  for (const [btn, word] of [['mWalk', 'пешком'], ['mShoe', 'на снегоступах'], ['mSki', 'на лыжах'], ['mShovel', 'с лопатой']]) {
    await ev(`$('${btn}').click()`);
    const st = await ev(`$('pstat').textContent`);
    assert.ok(st.includes(word), `${btn}: нет «${word}» в «${st}»`);
    res[btn] = await checkRoute(ev, btn);
  }
  assert.match(res.mShovel.texts[0] + res.mShovel.texts.join(' '), /С лопатой:/);
  assert.equal(await ev(`!!document.getElementById('mBike')`), false, 'велосипеда в узорах быть не должно');
  assert.deepEqual(errors, []);
  await page.close();
});

test('трасса: старт берётся с поля, убрать старт, «Назад», велосипед', async () => {
  const { page, errors, ev } = await openPage();
  await withGeoField(ev);
  await ev(`$('mdTrail').click()`);
  assert.ok(await ev('!!TRAIL.start'), 'старт не взят с поля');
  await ev(`$('tClr').click()`);
  assert.equal(await ev('TRAIL.start'), null);
  await ev(`$('undo').click()`);
  assert.ok(await ev('!!TRAIL.start'), '«Назад» не вернул старт');
  await ev(`$('tmBike').click()`);
  assert.equal(await ev('TRAIL.move'), 'bike');
  await page.waitForTimeout(50);
  assert.equal(await ev(`$('tStyleRow').classList.contains('hidden')`), true, 'для велосипеда не должно быть стилей трассы по полю');
  assert.equal(await ev(`$('tBikeProf').parentElement.classList.contains('hidden')`), false, 'нет выбора дорог для велосипеда');
  assert.deepEqual(errors, []);
  await page.close();
});

test('экспорт: KML/GPX строятся, ссылка до старта', async () => {
  const { page, errors, ev } = await openPage();
  await withGeoField(ev);
  await ev(`$('sRings').click()`);
  const n = await ev('routeLL().length');
  assert.ok(n > 10);
  const kml = await ev(`kmlOf(routeLL(),'Тест',routeLL()[0])`);
  assert.match(kml, /<LineString>/);
  const gpx = await ev(`gpxOf(routeLL(),'Тест')`);
  assert.match(gpx, /<trkpt /);
  assert.deepEqual(errors, []);
  await page.close();
});

const FIELD2 = [[60.2800, 10.6100], [60.2812, 10.6098], [60.2816, 10.6120], [60.2812, 10.6135], [60.2806, 10.6131], [60.2805, 10.6122], [60.2800, 10.6125], [60.2797, 10.6112]];
test('трассы на поле: все шесть стилей внутри поля, плавные, круги', async () => {
  const { page, errors, ev } = await openPage();
  await withGeoField(ev, FIELD2);
  await ev(`$('mdTrail').click()`);
  for (const [st, opt] of [['edge', '{}'], ['eight', '{lobes:2}'], ['eight', '{lobes:3}'], ['eight', '{lobes:4}'], ['snake', '{}'], ['snail', '{}'], ['stadium', '{}']]) {
    const r = await ev(`(()=>{const b=courseBuild('${st}',Object.assign({km:3},${opt}));if(b.err)return{err:b.err};const R=courseSteps(b);return{lap:b.lap,laps:b.laps,minR:b.minR,out:b.loop.filter(q=>!allowedAt(q,CFG)).length,steps:R.ST.length,bad:R.ST.filter(s=>/undefined|NaN/.test(s.t)).length}})()`);
    assert.ok(!r.err, `${st}${opt}: ${r.err}`);
    assert.equal(r.out, 0, `${st}${opt}: ${r.out} точек вне поля`);
    assert.ok(r.minR >= 3, `${st}${opt}: слишком крутой поворот (радиус ${r.minR.toFixed(1)} м)`);
    assert.ok(r.lap > 100 && r.laps >= 1, `${st}${opt}: круг ${r.lap}`);
    assert.equal(r.bad, 0, `${st}${opt}: кривые подсказки`);
  }
  // трасса-картинка
  await ev(`$('tStyle').value='image';$('tStyle').onchange()`);
  await page.setInputFiles('#tImgF', FIX('smile.png'));
  await page.waitForTimeout(800);
  const im = await ev(`(()=>{const b=courseBuild('image',{km:2});return b.err?{err:b.err}:{lap:b.lap,out:b.loop.filter(q=>!allowedAt(q,CFG)).length}})()`);
  assert.ok(!im.err, 'картинка: ' + im.err);
  assert.equal(im.out, 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('велосипед: подбор достопримечательностей под длину маршрута', async () => {
  const { page, errors, ev } = await openPage();
  const r = await ev(`(()=>{const S=[60.288,10.611];const c=[];for(let i=0;i<30;i++){const a=i*2.4,d=0.01+0.004*i;c.push({name:'М'+i,ll:[S[0]+d*Math.cos(a),S[1]+d*2*Math.sin(a)],w:1+(i%3)});}
    const out=[];for(const T of [5000,15000,40000]){const st=planSights(S,S,c,T);let L=0;const pts=[S].concat(st.map(x=>x.ll),[S]);for(let i=1;i<pts.length;i++)L+=hav(pts[i-1],pts[i])*1.35;out.push({T,n:st.length,L});}return out;})()`);
  assert.ok(r[0].n < r[1].n && r[1].n < r[2].n, 'чем длиннее маршрут, тем больше мест: ' + JSON.stringify(r));
  for (const x of r) assert.ok(x.L <= x.T + 1, 'оценка длины не больше заданной');
  assert.equal(await ev(`$('tSights').type`), 'checkbox');
  assert.deepEqual(errors, []);
  await page.close();
});
