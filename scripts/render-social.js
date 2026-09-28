'use strict';

// Renders docs/social/social.html to site/og.png (1280x640): the image shown when the site or
// the GitHub repo is shared (upload it in the repo's Settings → Social preview too).
// Run with: npm run social
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 640, useContentSize: true, show: false, frame: false });
  await win.loadFile(path.join(ROOT, 'docs', 'social', 'social.html'));
  await new Promise((r) => setTimeout(r, 500)); // let the images decode
  const img = (await win.webContents.capturePage()).resize({ width: 1280, height: 640 });
  fs.writeFileSync(path.join(ROOT, 'site', 'og.png'), img.toPNG());
  console.log('site/og.png', img.getSize());
  app.exit(0);
});
