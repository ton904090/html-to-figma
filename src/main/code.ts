import type { MainToUI, UIToMain } from '../shared/types';
import { Builder } from './build';

const send = (msg: MainToUI) => figma.ui.postMessage(msg);

figma.showUI(__html__, { width: 420, height: 720, themeColors: true });

figma.clientStorage.getAsync('settings').then((settings) => {
  if (settings) send({ type: 'settings', settings });
});

let busy = false;

figma.ui.onmessage = async (msg: UIToMain) => {
  switch (msg.type) {
    case 'resize':
      figma.ui.resize(Math.round(msg.width), Math.round(msg.height));
      return;
    case 'save-settings':
      await figma.clientStorage.setAsync('settings', msg.settings);
      return;
    case 'notify':
      figma.notify(msg.message, { error: !!msg.error });
      return;
    case 'import': {
      if (busy) return;
      busy = true;
      const started = Date.now();
      try {
        const builder = new Builder(msg.result, msg.options, (message, ratio) => send({ type: 'progress', message, ratio }));
        const nodes = await builder.build();
        if (figma.editorType !== 'slides') figma.currentPage.selection = nodes;
        figma.viewport.scrollAndZoomIntoView(nodes);
        const warnings = [...msg.result.warnings, ...builder.warnings];
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        const n = msg.result.frames.length;
        const word = n % 10 === 1 && n % 100 !== 11 ? 'слайд' : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? 'слайди' : 'слайдів';
        const what = msg.result.kind === 'slides' ? `${n} ${word}` : `«${msg.result.title}»`;
        const message = `Готово: ${what} за ${secs} с`;
        figma.notify(message);
        send({ type: 'done', message, warnings });
      } catch (e) {
        const message = (e as Error)?.message || String(e);
        figma.notify(`Помилка імпорту: ${message}`, { error: true });
        send({ type: 'error', message });
      } finally {
        busy = false;
      }
      return;
    }
  }
};
