'use strict';

// Renders assets/logo.svg and assets/tray.svg to the PNGs the app and installers use.
// Run with: npm run icons   (uses Electron's Chromium, so no extra tools are needed)
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ASSETS = path.join(__dirname, '..', 'assets');
const logo = fs.readFileSync(path.join(ASSETS, 'logo.svg'), 'utf8');
const tray = fs.readFileSync(path.join(ASSETS, 'tray.svg'), 'utf8');
const tint = (svg, color) => svg.replace('color="#000000"', `color="${color}"`);

// [file, svg, size, padding]: macOS app icons sit inside a 824/1024 grid, the others fill the canvas.
const OUTPUTS = [
  ['icon.png', logo, 256, 0],
  ['icon512.png', logo, 512, 0],
  ['icon1024.png', logo, 1024, 100],
  ['tray-black.png', tint(tray, '#000000'), 22, 0],
  ['tray-black@2x.png', tint(tray, '#000000'), 44, 0],
  ['tray-white.png', tint(tray, '#ffffff'), 22, 0],
  ['tray-white@2x.png', tint(tray, '#ffffff'), 44, 0],
];

async function render(win, svg, size, pad) {
  const url = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const js = `new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = ${size};
      c.getContext('2d').drawImage(img, ${pad}, ${pad}, ${size - 2 * pad}, ${size - 2 * pad});
      resolve(c.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = reject;
    img.src = ${JSON.stringify(url)};
  })`;
  return Buffer.from(await win.webContents.executeJavaScript(js), 'base64');
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL('about:blank');
  for (const [file, svg, size, pad] of OUTPUTS) {
    fs.writeFileSync(path.join(ASSETS, file), await render(win, svg, size, pad));
    console.log(`assets/${file} ${size}px`);
  }
  app.exit(0);
});
