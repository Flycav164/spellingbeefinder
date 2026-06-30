// generate-answer-page.js
// Fetches today's Spelling Bee answers from nytbee.com HTML page
// Runs daily at 5:05am UTC via GitHub Actions

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

function getDateStrings() {
  // Accept optional date override: node generate-answer-page.js 2026-06-13
  // Falls back to today if no argument given.
  const override = process.argv[2];
  let now;
  if (override && /^\d{4}-\d{2}-\d{2}$/.test(override)) {
    const [y, m, d] = override.split('-').map(Number);
    now = new Date(y, m - 1, d);
    console.log(`Using date override: ${override}`);
  } else {
    now = new Date();
  }
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const iso = `${yyyy}-${mm}-${dd}`;
  const compact = `${yyyy}${mm}${dd}`;
  const monthNames = ['January','February','March','April','May','June',
    'July','August','September','October','November','December'];
  const month = monthNames[now.getMonth()];
  const day = now.getDate();
  const year = now.getFullYear();
  const friendly = `${month} ${day}, ${year}`;
  const slug = `spelling-bee-${month.toLowerCase()}-${String(day).padStart(2,'0')}-${year}`;
  const filename = `${slug}.html`;
  return { iso, compact, friendly, month, day, year, slug, filename, mm, dd };
}

function wordPoints(word, allLetters) {
  const isPangram = allLetters.every(l => word.toUpperCase().includes(l.toUpperCase()));
  const pts = word.length === 4 ? 1 : word.length;
  return { pts: isPangram ? pts + 7 : pts, isPangram };
}

// Native https GET — handles redirects, no compression issues
function fetchUrl(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const lib = parsedUrl.protocol === 'https:' ? https : http;
    const options = {
      hostname: parsedUrl.hostname,
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Encoding': 'identity',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Connection': 'close'
      }
    };

    const req = lib.request(options, (res) => {
      // Follow redirects (up to 5)
      if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307 || res.statusCode === 308) && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `${parsedUrl.protocol}//${parsedUrl.hostname}${res.headers.location}`;
        fetchUrl(redirectUrl, timeoutMs).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.end();
  });
}

