import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { builtinModules } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import viteCp from 'vite-plugin-cp';
import viteOxlint from 'unplugin-oxlint/vite';
import viteZipPack from 'unplugin-zip-pack/vite';
import Plugin from './package.json';

const SRC_DIR = resolve(__dirname, './src');
const OUTPUT_DIR = resolve(__dirname, './dist');

function viewerHtmlPlugin() {
  return {
    name: 'recall-viewer-html',
    closeBundle() {
      const dir = resolve(OUTPUT_DIR, './renderer/pages/recallMsgViewer');
      mkdirSync(dir, { recursive: true });
      const css = readFileSync(resolve(SRC_DIR, './renderer/viewer/index.css'), 'utf-8')
        .replace(/<\/script>/gi, '<\\/script>');
      const js = readFileSync(resolve(OUTPUT_DIR, './renderer/viewer.js'), 'utf-8')
        .replace(/<\/script>/gi, '<\\/script>');
      writeFileSync(
        dir + '/index.html',
        `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>撤回消息</title><style>${css}</style></head><body><script type="module">${js}</script></body></html>`,
        'utf-8',
      );
    },
  };
}

const external = ['electron', ...builtinModules.flatMap(m => [m, `node:${m}`])];
const runtimeExternal = ['level-party'];

const BaseConfig = defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      '@': SRC_DIR,
    },
  },
});

const configs = {
  main: defineConfig({
    ...BaseConfig,

    plugins: [
      viteOxlint({
        includes: ['src/**/*.ts'],
        fix: true,
      }),
    ],
    build: {
      minify: true,
      ssr: true,
      outDir: resolve(OUTPUT_DIR, './main'),
      lib: {
        entry: resolve(SRC_DIR, './main/index.ts'),
        formats: [ 'cjs' ],

        fileName: () => 'index.cjs',
      },
      rollupOptions: {
        external: [...external, ...runtimeExternal],
      },
      target: 'node23',
    },
    esbuild: {
      platform: 'node',
    },
  }),
  preload: defineConfig({
    ...BaseConfig,

    plugins: [
      viteOxlint({
        includes: ['src/**/*.ts'],
        fix: true,
      }),
    ],
    build: {
      minify: true,
      outDir: resolve(OUTPUT_DIR, './preload'),
      lib: {
        entry: {
          index: resolve(SRC_DIR, './preload/index.ts'),
          recallMsgViewer: resolve(SRC_DIR, './preload/recallMsgViewer.ts'),
        },
        formats: [ 'cjs' ],
      },
      rollupOptions: {
        external,
      },
    },
  }),
  renderer: defineConfig({
    ...BaseConfig,

    plugins: [
      viteOxlint({
        includes: ['src/**/*.ts'],
        fix: true,
      }),
      viewerHtmlPlugin(),
      viteCp({
        targets: [
          { src: './package.json', dest: 'dist' },
          { src: './src/renderer/viewer/index.css', dest: './dist/renderer', rename: 'viewer.css' },
        ],
      }),
      viteZipPack({
        in: OUTPUT_DIR,
        out: resolve(__dirname, `./${Plugin.name}.zip`),
      }),
    ],
    build: {
      minify: true,
      outDir: resolve(OUTPUT_DIR, './renderer'),
      lib: {
        entry: {
          index: resolve(SRC_DIR, './renderer/index.ts'),
          viewer: resolve(SRC_DIR, './renderer/viewer/index.ts'),
        },
        formats: [ 'es' ],
      },
      rollupOptions: {
        input: {
          index: resolve(SRC_DIR, './renderer/index.ts'),
          viewer: resolve(SRC_DIR, './renderer/viewer/index.ts'),
        },
        external,
      },
    },
  }),
};

export default defineConfig(({ mode }) => configs[mode as keyof typeof configs]);
