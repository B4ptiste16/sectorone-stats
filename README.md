# SectorOne stats
Hourly GitHub Action -> static page with charts on GitHub Pages. The page and `data/history.enc.json` are AES-256-GCM encrypted with `STATS_PASSWORD`; without that secret the build publishes an empty page and collects nothing. Inside, accounts are "User N", with no emails and no rating comments (repo variable SHOW_COMMENTS=1 shows comments).
Local private view (emails + comments): `node build.cjs --serve` -> http://localhost:5199
Secrets: FIREBASE_SERVICE_ACCOUNT (read-only service-account JSON), STATS_PASSWORD (`node setup-password.cjs`), optional STATS_GH_TOKEN (PAT for traffic graphs).
