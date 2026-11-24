# Third-party notices

`server/qq-music.mjs`, `server/qq-auth.mjs`, `server/qq-lyrics.mjs`, `server/netease-music.mjs`, and the QQ Music / Netease Cloud Music login flows in `desktop/main.js` are adapted from [Sonic Topography](https://github.com/yin-yizhen/sonic-topography), copyright 2026 Sonic Topography contributors.

They are used here for local personal, non-commercial use under that project's **Non-Commercial Learning License**. The upstream license permits reading, studying, modifying, and running the code locally for personal non-commercial use. Commercial use, resale, sublicensing, advertising services, and removal of the notice require written permission from the copyright holder.

## Liquid DOM

The glass surfaces use @liquid-dom/core 0.1.1 (https://github.com/AndrewPrifer/liquid-dom), MIT license, Copyright (c) 2026 Andras Prifer. ORBIT uses WebGpuDomContentSource to render the complete live music scene (DOM cards, covers, lyrics and visualizers) beneath shared WebGpuGlassCore surfaces. HTML-in-Canvas is enabled in the desktop Chromium runtime. Unsupported browsers and mobile use CSS blur without borders.

MIT License

Copyright (c) 2026 Andras Prifer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Direct Runtime & Build Dependencies

| Package | License | Repository / Homepage |
| :--- | :--- | :--- |
| `react` / `react-dom` | MIT | https://github.com/facebook/react |
| `express` | MIT | https://github.com/expressjs/express |
| `electron` | MIT | https://github.com/electron/electron |
| `electron-updater` / `electron-builder` | MIT | https://github.com/electron-userland/electron-builder |
| `vite` / `@vitejs/plugin-react` | MIT | https://github.com/vitejs/vite |
| `@liquid-dom/core` | MIT | https://github.com/AndrewPrifer/liquid-dom |