// Fetch from nytbee.com HTML page
async function fetchFromNytBee(compact) {
  const url = `https://nytbee.com/Bee_${compact}.html`;
  console.log(`Fetching: ${url}`);
  const html = await fetchUrl(url, 25000);

  if (!html || html.length < 500) throw new Error('Response too short — likely blocked or empty');

  // CRITICAL DATE-VALIDATION GUARD
  // nytbee.com embeds the exact requested date in its puzzle board image
  // filename (pics/YYYYMMDD.png). If a redirect, cache collision, or
  // upstream quirk serves us a DIFFERENT date's page, this image filename
  // will not match, and we must reject the response rather than silently
  // writing the wrong date's content under this date's filename.
  const dateAnchor = new RegExp(`pics/${compact}\\.png`, 'i');
  if (!dateAnchor.test(html)) {
    throw new Error(`Date mismatch — fetched page does not contain expected board image pics/${compact}.png (likely served wrong date)`);
  }

  let words = [];

  // Method 1: plain text dash-list pattern — nytbee renders "- word" lines
  const dashMatches = html.match(/^-\s+([a-z]+)\s*$/gim);
  if (dashMatches && dashMatches.length >= 5) {
    words = [...new Set(
      dashMatches
        .map(m => m.replace(/^-\s+/, '').trim().toUpperCase())
        .filter(w => w.length >= 4 && /^[A-Z]+$/.test(w))
    )];
    console.log(`Method 1 (dash-list): ${words.length} words`);
  }

  // Method 2: <li> tags
  if (words.length < 5) {
    const liMatches = html.match(/<li[^>]*>\s*(?:<[^>]+>)*([a-z]+)(?:<[^>]+>)*\s*<\/li>/gi);
    if (liMatches && liMatches.length >= 5) {
      words = [...new Set(
        liMatches
          .map(m => m.replace(/<[^>]+>/g, '').trim().toUpperCase())
          .filter(w => w.length >= 4 && /^[A-Z]+$/.test(w))
      )];
      console.log(`Method 2 (<li> tags): ${words.length} words`);
    }
  }

  // Method 3: look for the official answers block — nytbee lists them
  // after "The official answers for today's puzzle are:"
  // FIX: must stop BEFORE the "Words not in official answer list" /
  // "not in today's official answers" section, or this regex bleeds into
  // the non-official word list and inflates the count with words nytbee
  // explicitly says are NOT valid answers (e.g. CALCIFIC, FUNICULI).
  if (words.length < 5) {
    const blockMatch = html.match(/official answers[^]*?(?=Words not in official|not in today's official answers|valid dictionary words|\n\n|\r\n\r\n|<\/)/i);
    if (blockMatch) {
      const block = blockMatch[0];
      const found = block.match(/\b([a-z]{4,})\b/g);
      if (found) {
        words = [...new Set(found.map(w => w.toUpperCase()))];
        console.log(`Method 3 (answers block): ${words.length} words`);
      }
    }
  }

  if (words.length < 5) throw new Error(`Could not parse word list (found ${words.length})`);

  // Pangram: marked as ==**word**== in nytbee markdown output
  const pangramMatch = html.match(/==\*\*([a-z]+)\*\*==/i) ||
                       html.match(/\*\*([a-z]{7,})\*\*/i) ||
                       html.match(/class="pangram[^"]*">([a-z]+)</i) ||
                       html.match(/<strong>([a-z]{7,})<\/strong>/i);
  const pangram = pangramMatch ? pangramMatch[1].toUpperCase() : '';

  // Stats
  const maxMatch = html.match(/Maximum Puzzle Score:\s*(\d+)/i);
  const geniusMatch = html.match(/Points Needed for Genius:\s*(\d+)/i);
  const maxScore = maxMatch ? parseInt(maxMatch[1]) : 0;
  const geniusScore = geniusMatch ? parseInt(geniusMatch[1]) : Math.ceil(maxScore * 0.7);

  const allLetters = pangram ? [...new Set(pangram.split(''))] : [];

  // Filter to only words sharing letters with the pangram set
  const validWords = allLetters.length
    ? words.filter(w => allLetters.some(l => w.includes(l)))
    : words;

  // Center letter: appears in every valid word
  let centerLetter = '';
  if (pangram) {
    for (const ch of allLetters) {
      if (validWords.every(w => w.includes(ch))) {
        centerLetter = ch;
        break;
      }
    }
  }

  console.log(`Parsed: ${validWords.length} words, pangram: ${pangram}, center: ${centerLetter}`);

  return {
    centerLetter,
    allLetters,
    words: validWords.sort((a,b) => b.length - a.length || a.localeCompare(b)),
    pangrams: pangram ? [pangram] : [],
    maxScore,
    geniusScore,
    totalWords: validWords.length
  };
}

// Retry wrapper — 3 attempts with 10s/30s/60s backoff before giving up
// on nytbee.com entirely. Handles transient blocks/timeouts/blips without
// requiring a human to manually re-trigger the workflow.
async function fetchFromNytBeeWithRetry(dates, maxAttempts = 3) {
  const delays = [10000, 30000, 60000];
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      console.log(`nytbee.com fetch attempt ${attempt}/${maxAttempts} for ${dates.compact}`);
      const result = await fetchFromNytBee(dates.compact);
      return result;
    } catch (err) {
      lastErr = err;
      console.error(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt < maxAttempts) {
        const delay = delays[attempt - 1];
        console.log(`Waiting ${delay / 1000}s before retry...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

// Fallback: spellingbee-answers.com
async function fetchFallback(dates) {
  const url = `https://spellingbee-answers.com/`;
  console.log(`Trying fallback: ${url}`);
  const html = await fetchUrl(url, 25000);

  if (!html || html.length < 200) throw new Error('Fallback response too short');

  const wordMatches = html.match(/\b([a-z]{4,})\b/g);
  if (!wordMatches) throw new Error('Could not parse fallback');

  const words = [...new Set(wordMatches.map(w => w.toUpperCase()))].slice(0, 80);
  return {
    centerLetter: '',
    allLetters: [],
    words,
    pangrams: [],
    maxScore: 0,
    geniusScore: 0,
    totalWords: words.length
  };
}

function generateHtml(dates, answers) {
  const { friendly, month, day, year, slug, iso } = dates;
  const { centerLetter, allLetters, words, pangrams, maxScore, geniusScore, totalWords } = answers;
  const primaryPangram = pangrams[0] || '';
  const extraPangrams = pangrams.slice(1);

  // Group words by length
  const byLen = {};
  words.forEach(word => {
    const { pts, isPangram } = wordPoints(word, allLetters.length ? allLetters : []);
    if (!byLen[word.length]) byLen[word.length] = [];
    byLen[word.length].push({ word, pts, isPangram });
  });
  const lengths = Object.keys(byLen).map(Number).sort((a,b) => b - a);

  const wordSections = lengths.map(len => {
    const chips = byLen[len].map(({word, pts, isPangram}) =>
      `<div class="${isPangram ? 'wchip pangram' : 'wchip'}">${word}${isPangram ? ' \u2605' : ''} <span class="wpts">${pts}</span></div>`
    ).join('\n            ');
    return `
          <div class="length-group">
            <div class="length-label">${len} Letter${len !== 1 ? 's' : ''}</div>
            <div class="word-grid">${chips}</div>
          </div>`;
  }).join('\n');

  const prevDate = new Date(iso);
  prevDate.setDate(prevDate.getDate() - 1);
  const prevMonth = prevDate.toLocaleString('default',{month:'long'}).toLowerCase();
  const prevDay = String(prevDate.getDate()).padStart(2,'0');
  const prevYear = prevDate.getFullYear();
  const prevSlug = `spelling-bee-${prevMonth}-${prevDay}-${prevYear}`;

  const metaDesc = `All ${totalWords} NYT Spelling Bee answers for ${friendly}. Center letter ${centerLetter}, pangram: ${primaryPangram}. Full word list with point values. Free, no login.`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Spelling Bee ${friendly} Answers &mdash; All ${totalWords} Words</title>
<meta name="description" content="${metaDesc}">
<meta name="keywords" content="spelling bee ${month.toLowerCase()} ${day} ${year} answers, nyt spelling bee ${month.toLowerCase()} ${day} answers, spelling bee answers today, spelling bee ${month.toLowerCase()} ${day} pangram, spelling bee ${centerLetter.toLowerCase()} center, spelling bee pangram today, nyt spelling bee answers ${year}">
<meta name="robots" content="index, follow">
<link rel="canonical" href="https://www.spellingbeefinder.com/answers/${slug}.html">
<meta property="og:title" content="Spelling Bee ${friendly} Answers &mdash; All ${totalWords} Words">
<meta property="og:description" content="${metaDesc}">
<meta property="og:url" content="https://www.spellingbeefinder.com/answers/${slug}.html">
<meta property="og:type" content="website">
<meta property="og:image" content="https://www.spellingbeefinder.com/icon-512.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Spelling Bee ${friendly} Answers &mdash; All ${totalWords} Words">
<meta name="twitter:description" content="All ${totalWords} NYT Spelling Bee answers for ${friendly}. Pangram: ${primaryPangram}. Free, no login.">
<meta name="theme-color" content="#f59e0b">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="manifest" href="/manifest.json">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;600;700&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-4943534579898039" crossorigin="anonymous"></script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[{"@type":"Article","headline":"Spelling Bee ${friendly} Answers","datePublished":"${iso}","dateModified":"${iso}","author":{"@type":"Organization","name":"SpellingBeeFinder"},"publisher":{"@type":"Organization","name":"SpellingBeeFinder","url":"https://www.spellingbeefinder.com"},"description":"${metaDesc}"},{"@type":"FAQPage","mainEntity":[{"@type":"Question","name":"What is the Spelling Bee answer for ${friendly}?","acceptedAnswer":{"@type":"Answer","text":"The NYT Spelling Bee for ${friendly} has ${totalWords} valid words. The center letter is ${centerLetter} and the pangram is ${primaryPangram}. Maximum score is ${maxScore} points. Genius requires ${geniusScore} points."}},{"@type":"Question","name":"What is the Spelling Bee pangram for ${friendly}?","acceptedAnswer":{"@type":"Answer","text":"The pangram for ${friendly} is ${primaryPangram}. It uses all 7 letters at least once and is worth ${primaryPangram.length + 7} points total."}},{"@type":"Question","name":"How many words in Spelling Bee ${friendly}?","acceptedAnswer":{"@type":"Answer","text":"The NYT Spelling Bee for ${friendly} has ${totalWords} valid words. Maximum score is ${maxScore} points and Genius requires ${geniusScore} points. Center letter is ${centerLetter}."}},{"@type":"Question","name":"What is the Genius score for ${friendly}?","acceptedAnswer":{"@type":"Answer","text":"The Genius threshold for ${friendly} is ${geniusScore} points, which is 70% of the maximum ${maxScore}. Queen Bee requires all ${totalWords} words for the full ${maxScore} points."}},{"@type":"Question","name":"What are the letters in Spelling Bee ${friendly}?","acceptedAnswer":{"@type":"Answer","text":"The letters for ${friendly} are ${allLetters.join(', ')}. Center letter is ${centerLetter} which must appear in every valid word."}}]}]}
</script>
<style>
:root{--amber:#b45309;--bee:#f59e0b;--cream-border:#fde68a;--s900:#0f172a;--s800:#1e293b;--s700:#334155;--s600:#475569;--s500:#64748b;--s200:#e2e8f0;--s100:#f1f5f9;--s50:#f8fafc;--green:#059669;--wh:#ffffff;}
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'DM Sans',system-ui,sans-serif;font-size:16px;line-height:1.6;background:#f1f5f9;color:var(--s800);}
nav{position:sticky;top:0;z-index:200;background:rgba(248,250,252,.96);backdrop-filter:blur(16px);border-bottom:2px solid var(--cream-border);height:56px;display:flex;align-items:center;padding:0 20px;}
.nav-inner{max-width:1100px;width:100%;margin:0 auto;display:flex;align-items:center;just
