// Builds dist/code.js (Figma main thread) and dist/ui.html (UI with the capture script inlined).
import * as esbuild from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const watch = process.argv.includes('--watch');
const common = { bundle: true, write: false, logLevel: 'warning', legalComments: 'none' };

async function buildAll() {
  await mkdir(resolve(root, 'dist'), { recursive: true });

  // Figma's main-thread sandbox supports ES2019 syntax at most (no ?. / ?? in older clients).
  const code = await esbuild.build({ ...common, entryPoints: [resolve(root, 'src/main/code.ts')], target: 'es2017', format: 'iife' });
  await writeFile(resolve(root, 'dist/code.js'), code.outputFiles[0].text);

  const capture = await esbuild.build({ ...common, entryPoints: [resolve(root, 'src/capture/index.ts')], target: 'es2019', format: 'iife', minify: true });
  const captureJs = capture.outputFiles[0].text;
  await writeFile(resolve(root, 'dist/capture.js'), captureJs);

  const ui = await esbuild.build({
    ...common,
    entryPoints: [resolve(root, 'src/ui/ui.ts')],
    target: 'es2019',
    format: 'iife',
    minify: true,
    define: { CAPTURE_SCRIPT: JSON.stringify(captureJs) },
  });
  const template = await readFile(resolve(root, 'src/ui/ui.html'), 'utf8');
  const uiJs = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  await writeFile(resolve(root, 'dist/ui.html'), template.replace('/*UI_SCRIPT*/', () => uiJs));
  console.log(`built dist/code.js (${(code.outputFiles[0].text.length / 1024).toFixed(1)} KB), dist/ui.html (${((template.length + uiJs.length) / 1024).toFixed(1)} KB)`);
}

await buildAll();
if (watch) {
  const { watch: fsWatch } = await import('node:fs');
  let timer;
  fsWatch(resolve(root, 'src'), { recursive: true }, () => {
    clearTimeout(timer);
    timer = setTimeout(() => buildAll().catch((e) => console.error(e.message)), 100);
  });
  console.log('watching src/ …');
}
