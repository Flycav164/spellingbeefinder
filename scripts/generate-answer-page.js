// generate-answer-page.js
// Fetches Spelling Bee answers from nytbee.com HTML page
// Runs daily at 5:05am UTC via GitHub Actions, or manually via workflow_dispatch with a date override

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

// Derive the letter set, center letter, and pangram(s) ANALYTICALLY from the
// clean word list, rather than pattern-matching presentation markup.
// By the actual rules of Spelling Bee: every valid word is composed only of
// letters from the puzzle's 7-letter set, and the center letter appears in
// every valid word. This is deterministic and does not depend on nytbee's
// HTML/CSS markup conventions.
function deriveLetterSetAndCenter(words) {
  if (!words || words.length < 5) {
    return { ok: false, reason: `Too few words to derive letter set (${words ? words.length : 0})` };
  }
  const union = new Set();
  words.forEach(w => w.split('').forEach(ch => union.add(ch)));
  const unionArr = [...union].sort();

  if (unionArr.length !== 7) {
    return { ok: false, reason: `Letter union size ${unionArr.length} (expected exactly 7) — word list likely contaminated` };
  }

  let centerLetter = '';
  for (const ch of unionArr) {
    if (words.every(w => w.includes(ch))) {
      centerLetter = ch;
      break;
    }
  }
  if (!centerLetter) {
    return { ok: false, reason: 'No letter found common to every word — word list likely contaminated' };
  }

  const pangrams = words.filter(w => unionArr.every(ch => w.includes(ch)));
  if (pangrams.length === 0) {
    return { ok: false, reason: 'No pangram found in word list (no word uses all 7 letters)' };
  }

  return { ok: true, allLetters: unionArr, centerLetter, pangrams };
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

  // SCOPE FIRST, EXTRACT SECOND.
  // nytbee.com's page contains many <li> elements and word-like tokens
  // OUTSIDE the actual answer list — site nav, "Other days with this
  // pangram" links, the "Words not in official answer list" section, the
  // first-letter frequency chart, etc. Every extraction method below must
  // operate ONLY within the official-answers section, not the full page.
  let scopedHtml = html;
  const scopeStart = html.search(/official answers/i);
  if (scopeStart !== -1) {
    const afterStart = html.slice(scopeStart);
    const scopeEndMatch = afterStart.search(/Words not in official|not in today's official answers|valid dictionary words|Number of Pangrams/i);
    scopedHtml = scopeEndMatch !== -1 ? afterStart.slice(0, scopeEndMatch) : afterStart;
    console.log(`Scoped to official-answers section: ${scopedHtml.length} chars (full page: ${html.length} chars)`);
  } else {
    console.log('Warning: "official answers" anchor text not found — scanning full page (higher contamination risk)');
  }

  // Method 1: the answer word appears as plain text IMMEDIATELY BEFORE
  // its link-definition anchor (the anchor itself wraps only an arrow
  // glyph, e.g. "catch <a ... class=\"link-definition\">&#8599;</a>").
  // Confirmed working via diagnostic logging on 2026-06-15: this extracted
  // 60 real words successfully. The class match must allow EXTRA classes
  // alongside link-definition (not require an exact match) — the pangram
  // entry specifically carries an additional class for its highlighting
  // (e.g. class="link-definition pangram"), which an exact-match regex
  // silently skips, causing "no word uses all 7 letters" validation
  // failures even though the word list itself was otherwise correct.
  const beforeAnchorMatches = scopedHtml.match(/\b([a-z]{4,})\b\s*(?=<a[^>]*class="[^"]*\blink-definition\b[^"]*")/gi);
  if (beforeAnchorMatches && beforeAnchorMatches.length >= 5) {
    words = [...new Set(
      beforeAnchorMatches
        .map(m => m.trim().toUpperCase())
        .filter(w => w.length >= 4 && /^[A-Z]+$/.test(w))
    )];
    console.log(`Method 1 (word before link-definition anchor): ${words.length} words`);
  }

  // Method 2: word INSIDE the link-definition anchor (in case nytbee's
  // structure differs from what Method 1 assumes)
  if (words.length < 5) {
    const linkDefMatches = scopedHtml.match(/<a[^>]*class="[^"]*\blink-definition\b[^"]*"[^>]*>\s*(?:<[^>]+>)*([a-z]+)(?:<[^>]+>)*\s*<\/a>/gi);
    if (linkDefMatches && linkDefMatches.length >= 5) {
      words = [...new Set(
        linkDefMatches
          .map(m => {
            const inner = m.match(/>\s*(?:<[^>]+>)*([a-z]+)(?:<[^>]+>)*\s*<\/a>/i);
            return inner ? inner[1].toUpperCase() : '';
          })
          .filter(w => w.length >= 4 && /^[A-Z]+$/.test(w))
      )];
      console.log(`Method 2 (link-definition anchors, word inside): ${words.length} words`);
    }
  }

  // Method 3: plain text dash-list pattern (kept as fallback, in case
  // nytbee's markup changes in the future)
  if (words.length < 5) {
    const dashMatches = scopedHtml.match(/^-\s+([a-z]+)\s*$/gim);
    if (dashMatches && dashMatches.length >= 5) {
      words = [...new Set(
        dashMatches
          .map(m => m.replace(/^-\s+/, '').trim().toUpperCase())
          .filter(w => w.length >= 4 && /^[A-Z]+$/.test(w))
      )];
      console.log(`Method 3 (dash-list, scoped): ${words.length} words`);
    }
  }

  // Method 4: <li> tags, scoped to the official-answers section only
  if (words.length < 5) {
    const liMatches = scopedHtml.match(/<li[^>]*>\s*(?:<[^>]+>)*([a-z]+)(?:<[^>]+>)*\s*<\/li>/gi);
    if (liMatches && liMatches.length >= 5) {
      words = [...new Set(
        liMatches
          .map(m => m.replace(/<[^>]+>/g, '').trim().toUpperCase())
          .filter(w => w.length >= 4 && /^[A-Z]+$/.test(w))
      )];
      console.log(`Method 4 (<li> tags, scoped): ${words.length} words`);
    }
  }

  // Method 5: last-resort plain-word extraction from the same scoped
  // block. True last resort only — picks up HTML/JS noise words if the
  // above structural methods fail, so its results are least trustworthy.
  if (words.length < 5) {
    const found = scopedHtml.match(/\b([a-z]{4,})\b/g);
    if (found) {
      words = [...new Set(found.map(w => w.toUpperCase()))];
      console.log(`Method 5 (scoped plain-word scan): ${words.length} words`);
    }
  }

  if (words.length < 5) throw new Error(`Could not parse word list (found ${words.length})`);

  // Derive letter set, center letter, and pangram(s) analytically.
  // This doubles as contamination detection: if the word list has stray
  // words from elsewhere on the page, the letter union won't be exactly 7
  // and/or no common center letter will exist — both cause a clean throw
  // here, which the retry wrapper will catch and retry on a fresh fetch.
  const derived = deriveLetterSetAndCenter(words);
  if (!derived.ok) {
    throw new Error(`Word list validation failed: ${derived.reason}`);
  }
  const { allLetters, centerLetter, pangrams } = derived;

  // Every valid word must be composed ENTIRELY of letters from the 7-letter
  // set (not just contain at least one of them).
  const letterSet = new Set(allLetters);
  const validWords = words.filter(w => [...w].every(ch => letterSet.has(ch)));

  if (validWords.length !== words.length) {
    console.log(`Dropped ${words.length - validWords.length} word(s) containing letters outside the 7-letter set`);
  }

  // Stats
  const maxMatch = html.match(/Maximum Puzzle Score:\s*(\d+)/i);
  const geniusMatch = html.match(/Points Needed for Genius:\s*(\d+)/i);
  const maxScore = maxMatch ? parseInt(maxMatch[1]) : 0;
  const geniusScore = geniusMatch ? parseInt(geniusMatch[1]) : Math.ceil(maxScore * 0.7);

  // Real puzzles always score above 0 — a parsed 0 means the stats regex
  // failed to match, not that the puzzle genuinely scores zero.
  if (maxScore === 0) {
    throw new Error('Parsed maxScore is 0 — stats regex likely failed to match, treating as parse failure');
  }

  console.log(`Parsed: ${validWords.length} words, pangram(s): ${pangrams.join(', ')}, center: ${centerLetter}`);

  return {
    centerLetter,
    allLetters,
    words: validWords.sort((a,b) => b.length - a.length || a.localeCompare(b)),
    pangrams,
    maxScore,
    geniusScore,
    totalWords: validWords.length
  };
}

// Retry wrapper — 3 attempts with 10s/30s/60s backoff before giving up
// on nytbee.com entirely. Handles transient blocks/timeouts/blips AND
// transient parse/validation failures without requiring a human to
// manually re-trigger the workflow.
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
// IMPORTANT: this scrapes the homepage, which always shows TODAY's puzzle.
// It is therefore only ever safe to use on genuine same-day cron runs.
// main() enforces this by refusing to call this function when a date
// override was given — using it on a backfill run would silently write
// today's data under a past date's filename, recreating the exact
// cross-date corruption this fix is meant to eliminate.
async function fetchFallback(dates) {
  const url = `https://spellingbee-answers.com/`;
  console.log(`Trying fallback (today-only, same-day runs): ${url}`);
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
.nav-inner{max-width:1100px;width:100%;margin:0 auto;display:flex;align-items:center;justify-content:space-between;}
.nav-brand{display:flex;align-items:center;gap:10px;text-decoration:none;}
.nav-wordmark{font-family:'Bebas Neue',serif;font-size:22px;letter-spacing:2.5px;color:var(--s900);}
.nav-wordmark em{color:var(--amber);font-style:normal;}
.nav-links{display:flex;align-items:center;gap:2px;}
.nav-links a{font-size:13px;font-weight:500;color:var(--s600);text-decoration:none;padding:6px 11px;border-radius:8px;transition:all .15s;white-space:nowrap;}
.nav-links a:hover,.nav-links a.active{background:#fef3c7;color:var(--amber);font-weight:700;}
.nav-ham{display:none;background:none;border:none;cursor:pointer;padding:6px;color:var(--s600);}
.nav-ham svg{width:22px;height:22px;}
.page{max-width:860px;margin:0 auto;padding:36px 20px 80px;}
.breadcrumb{font-size:13px;color:var(--s500);margin-bottom:24px;}
.breadcrumb a{color:var(--s500);text-decoration:none;}
.breadcrumb a:hover{color:var(--amber);}
.date-hero{display:flex;align-items:flex-start;gap:20px;margin-bottom:28px;}
.date-badge{width:68px;height:74px;background:linear-gradient(135deg,var(--bee),#d97706);border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;flex-shrink:0;}
.date-badge-month{font-family:'DM Mono',monospace;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;}
.date-badge-day{font-family:'Bebas Neue',serif;font-size:38px;line-height:1;}
.date-badge-year{font-family:'DM Mono',monospace;font-size:11px;opacity:.8;}
.date-hero-text h1{font-family:'Bebas Neue',serif;font-size:clamp(24px,4vw,40px);letter-spacing:1.5px;color:var(--s900);line-height:1.05;margin-bottom:6px;}
.date-hero-text p{font-size:15px;color:var(--s600);line-height:1.6;}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:28px;}
.stat-card{background:var(--wh);border:1.5px solid var(--cream-border);border-radius:12px;padding:14px 10px;text-align:center;}
.stat-val{font-family:'Bebas Neue',serif;font-size:30px;color:var(--bee);line-height:1;}
.stat-lbl{font-size:13px;color:var(--s500);font-weight:600;text-transform:uppercase;letter-spacing:.5px;margin-top:2px;}
.pangram-card{background:#fffbeb;border:2px solid var(--bee);border-radius:14px;padding:20px 22px;margin-bottom:28px;display:flex;align-items:center;gap:16px;}
.pangram-label{font-family:'DM Mono',monospace;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--amber);margin-bottom:4px;}
.pangram-word{font-family:'Bebas Neue',serif;font-size:clamp(24px,4vw,36px);color:var(--s900);letter-spacing:2px;}
.pangram-info{font-size:13px;color:var(--s600);margin-top:4px;}
.section-title{font-family:'Bebas Neue',serif;font-size:clamp(20px,3vw,26px);letter-spacing:1.5px;color:var(--s900);margin-bottom:16px;padding-bottom:8px;border-bottom:2px solid var(--cream-border);}
.word-sections{margin-bottom:36px;}
.length-group{margin-bottom:20px;}
.length-label{font-family:'DM Mono',monospace;font-size:13px;font-weight:700;letter-spacing:1px;color:var(--s500);text-transform:uppercase;background:var(--s100);padding:3px 10px;border-radius:6px;display:inline-block;margin-bottom:10px;}
.word-grid{display:flex;flex-wrap:wrap;gap:8px;}
.wchip{padding:7px 13px;border:1px solid var(--s200);border-radius:9px;background:var(--wh);font-size:13px;font-weight:600;color:var(--s700);display:flex;align-items:center;gap:6px;}
.wchip.pangram{background:#fef3c7;border-color:var(--bee);color:var(--amber);}
.wpts{font-family:'DM Mono',monospace;font-size:13px;font-weight:700;color:var(--s500);background:var(--s100);border-radius:4px;padding:1px 5px;}
.wchip.pangram .wpts{color:var(--amber);background:rgba(245,158,11,.12);}
.nav-dates{display:flex;justify-content:space-between;align-items:center;margin-bottom:36px;gap:12px;}
.nav-dates-bottom{display:flex;justify-content:space-between;align-items:center;margin:40px 0 16px;gap:12px;}
.nav-date-btn{flex:1;padding:11px 16px;background:var(--wh);border:1.5px solid var(--s200);border-radius:11px;text-decoration:none;font-size:14px;font-weight:600;color:var(--s700);text-align:center;transition:all .15s;}
.nav-date-btn:hover{border-color:var(--bee);color:var(--amber);}
.nav-date-btn.today{background:var(--bee);border-color:var(--bee);color:#fff;}
.mobile-nav-bar{display:none;position:fixed;bottom:0;left:0;right:0;z-index:300;background:rgba(255,255,255,.97);backdrop-filter:blur(12px);border-top:2px solid var(--cream-border);padding:10px 16px 14px;gap:8px;}
.mobile-nav-bar a{flex:1;display:flex;align-items:center;justify-content:center;gap:6px;padding:11px 8px;border-radius:10px;font-size:13px;font-weight:700;text-decoration:none;transition:all .15s;}
.mnb-prev,.mnb-next{background:var(--s100);color:var(--s700);border:1.5px solid var(--s200);}
.mnb-archive{background:var(--bee);color:#fff;border:1.5px solid var(--bee);flex:1.4;}
.mnb-prev:hover,.mnb-next:hover{border-color:var(--bee);color:var(--amber);background:#fef3c7;}
.cta-card{background:linear-gradient(135deg,var(--bee),#d97706);border-radius:14px;padding:24px 28px;margin:32px 0;display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;}
.cta-card h3{font-family:'Bebas Neue',serif;font-size:24px;letter-spacing:1px;color:#fff;margin-bottom:4px;}
.cta-card p{font-size:14px;color:rgba(255,255,255,.88);}
.cta-btn{background:#fff;color:var(--amber);font-family:'Bebas Neue',serif;font-size:17px;letter-spacing:1px;padding:12px 22px;border-radius:10px;text-decoration:none;white-space:nowrap;flex-shrink:0;}
.faq-section{margin:40px 0;}
.faq-item{border-bottom:1px solid var(--cream-border);padding:13px 0;}
.faq-q{width:100%;text-align:left;background:none;border:none;display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer;font-family:'DM Sans',sans-serif;font-size:16px;font-weight:700;color:var(--s800);padding:0;}
.faq-chev{color:var(--s400);font-size:20px;flex-shrink:0;transition:transform .18s;}
.faq-chev.open{transform:rotate(180deg);}
.faq-a{font-size:15px;color:var(--s600);line-height:1.75;margin-top:10px;padding-right:20px;display:none;}
.faq-a.open{display:block;}
.ad-wrap{margin:32px 0;text-align:center;}
.ad-slot-label{font-family:'DM Mono',monospace;font-size:13px;color:var(--s500);margin-bottom:4px;}
ins.adsbygoogle[data-ad-status="unfilled"]{display:none!important;}
.share-strip{display:flex;align-items:center;gap:10px;margin:36px 0 48px;padding:13px 18px;background:var(--wh);border:1px solid var(--s200);border-radius:14px;}
.share-strip-lbl{font-family:'DM Mono',monospace;font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:var(--s500);white-space:nowrap;flex-shrink:0;}
.share-btns{display:flex;gap:7px;flex-wrap:wrap;flex:1;}
.sbn{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;text-decoration:none;transition:transform .12s;border:none;flex-shrink:0;}
.sbn:hover{transform:scale(1.12);}
.sbn-native{background:#f59e0b;color:#fff;}
.sbn-copy{background:var(--s200);color:var(--s700);}
.sbn-fb{background:#1877f2;color:#fff;}
.sbn-tw{background:#000;color:#fff;}
.sbn-li{background:#0a66c2;color:#fff;}
.sbn-wa{background:#25d366;color:#fff;}
.sbn-em{background:var(--s300,#cbd5e1);color:var(--s700);}
footer{background:#fff;color:var(--s700);border-top:2px solid #e2e8f0;padding:40px 20px 28px;margin-top:56px;}
.foot-inner{max-width:1100px;margin:0 auto;display:flex;flex-wrap:wrap;gap:28px;justify-content:space-between;margin-bottom:24px;}
.foot-col{display:flex;flex-direction:column;gap:8px;min-width:140px;}
.foot-col h4{font-size:13px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:1.5px;margin-bottom:6px;font-family:'DM Mono',monospace;}
.foot-col a{font-size:14px;color:#475569;text-decoration:none;line-height:1.9;}
.foot-col a:hover{color:#0f172a;}
.foot-col p{font-size:14px;color:#64748b;line-height:1.6;margin:0;}
.foot-bottom{max-width:1100px;margin:0 auto;padding:16px 0 0;border-top:1px solid #e2e8f0;font-size:13px;color:#64748b;line-height:1.6;}
.foot-brand-name{font-family:'Bebas Neue',serif;font-size:19px;letter-spacing:2px;color:#0f172a;}
.foot-brand-name em{color:var(--amber);font-style:normal;}
@media(max-width:768px){
  body{background:#f1f5f9;}
  footer{background:#fff;border-top:2px solid #e2e8f0;padding:28px 16px 20px;margin-top:32px;}
  .foot-inner{flex-direction:column;gap:16px;}
  .foot-col{min-width:unset;width:100%;}
  nav{background:rgba(248,250,252,.98);}
  .nav-links{display:none;position:absolute;top:56px;left:0;right:0;background:#fff;flex-direction:column;padding:8px 12px 12px;gap:2px;border-bottom:1px solid var(--s200);box-shadow:0 4px 16px rgba(0,0,0,.08);z-index:199;}
  .nav-links.open{display:flex;}
  .nav-ham{display:flex;}
  .nav-links a{font-size:14px;padding:11px 14px;border-radius:9px;color:var(--s800);}
  .stats-row{grid-template-columns:1fr 1fr;}
  .page{padding:20px 14px 60px;}
  .cta-card{flex-direction:column;}
  .share-strip{flex-wrap:wrap;}
  .word-grid{gap:6px;}
  .mobile-nav-bar{display:flex;}
  body{padding-bottom:72px;}
}
</style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a href="/index.html" class="nav-brand">
      <img src="bee-icon-nav.webp" alt="SpellingBeeFinder" width="32" height="32" style="object-fit:contain;display:block;flex-shrink:0;" loading="eager">
      <span class="nav-wordmark">Spelling<em>Bee</em>Finder</span>
    </a>
    <div class="nav-links" id="navLinks">
      <a href="/index.html">Solver</a>
      <a href="/answers.html" class="active">Daily Answers</a>
      <a href="/gear.html">Books &amp; Gear</a>
    </div>
    <button class="nav-ham" id="navHam" aria-label="Open menu">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" aria-hidden="true"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
  </div>
</nav>
<div class="page">
  <div class="breadcrumb"><a href="/index.html">Home</a> &rsaquo; <a href="/answers.html">Daily Answers</a> &rsaquo; ${friendly}</div>
  <div class="date-hero">
    <div class="date-badge">
      <span class="date-badge-month">${month.slice(0,3).toUpperCase()}</span>
      <span class="date-badge-day">${day}</span>
      <span class="date-badge-year">${year}</span>
    </div>
    <div class="date-hero-text">
      <h1>Spelling Bee ${friendly} Answers</h1>
      <p>All ${totalWords} valid words for today&rsquo;s NYT Spelling Bee. Center letter: <strong>${centerLetter}</strong>.</p>
    </div>
  </div>
  <div class="stats-row">
    <div class="stat-card"><div class="stat-val">${totalWords}</div><div class="stat-lbl">Total Words</div></div>
    <div class="stat-card"><div class="stat-val">${maxScore}</div><div class="stat-lbl">Max Points</div></div>
    <div class="stat-card"><div class="stat-val">${geniusScore}</div><div class="stat-lbl">Genius Score</div></div>
    <div class="stat-card"><div class="stat-val">${centerLetter}</div><div class="stat-lbl">Center Letter</div></div>
  </div>
  ${primaryPangram ? `
  <div class="pangram-card">
    <span style="font-size:28px;flex-shrink:0;">\u2b50</span>
    <div>
      <div class="pangram-label">Today&rsquo;s Pangram</div>
      <div class="pangram-word">${primaryPangram}</div>
      <div class="pangram-info">Uses all 7 letters &mdash; worth ${primaryPangram.length + 7} points</div>
      ${extraPangrams.length ? `<div style="font-size:13px;color:var(--s600);margin-top:4px;">Also: ${extraPangrams.join(', ')}</div>` : ''}
    </div>
  </div>` : ''}
  <div class="ad-wrap">
    <div class="ad-slot-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-4943534579898039" data-ad-slot="9513724631" data-ad-format="auto" data-full-width-responsive="true"></ins>
    <script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>
  </div>
  <div class="section-title">All ${totalWords} Words &mdash; Sorted by Length</div>
  <div class="word-sections">${wordSections}</div>
  <div class="cta-card">
    <div><h3>Want to Find Words You Missed?</h3><p>Load today&rsquo;s letters into our free solver and search without spoilers.</p></div>
    <a href="/index.html" class="cta-btn">Open Solver &rarr;</a>
  </div>
  <div class="ad-wrap">
    <div class="ad-slot-label">Advertisement</div>
    <ins class="adsbygoogle" style="display:block" data-ad-client="ca-pub-4943534579898039" data-ad-slot="3907164419" data-ad-format="auto" data-full-width-responsive="true"></ins>
    <script>(adsbygoogle=window.adsbygoogle||[]).push({});</script>
  </div>
  <div class="nav-dates">
    <a href="/answers/${prevSlug}.html" class="nav-date-btn">&larr; Previous Puzzle</a>
    <a href="/answers.html" class="nav-date-btn today">All Answers</a>
  </div>
  <div class="faq-section">
    <div class="section-title">Frequently Asked Questions</div>
    <div class="faq-item"><button class="faq-q" onclick="tFaq(this)" aria-expanded="false">What is the Spelling Bee answer for ${friendly}?<span class="faq-chev">\u2964</span></button><div class="faq-a">The NYT Spelling Bee for ${friendly} has ${totalWords} valid words. The center letter is ${centerLetter} and the pangram is ${primaryPangram}. Maximum score is ${maxScore} points. Genius requires ${geniusScore} points.</div></div>
    <div class="faq-item"><button class="faq-q" onclick="tFaq(this)" aria-expanded="false">What is the Spelling Bee pangram for ${friendly}?<span class="faq-chev">\u2964</span></button><div class="faq-a">The pangram for ${friendly} is ${primaryPangram}. It uses all 7 letters at least once and is worth ${primaryPangram.length + 7} points (${primaryPangram.length} for length plus 7 pangram bonus).</div></div>
    <div class="faq-item"><button class="faq-q" onclick="tFaq(this)" aria-expanded="false">How many words in Spelling Bee ${friendly}?<span class="faq-chev">\u2964</span></button><div class="faq-a">The NYT Spelling Bee for ${friendly} has ${totalWords} valid words. Maximum score is ${maxScore} points. Genius requires ${geniusScore} points. Center letter is ${centerLetter}.</div></div>
    <div class="faq-item"><button class="faq-q" onclick="tFaq(this)" aria-expanded="false">What is the Genius score for ${friendly}?<span class="faq-chev">\u2964</span></button><div class="faq-a">Genius threshold for ${friendly} is ${geniusScore} points (70% of max ${maxScore}). Queen Bee requires all ${totalWords} words for the full ${maxScore} points.</div></div>
    <div class="faq-item"><button class="faq-q" onclick="tFaq(this)" aria-expanded="false">What letters are in Spelling Bee ${friendly}?<span class="faq-chev">\u2964</span></button><div class="faq-a">The letters for ${friendly} are ${allLetters.join(', ')}. Center letter is ${centerLetter} which must appear in every valid word. Words must be at least 4 letters and can reuse letters freely.</div></div>
  </div>
  <div class="share-strip" aria-label="Share this page">
    <span class="share-strip-lbl">Share</span>
    <div class="share-btns">
      <button class="sbn sbn-native" onclick="if(navigator.share){navigator.share({title:'Spelling Bee ${friendly} Answers',url:'https://www.spellingbeefinder.com/answers/${slug}.html'})}" aria-label="Share"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg></button>
      <button class="sbn sbn-copy" id="sbn-copy-${slug}" onclick="navigator.clipboard.writeText('https://www.spellingbeefinder.com/answers/${slug}.html').then(function(){var b=document.getElementById('sbn-copy-${slug}');b.style.background='#059669';b.style.color='#fff';setTimeout(function(){b.style.background='';b.style.color=''},2500)})" aria-label="Copy link"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>
      <a class="sbn sbn-fb" href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fwww.spellingbeefinder.com%2Fanswers%2F${slug}.html" target="_blank" rel="noopener" aria-label="Facebook"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg></a>
      <a class="sbn sbn-tw" href="https://twitter.com/intent/tweet?url=https%3A%2F%2Fwww.spellingbeefinder.com%2Fanswers%2F${slug}.html&text=Spelling%20Bee%20${friendly.replace(/ /g,'%20')}%20Answers" target="_blank" rel="noopener" aria-label="X"><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.737-8.835L1.254 2.25H8.08l4.259 5.63zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg></a>
      <a class="sbn sbn-wa" href="https://api.whatsapp.com/send?text=Spelling%20Bee%20${friendly.replace(/ /g,'%20')}%20Answers%20https%3A%2F%2Fwww.spellingbeefinder.com%2Fanswers%2F${slug}.html" target="_blank" rel="noopener" aria-label="WhatsApp"><svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg></a>
      <a class="sbn sbn-em" href="mailto:?subject=Spelling%20Bee%20${friendly.replace(/ /g,'%20')}%20Answers&body=https%3A%2F%2Fwww.spellingbeefinder.com%2Fanswers%2F${slug}.html" aria-label="Email"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></a>
    </div>
  </div>
</div>
<div class="nav-dates-bottom">
  <a href="/answers/${prevSlug}.html" class="nav-date-btn">&larr; Previous Puzzle</a>
  <a href="/answers.html" class="nav-date-btn today">&#9729; All Answers</a>
</div>
<div class="mobile-nav-bar">
  <a href="/answers/${prevSlug}.html" class="mnb-prev"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15,18 9,12 15,6"/></svg>Prev</a>
  <a href="/answers.html" class="mnb-archive"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/></svg>Archive</a>
  <a href="#" class="mnb-next" id="next-puzzle-btn">Next<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9,18 15,12 9,6"/></svg></a>
</div>
</div>
<footer>
  <div class="foot-inner">
    <div class="foot-col">
      <div class="foot-brand-row">
        <div class="foot-brand-hex"><img src="/bee-icon-nav.webp" alt="bee" width="16" height="16" style="object-fit:contain;display:block;" loading="lazy"></div>
        <span class="foot-brand-name">Spelling<em>Bee</em>Finder</span>
      </div>
      <p>Free NYT Spelling Bee word finder. Find every word, master the pangram. Updated 2026.</p>
    </div>
    <div class="foot-col"><h4>Tools</h4><a href="/index.html">Spelling Bee Solver</a><a href="/answers.html">Daily Answers Archive</a><a href="/index.html">Hints Mode</a><a href="/index.html">Practice Mode</a></div>
    <div class="foot-col"><h4>Resources</h4><a href="/gear.html">Books &amp; Gear</a><a href="/about.html">About</a><a href="/contact.html">Contact</a></div>
    <div class="foot-col"><h4>Legal</h4><a href="/privacy.html">Privacy Policy</a><a href="/disclaimer.html">Disclaimer</a></div>
  </div>
  <div class="foot-bottom">
    <p>&copy; 2026 SpellingBeeFinder.com &mdash; Not affiliated with The New York Times. Educational tool only.</p>
    <p>SpellingBeeFinder.com is a participant in the Amazon Services LLC Associates Program (tag: williamdunb0d-20). <a href="/disclaimer.html" style="color:#64748b;">Full Disclosure</a></p>
  </div>
</footer>
<script>
function tFaq(btn){var a=btn.nextElementSibling,c=btn.querySelector('.faq-chev');var o=a.classList.contains('open');a.classList.toggle('open',!o);c.classList.toggle('open',!o);btn.setAttribute('aria-expanded',!o);}
document.getElementById('navHam').addEventListener('click',function(){document.getElementById('navLinks').classList.toggle('open');});
(function(){
  var iso='${iso}';
  var d=new Date(iso+'T12:00:00');
  d.setDate(d.getDate()+1);
  var mn=['january','february','march','april','may','june','july','august','september','october','november','december'];
  var nextSlug='spelling-bee-'+mn[d.getMonth()]+'-'+String(d.getDate()).padStart(2,'0')+'-'+d.getFullYear();
  var btn=document.getElementById('next-puzzle-btn');
  if(btn){btn.href='/answers/'+nextSlug+'.html';}
})();
</script>
</body>
</html>`;
}

async function main() {
  const dates = getDateStrings();
  console.log(`Generating page for: ${dates.friendly}`);

  const outputPath = path.join(__dirname, '..', 'answers', dates.filename);
  const isOverride = process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]);
  if (fs.existsSync(outputPath) && !isOverride) {
    console.log(`Page already exists: ${dates.filename} -- skipping (no date override given)`);
    process.exit(0);
  }
  if (fs.existsSync(outputPath) && isOverride) {
    console.log(`Page exists but date override given -- regenerating: ${dates.filename}`);
  }

  let answers;
  try {
    answers = await fetchFromNytBeeWithRetry(dates);
    console.log(`Fetched from nytbee.com: ${answers.totalWords} words, pangram(s): ${answers.pangrams.join(', ')}`);
  } catch (err) {
    console.error(`nytbee.com failed after retries: ${err.message}`);
    if (isOverride) {
      console.error('Date override was given — refusing to use the today-only fallback scraper, since it would write the WRONG date\'s data under this filename. Failing job for manual review.');
      process.exit(1);
    }
    try {
      answers = await fetchFallback(dates);
      console.log(`Fallback (today-only): ${answers.totalWords} words`);
    } catch (err2) {
      console.error(`All sources failed: ${err2.message}`);
      process.exit(1);
    }
  }

  const html = generateHtml(dates, answers);
  const answersDir = path.join(__dirname, '..', 'answers');
  if (!fs.existsSync(answersDir)) fs.mkdirSync(answersDir, { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf8');
  console.log(`Written: ${outputPath}`);

  const meta = {
    date: dates.iso, friendly: dates.friendly, slug: dates.slug,
    filename: dates.filename, centerLetter: answers.centerLetter,
    pangram: answers.pangrams[0] || '', pangrams: answers.pangrams,
    totalWords: answers.totalWords, maxScore: answers.maxScore
  };
  const metaPath = path.join(__dirname, '..', 'answers', `${dates.slug}.json`);
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf8');
  console.log(`Metadata saved. Done.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
