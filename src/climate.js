// Montreal's sky, hour by hour and season by season.
//
// The clock is a count of days (UTC, since 1970). In live mode it is the real
// time; otherwise it runs faster, or from an hour set with the , and . keys.
// From it come:
// - the sun, where it really stands over Montreal (45.5° N, 73.57° W) at that
//   moment: declination and the equation of time from the day of the year,
//   hour angle from UTC and the longitude. x is east, z south (as the map);
// - the moon, from its age (days since a known new moon) and phase;
// - the weather: smooth noise over time, biased by the month's cloudiness and
//   Montreal's normal temperatures (1991–2020), so November is grey and wet,
//   January cold and snowy, July warm with the odd shower. Below ~1 °C it snows;
// - the season, from the day of the year (live), a fast cycle, or one held
//   (winter, spring, summer, autumn): snow on the ground from December to
//   March, maples leafing out in May and turning red and orange in October,
//   grass green in spring and tired in late summer.
// What the renderer needs (sky colors, the light and its color, the ambient,
// haze, wetness, snow cover, leaves) and what the tires feel (grip) are
// recomputed by update(dt).

const LAT = 45.5017 * Math.PI / 180, LON = -73.5673;
const DAY_MS = 86400000;
const NEW_MOON = Date.UTC(2000, 0, 6, 18, 14) / DAY_MS, LUNATION = 29.530588;
// Normal daily mean temperature per month (°C), Montreal (Trudeau), mid-month.
const TEMPS = [-9.7, -8.0, -2.4, 6.1, 13.4, 18.6, 21.2, 20.1, 15.4, 8.4, 2.1, -5.4];
// How often the sky is grey, per month (0 .. 1): November and December the most.
const CLOUDY = [0.52, 0.48, 0.5, 0.5, 0.46, 0.42, 0.38, 0.38, 0.42, 0.5, 0.64, 0.6];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH_START = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];

// Clock modes: how fast a day goes by. 'set' runs at real speed from a chosen hour.
export const CLOCKS = {
  live: { label: 'Live', rate: 1 },
  set: { label: '×1', rate: 1 },
  fast: { label: '×60', rate: 60 },     // a day in 24 minutes
  lapse: { label: '×720', rate: 720 },  // a day in 2 minutes
};
export const CLOCK_ORDER = ['live', 'fast', 'lapse'];
// Seasons: 'live' follows the clock's date; 'cycle' runs a year in 40 minutes;
// the others hold a day of the year.
export const SEASONS = {
  live: { label: 'Live' },
  cycle: { label: 'Cycle' },
  winter: { label: 'Winter', day: 30 },   // end of January
  spring: { label: 'Spring', day: 135 },  // mid-May
  summer: { label: 'Summer', day: 196 },  // mid-July
  autumn: { label: 'Autumn', day: 285 },  // mid-October
};
export const SEASON_ORDER = ['live', 'cycle', 'winter', 'spring', 'summer', 'autumn'];
const CYCLE_SECONDS = 40 * 60;

