#!/usr/bin/env node

const esbuild = require('esbuild');
const { sassPlugin } = require('esbuild-sass-plugin');
const { clean } = require('esbuild-plugin-clean');
const { copy } = require('esbuild-plugin-copy');
const svgrPlugin = require('esbuild-plugin-svgr');

const isProd =
  process.argv.indexOf('prod') !== -1 ||
  process.argv.indexOf('prod-hosted') !== -1;
const isHosted = process.argv.indexOf('prod-hosted') !== -1;
const isChrome = process.argv.indexOf('chrome') !== -1;

esbuild
  .build({
    bundle: true,
    entryPoints: {
      // code
      background: './src/background.ts',
      'content-script': './src/content-script.js',
      'nostr-provider': './src/nostr-provider.ts',
      types: './src/types.ts',
      storage: './src/storage.ts',
      common: './src/common.ts',
      pin: './src/pin.tsx',
      popup: './src/popup.tsx',
      prompt: './src/prompt.tsx',
      options: './src/options.tsx',
      // styles
      style: './src/style.scss'
    },
    outdir: './dist',
    loader: {
      ['.png']: 'dataurl',
      ['.svg']: 'text',
      ['.ttf']: 'file',
      ['.json']: 'file'
    },
    plugins: [
      clean({
        patterns: ['./dist/*'],
        cleanOn: 'start'
      }),
      sassPlugin(),
      svgrPlugin(),
      copy({
        assets: [
          {
            from: [
              isChrome ? './src/manifest-chrome.json'
                : isHosted ? './src/hosted/manifest.json'
                : './src/manifest.json'
            ],
            to: ['./']
          },
          {
            from: ['./src/*.html'],
            to: ['./']
          },
          {
            from: ['./src/assets/logo/*'],
            to: ['./assets/logo']
          },
          {
            from: ['./src/assets/icons/*'],
            to: ['./assets/icons']
          }
        ]
      })
    ],
    sourcemap: isProd ? false : 'inline',
    jsxFactory: 'createElement',
    jsxFragment: '"Fragment"',
    inject: ['./src/react-shim.ts'],
    alias: {
      'react': './src/react-shim.ts',
    },
    define: {
      global: 'window'
    }
  })
  .then(() => {
    // Chrome manifest needs to be renamed from manifest-chrome.json to manifest.json
    if (isChrome) {
      const fs = require('fs');
      const path = require('path');
      const dist = path.join(__dirname, 'dist');
      const src = path.join(dist, 'manifest-chrome.json');
      const dest = path.join(dist, 'manifest.json');
      if (fs.existsSync(src)) {
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        fs.renameSync(src, dest);
      }
    }
    console.log(`Build success. Prod=${isProd} - Hosted=${isHosted} - Chrome=${isChrome}.`);
  })
  .catch(err =>
    console.error(`Build error. Prod=${isProd} - Hosted=${isHosted} - Chrome=${isChrome}.`, err)
  );
