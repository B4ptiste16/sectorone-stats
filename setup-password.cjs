// Run once by the owner: creates the dashboard password, encrypts the saved
// history, stores the password as a repo secret and rebuilds the page.
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const { execFileSync: run } = require('child_process');
const { seal, HISTORY, PW_FILE } = require('./build.cjs');
const REPO = 'B4ptiste16/sectorone-stats', SEED = path.join(os.homedir(), '.sectorone-stats-history-seed.json');
const git = (...a) => run('git', a, { cwd: __dirname, stdio: 'inherit' });
if (!fs.existsSync(PW_FILE)) fs.writeFileSync(PW_FILE, crypto.randomBytes(18).toString('base64url'), { mode: 0o600 });
const pw = fs.readFileSync(PW_FILE, 'utf8').trim();
git('pull', '-q', '--rebase');
if (fs.existsSync(SEED) && !fs.existsSync(HISTORY)) {
  fs.mkdirSync(path.dirname(HISTORY), { recursive: true });
  fs.writeFileSync(HISTORY, JSON.stringify(seal(fs.readFileSync(SEED, 'utf8'), pw)));
  git('add', 'data'); git('commit', '-qm', 'encrypted history'); git('push', '-q');
  fs.unlinkSync(SEED);
}
run('gh', ['secret', 'set', 'STATS_PASSWORD', '-R', REPO], { input: pw, stdio: ['pipe', 'inherit', 'inherit'] });
run('gh', ['workflow', 'run', 'stats.yml', '-R', REPO], { stdio: 'inherit' });
console.log('Done. Your password is in ' + PW_FILE + ' (open that file; it is not printed here).');
