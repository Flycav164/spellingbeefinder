// update-archive.js
// Reads all answer page JSON metadata files
// Rebuilds answers.html with updated archive grid
// Runs automatically after generate-answer-page.js

const fs = require('fs');
const path = require('path');

function buildArchiveHtml(entries) {
  // entries sorted newest first
  const cards = entries.map(e => `
      <a href="answers/${e.slug}.html" class="archive-card">
        <div class="archive-date-badge">
          <span class="archive-month">${e.friendly.split(' ')[0].slice(0,3).toUpperCase()}</span>
          <span class="archive-day">${e.friendly.split(' ')[1].replace(',','')}</span>
        </div>
        <div class="archive-card-body">
          <div class="archive-card-title">Spelling Bee ${e.friendly} Answers</div>
          <div class="archive-card-meta">
            Center: <strong>${e.centerLetter}</strong>
            &bull; <span class="archive-pangram">${e.pangram} \u2605</span>
            &bull; ${e.totalWords} words
          </div>
        </div>
      </a>`).join('\n');

  return cards;
}

function main() {
  const answersDir = path.join(__dirname, '..', 'answers');
  
  // Read all JSON metadata files
  const jsonFiles = fs.readdirSync(answersDir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(answersDir, f), 'utf8'));
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date)); // newest first

  if (jsonFiles.length === 0) {
    console.log('No answer metadata found — skipping archive update');
    return;
  }

  console.log(`Building archive with ${jsonFiles.length} entries`);

  // Read current answers.html
  const archivePath = path.join(__dirname, '..', 'answers.html');
  let archiveHtml = fs.readFileSync(archivePath, 'utf8');

  // Replace the archive grid content
  const newCards = buildArchiveHtml(jsonFiles);
  
  // Find and replace the archive grid section
  const startMarker = '<!-- ARCHIVE-GRID-START -->';
  const endMarker = '<!-- ARCHIVE-GRID-END -->';
  
  const startIdx = archiveHtml.indexOf(startMarker);
  const endIdx = archiveHtml.indexOf(endMarker);
  
  if (startIdx === -1 || endIdx === -1) {
    console.error('Archive markers not found in answers.html — cannot update');
    return;
  }
  
  archiveHtml = 
    archiveHtml.slice(0, startIdx + startMarker.length) +
    '\n' + newCards + '\n      ' +
    archiveHtml.slice(endIdx);

  // Update total count in stats
  archiveHtml = archiveHtml.replace(
    /<!-- ARCHIVE-COUNT -->\d+/,
    `<!-- ARCHIVE-COUNT -->${jsonFiles.length}`
  );

  fs.writeFileSync(archivePath, archiveHtml, 'utf8');
  console.log(`Archive updated: ${jsonFiles.length} entries`);
  console.log('Done.');
}

main();