const clampC = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const smoothC = (a, b, v) => { const t = clampC((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const mixC = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const scaleC = (a, k) => a.map((v) => v * k);
const normC = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };

// Smooth 1-D value noise (0 .. 1).
function hashC(i) { const s = Math.sin(i * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); }
function noiseC(x) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hashC(i) + (hashC(i + 1) - hashC(i)) * u;
}

// A value that goes round the year: keyframes [[day, value]] sorted by day,
// interpolated smoothly between them and across New Year.
function cyc(keys, day) {
  const n = keys.length;
  const ext = [[keys[n - 1][0] - 365, keys[n - 1][1]], ...keys, [keys[0][0] + 365, keys[0][1]]];
  for (let k = 0; k < ext.length - 1; k++) {
    const [d0, v0] = ext[k], [d1, v1] = ext[k + 1];
    if (day >= d0 && day <= d1) {
      const t = smoothC(0, 1, (day - d0) / (d1 - d0 || 1));
      return Array.isArray(v0) ? mixC(v0, v1, t) : v0 + (v1 - v0) * t;
    }
  }
  return keys[0][1];
}

// Snow lying on the ground, normally (0 .. 1): patches from mid-November, all
// white from Christmas to mid-March, gone by mid-April.
const SNOW_KEYS = [[0, 1], [74, 1], [92, 0.35], [104, 0], [318, 0], [338, 0.3], [358, 1]];
// Leaves on the maples (0 bare .. 1) and how far they've turned (0 green .. 1 red).
const LEAF_KEYS = [[0, 0], [120, 0], [146, 1], [282, 1], [300, 0.55], [314, 0]];
const AUTUMN_KEYS = [[0, 1], [110, 1], [121, 0], [256, 0], [285, 1]];
const FRESH_KEYS = [[0, 0], [121, 0], [135, 1], [170, 0]]; // young light-green leaves in May
// Grass color multiplier: dormant straw in winter, bright in spring, dry in August.
const GRASS_KEYS = [
  [20, [1.15, 0.95, 0.62]], [100, [1.1, 0.95, 0.62]], [135, [0.95, 1.12, 0.78]], [180, [1, 1.02, 0.95]],
  [228, [1.1, 1.0, 0.72]], [270, [1.0, 1.0, 0.85]], [300, [1.18, 0.95, 0.6]],
];

// Sky colors.
const DAY_HORIZON = [0.78, 0.86, 0.93], DAY_ZENITH = [0.27, 0.5, 0.86];
const DUSK_HORIZON = [0.98, 0.58, 0.32], DUSK_ZENITH = [0.24, 0.3, 0.52];
const NIGHT_HORIZON = [0.1, 0.09, 0.12], NIGHT_ZENITH = [0.012, 0.018, 0.045]; // the city glows on the horizon
const GREY = [0.68, 0.7, 0.74];

// Day of the year (0-based, fractional) and minutes past midnight, in Montreal, for a UTC day count.
function montrealDate(days) {
  // Daylight saving: second Sunday of March to first Sunday of November (close enough by day of year).
  const d = new Date(days * DAY_MS - 5 * 3600000);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const doy = (d.getTime() - start) / DAY_MS;
  const dst = doy >= 68 && doy < 306;
  const local = new Date(days * DAY_MS - (dst ? 4 : 5) * 3600000);
  return {
    year: local.getUTCFullYear(),
    day: (local.getTime() - Date.UTC(local.getUTCFullYear(), 0, 1)) / DAY_MS,
    minutes: local.getUTCHours() * 60 + local.getUTCMinutes() + local.getUTCSeconds() / 60,
    weekday: local.getUTCDay(),
  };
}

// Direction to a body at declination dec (rad) and hour angle H (rad, positive west of south).
function skyDir(dec, H) {
  const east = -Math.cos(dec) * Math.sin(H);
  const north = Math.sin(dec) * Math.cos(LAT) - Math.cos(dec) * Math.cos(H) * Math.sin(LAT);
  const up = Math.sin(dec) * Math.sin(LAT) + Math.cos(dec) * Math.cos(H) * Math.cos(LAT);
  return [east, up, -north];
}
const declination = (day) => (23.44 * Math.PI / 180) * Math.sin((2 * Math.PI * (284 + day + 1)) / 365);

export class Climate {
  constructor() {
    this.clock = 'live';
    this.season = 'live';
    this.days = Date.now() / DAY_MS;
    this.cycleDay = montrealDate(this.days).day;
    this.freshSnow = 0;    // snow fallen lately, over the normal cover (melts above 0 °C)
    this.update(0);
  }

  setClock(mode) {
    if (mode === 'live') this.days = Date.now() / DAY_MS;
    this.clock = mode;
  }
  setSeason(mode) {
    if (mode === 'cycle') this.cycleDay = this.seasonDay;
    this.season = mode;
  }
  // Move the clock by hours (the , and . keys): it then runs at real speed from there.
  shift(hours) {
    this.days += hours / 24;
    if (this.clock === 'live') this.clock = 'set';
  }

  update(dt) {
    const rate = CLOCKS[this.clock].rate;
    if (this.clock === 'live') this.days = Date.now() / DAY_MS;
    else this.days += (dt * rate) / 86400;
    const local = montrealDate(this.days);
    this.local = local;
    if (this.season === 'cycle') this.cycleDay = (this.cycleDay + (dt * 365) / CYCLE_SECONDS) % 365;
    const day = this.season === 'live' ? local.day : this.season === 'cycle' ? this.cycleDay : SEASONS[this.season].day;
    this.seasonDay = day;

    // The sun: solar time from UTC, the longitude and the equation of time.
    const B = (2 * Math.PI * (day - 80)) / 364;
    const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // minutes
    const utcMin = (((this.days % 1) + 1) % 1) * 1440;
    const solar = utcMin + 4 * LON + eot;
    const H = ((solar / 60 - 12) * 15 * Math.PI) / 180;
    const dec = declination(day);
    this.sun = skyDir(dec, H);
    // The moon: about 12.2° a day behind the sun, on the ecliptic.
    const age = ((((this.days - NEW_MOON) % LUNATION) + LUNATION) % LUNATION);
    this.moonAge = age;
    const lag = (age / LUNATION) * 2 * Math.PI;
    this.moon = skyDir(declination(day + (age / LUNATION) * 365.25), H - lag);
    this.moonPhase = (1 - Math.cos(lag)) / 2; // lit share: 0 new, 1 full

    // Weather: slow noise (fronts, ~half a day) and faster (showers, hours).
    const w = this.days;
    const month = day / 30.44;
    const at = (table) => {
      const m = month - 0.5, i = Math.floor(m), f = m - i;
      const a = table[((i % 12) + 12) % 12], b = table[(((i + 1) % 12) + 12) % 12];
      return a + (b - a) * f;
    };
    const bias = at(CLOUDY) - 0.5;
    const slow = noiseC(w * 2.1 + 3.7), quick = noiseC(w * 7.3 + 11.1), swing = noiseC(w * 0.9 + 41.3);
    const wet = slow * 0.72 + quick * 0.28 + bias * 0.55;
    this.cloud = clampC(smoothC(0.3, 0.72, wet + bias * 0.2), 0, 1);
    const precip = smoothC(0.66, 0.84, wet);
    // Temperature: the season's normal, warmest at 3 pm, flattened by cloud, plus a few days' swing.
    const amp = 3.5 + 1.8 * Math.sin((2 * Math.PI * (day - 100)) / 365);
    const daily = Math.sin((2 * Math.PI * (local.minutes / 1440 - 9 / 24)));
    this.temp = at(TEMPS) + amp * daily * (1 - 0.6 * this.cloud) + (swing - 0.5) * 9;
    this.snowing = this.temp < 1 ? precip : 0;
    this.raining = this.temp < 1 ? 0 : precip;
    this.precip = precip;

    // Snow on the ground: the season's normal cover, plus what fell lately.
    const hours = (dt * rate) / 3600;
    this.freshSnow = clampC(this.freshSnow + this.snowing * hours * 0.25 - Math.max(0, this.temp) * hours * 0.03 - this.raining * hours * 0.2, 0, 1);
    this.snow = clampC(cyc(SNOW_KEYS, day) + this.freshSnow, 0, 1);
    // Wet roads: rain, or slush when snow is falling or melting.
    this.wet = clampC(Math.max(this.raining, this.snowing * 0.6, this.snow * smoothC(0, 6, this.temp) * 0.8), 0, 1);
    this.leaf = cyc(LEAF_KEYS, day);
    this.autumn = cyc(AUTUMN_KEYS, day);
    this.fresh = cyc(FRESH_KEYS, day);
    this.grass = cyc(GRASS_KEYS, day);

    this.light();
  }

  // Colors of the sky, the light and the haze for the sun and weather now.
  light() {
    const sy = this.sun[1], cloud = this.cloud;
    const day = smoothC(-0.14, 0.22, sy);
    const dusk = Math.exp(-(((sy - 0.02) / 0.13) ** 2)) * (1 - 0.75 * cloud);
    let horizon = mixC(NIGHT_HORIZON, DAY_HORIZON, day);
    let zenith = mixC(NIGHT_ZENITH, DAY_ZENITH, day);
    horizon = mixC(horizon, DUSK_HORIZON, dusk * 0.75);
    zenith = mixC(zenith, DUSK_ZENITH, dusk * 0.35);
    // Grey skies: lighter than night by the city's orange glow on the clouds.
    const grey = mixC([0.16, 0.13, 0.13], GREY, day);
    horizon = mixC(horizon, grey, cloud * 0.82);
    zenith = mixC(zenith, scaleC(grey, 0.92), cloud * 0.88);
    if (this.snowing) horizon = mixC(horizon, scaleC(grey, 1.05), this.snowing * 0.5);
    this.horizon = horizon;
    this.zenith = zenith;
    this.glow = scaleC([1.0, 0.45, 0.18], dusk * 0.9);

    // The key light: the sun, or the moon at night.
    const sunUp = smoothC(-0.04, 0.08, sy);
    const warm = smoothC(0.0, 0.42, sy);
    const sunCol = scaleC(mixC([1.0, 0.48, 0.22], [1.0, 0.96, 0.88], warm), sunUp * (1 - 0.82 * cloud));
    const moonY = this.moon[1];
    const moonI = 0.16 * (0.25 + 0.75 * this.moonPhase) * smoothC(-0.02, 0.12, moonY) * (1 - 0.85 * cloud) * (1 - sunUp);
    if (sunCol[1] >= moonI) { this.key = normC(this.sun); this.keyCol = sunCol; }
    else { this.key = normC(this.moon); this.keyCol = scaleC([0.62, 0.72, 1.0], moonI); }
    // Never quite from below the ground: shading and shadows want it above.
    if (this.key[1] < 0.05) this.key = normC([this.key[0], 0.05, this.key[2]]);
    this.keyStrength = clampC(Math.max(...this.keyCol), 0, 1);
    this.sunDisc = scaleC(mixC([1.0, 0.55, 0.25], [1.0, 0.95, 0.8], warm), smoothC(-0.03, 0.02, sy) * (1 - 0.9 * cloud));

    const light = smoothC(-0.16, 0.25, sy);
    const skyAmb = mixC([0.35, 0.38, 0.43], [0.46, 0.47, 0.5], cloud);
    const nightAmb = [0.045, 0.045, 0.07];
    this.amb = mixC(nightAmb, skyAmb, light);
    const groundAmb = mixC([0.27, 0.29, 0.26], [0.45, 0.46, 0.5], this.snow * 0.7);
    this.ambGround = mixC(scaleC(nightAmb, 0.8), groundAmb, light);
    this.groundEnv = scaleC(mixC([0.2, 0.26, 0.18], [0.75, 0.77, 0.8], this.snow * 0.8), 0.08 + 0.92 * light);
    this.night = 1 - smoothC(-0.1, 0.04, sy);
    // Headlights on from dusk, and in heavy snow or rain.
    this.headlights = sy < 0.06 || this.precip > 0.55 || (cloud > 0.9 && sy < 0.15);
    // Haze: closer in falling snow, a little in rain.
    const near = 120 - 80 * this.snowing - 40 * this.raining;
    const far = 750 - 520 * this.snowing - 330 * this.raining - 120 * cloud;
    this.fog = [Math.max(25, near), Math.max(170, far)];
  }

  // What the tires feel on a surface: slush and wet asphalt, snow on the grass.
  grip(surface) {
    if (surface === 'road' || surface === 'sidewalk') {
      return 1 - 0.32 * Math.max(this.snowing, this.snow * 0.55) - 0.1 * this.raining;
    }
    return 1 - 0.3 * this.snow - 0.1 * this.raining;
  }

  // 14:32, Tue 24 Nov, −2 °C, Light snow.
  get time() {
    const m = Math.floor(this.local.minutes);
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  }
  get date() {
    const d = Math.floor(this.seasonDay);
    let mo = 0;
    while (mo < 11 && d >= MONTH_START[mo + 1]) mo++;
    return `${d - MONTH_START[mo] + 1} ${MONTHS[mo]}`;
  }
  get conditions() {
    const t = Math.round(this.temp);
    const sky = this.snowing > 0.6 ? 'Snow' : this.snowing > 0.05 ? 'Light snow' : this.raining > 0.6 ? 'Rain' : this.raining > 0.05 ? 'Drizzle'
      : this.cloud > 0.75 ? 'Overcast' : this.cloud > 0.35 ? 'Cloudy' : this.sun[1] > 0 ? 'Sunny' : 'Clear';
    return `${t < 0 ? '−' : ''}${Math.abs(t)} °C · ${sky}`;
  }
}
