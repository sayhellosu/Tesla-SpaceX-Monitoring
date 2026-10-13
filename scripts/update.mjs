// Runs in GitHub Actions after each US close. Fetches earnings dates, SEC filings,
// news headlines and daily prices, and writes data/feed.json for the dashboard.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const SEC_UA = process.env.SEC_UA || 'tsla-spcx-dashboard contact@example.com';
const COS = { TSLA: '0001318605', SPCX: '0001181412' };
const NEWS_QUERIES = ['Tesla SpaceX merger', 'SpaceX SPCX lock-up', 'SpaceX SPCX earnings', 'Tesla TSLA earnings'];
const FORMS = new Set(['8-K', '8-K/A', '10-Q', '10-K', 'S-1', 'S-3', 'S-4', 'S-8', '424B3', '424B4', '424B5', '425', 'DEF 14A', 'DEFA14A', 'SC 13D', 'SC 13D/A', 'SC TO-T', 'SC 14D9', 'PREM14A']);
const ITEMS = { '1.01': 'Material agreement', '1.02': 'Agreement terminated', '2.01': 'Acquisition completed', '2.02': 'Results of operations', '2.03': 'New debt', '3.02': 'Unregistered share sale', '5.02': 'Officer/director change', '5.07': 'Shareholder vote', '7.01': 'Reg FD disclosure', '8.01': 'Other events' };

const etDate = ms => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const qKey = d => { const y = +d.slice(0, 4), m = +d.slice(5, 7); return m <= 3 ? `Q4-${y - 1}` : m <= 6 ? `Q1-${y}` : m <= 9 ? `Q2-${y}` : `Q3-${y}`; };
async function get(url, headers = {}) { const r = await fetch(url, { headers: { 'User-Agent': BROWSER, ...headers } }); if (!r.ok) throw new Error(`${r.status} ${url}`); return r; }

async function yahooAuth() {
  try {
    const r = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': BROWSER }, redirect: 'manual' });
    const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
    const crumb = await (await get('https://query2.finance.yahoo.com/v1/test/getcrumb', { cookie })).text();
    return { cookie, crumb };
  } catch (e) { console.warn('yahoo auth', e.message); return null; }
}

async function earnings(sym, auth) {
  if (auth) {
    try {
      const j = await (await get(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=calendarEvents&crumb=${encodeURIComponent(auth.crumb)}`, { cookie: auth.cookie })).json();
      const e = j.quoteSummary.result[0].calendarEvents.earnings;
      const t = e.earningsDate && e.earningsDate[0] && e.earningsDate[0].raw;
      if (t) return { date: etDate(t * 1000), estimate: !!e.isEarningsDateEstimate, src: 'Yahoo Finance' };
    } catch (e) { console.warn('yahoo earnings', sym, e.message); }
  }
  try {
    const j = await (await get(`https://api.nasdaq.com/api/analyst/${sym}/earnings-date`, { accept: 'application/json' })).json();
    const txt = (j.data && j.data.announcement) || '';
    const m = txt.match(/([A-Z][a-z]{2,8} \d{1,2}, \d{4})/);
    if (m) return { date: new Date(m[1] + ' 12:00 UTC').toISOString().slice(0, 10), estimate: /estimat/i.test(txt), src: 'Nasdaq' };
  } catch (e) { console.warn('nasdaq earnings', sym, e.message); }
  return null;
}

async function prices(sym) {
  const p1 = Math.floor(Date.UTC(2026, 5, 8) / 1000), p2 = Math.floor(Date.now() / 1000) + 86400;
  const j = await (await get(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1d`)).json();
  const r = j.chart.result[0], q = r.indicators.quote[0];
  return r.timestamp.map((ts, i) => ({ date: etDate(ts * 1000), close: q.close[i] && +q.close[i].toFixed(2), high: q.high[i] && +q.high[i].toFixed(2) })).filter(x => x.close);
}

async function filings(sym) {
  const cik = COS[sym];
  const j = await (await get(`https://data.sec.gov/submissions/CIK${cik}.json`, { 'User-Agent': SEC_UA })).json();
  const f = j.filings.recent, out = [];
  for (let i = 0; i < f.form.length && out.length < 15; i++) {
    if (!FORMS.has(f.form[i])) continue;
    const acc = f.accessionNumber[i].replace(/-/g, '');
    const items = (f.items && f.items[i] || '').split(',').map(s => ITEMS[s.trim()]).filter(Boolean).join(', ');
    out.push({ co: sym === 'SPCX' ? 'SpaceX' : 'Tesla', form: f.form[i], date: f.filingDate[i], desc: f.primaryDocDescription[i] || '', items, url: `https://www.sec.gov/Archives/edgar/data/${parseInt(cik, 10)}/${acc}/${f.primaryDocument[i]}` });
  }
  return out;
}

const decode = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function news(q) {
  const xml = await (await get(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}+when:14d&hl=en-US&gl=US&ceid=US:en`)).text();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => {
    const g = t => { const x = m[1].match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)); return x ? decode(x[1]).trim() : ''; };
    const source = g('source');
    return { title: g('title').replace(new RegExp(` - ${source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), ''), url: g('link'), source, date: new Date(g('pubDate')).toISOString(), q };
  });
}

const prev = await readFile('data/feed.json', 'utf8').then(JSON.parse).catch(() => ({}));
const feed = { updated: new Date().toISOString(), earnings: prev.earnings || { TSLA: {}, SPCX: {} }, filings: prev.filings || [], news: prev.news || [], prices: prev.prices || {} };

const auth = await yahooAuth();
for (const sym of ['TSLA', 'SPCX']) {
  const e = await earnings(sym, auth);
  if (e) { feed.earnings[sym] = feed.earnings[sym] || {}; const k = qKey(e.date); const old = feed.earnings[sym][k]; if (!old || old.estimate || !e.estimate) feed.earnings[sym][k] = e; }
  try { feed.prices[sym] = await prices(sym); } catch (err) { console.warn('prices', sym, err.message); }
}
try { feed.filings = [...await filings('SPCX'), ...await filings('TSLA')].sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 20); } catch (e) { console.warn('sec', e.message); }
try {
  const all = (await Promise.all(NEWS_QUERIES.map(q => news(q).catch(() => [])))).flat();
  const seen = new Set();
  const fresh = all.filter(x => { const k = x.title.toLowerCase().slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; }).sort((a, b) => a.date < b.date ? 1 : -1).slice(0, 25);
  if (fresh.length) feed.news = fresh;
} catch (e) { console.warn('news', e.message); }

await mkdir('data', { recursive: true });
await writeFile('data/feed.json', JSON.stringify(feed, null, 1));
console.log('feed written', { earnings: feed.earnings, filings: feed.filings.length, news: feed.news.length, tsla: (feed.prices.TSLA || []).length, spcx: (feed.prices.SPCX || []).length });
