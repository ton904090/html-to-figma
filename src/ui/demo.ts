// Built-in demo: a compact 3-slide deck in the style of Claude-generated presentations.
export const DEMO_HTML = `<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8"><title>Демо-презентація</title>
<style>
*{margin:0;box-sizing:border-box}
body{background:#0b0b10;font-family:Inter,system-ui,sans-serif}
.slide{width:1280px;height:720px;padding:80px 96px;color:#f4f4f6;position:relative;overflow:hidden;background:#141419;margin-bottom:24px}
.slide::after{content:"";position:absolute;right:-120px;top:-120px;width:420px;height:420px;border-radius:50%;background:radial-gradient(circle,rgba(255,90,31,.35),transparent 70%)}
.kicker{color:#ff5a1f;font-weight:700;letter-spacing:.16em;text-transform:uppercase;font-size:16px;margin-bottom:24px}
h1{font-size:76px;line-height:1.02;letter-spacing:-.03em;max-width:900px}
h1 em{font-style:normal;background:linear-gradient(90deg,#ff5a1f,#ffb547);-webkit-background-clip:text;background-clip:text;color:transparent}
h2{font-size:48px;letter-spacing:-.02em;margin-bottom:40px}
p.sub{font-size:24px;color:#a1a1ad;margin-top:28px;max-width:720px;line-height:1.45}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
.card{background:#1d1d24;border:1px solid #2c2c35;border-radius:18px;padding:30px}
.num{font-size:60px;font-weight:800;letter-spacing:-.03em}
.label{color:#a1a1ad;font-size:18px;margin-top:6px}
.up{display:inline-block;margin-top:18px;padding:5px 12px;border-radius:99px;background:rgba(60,207,127,.14);color:#3ccf7f;font-weight:600;font-size:15px}
ul{list-style:none;padding:0}
li{font-size:28px;padding:14px 0 14px 44px;position:relative;border-bottom:1px solid #2c2c35}
li::before{content:"";position:absolute;left:0;top:24px;width:16px;height:16px;border-radius:5px;background:#ff5a1f}
.foot{position:absolute;left:96px;right:96px;bottom:40px;display:flex;justify-content:space-between;color:#5d5d68;font-size:15px}
</style></head><body>
<section class="slide"><div class="kicker">Демо · HTML → Figma</div><h1>Кожен слайд стає <em>редагованим фреймом</em></h1><p class="sub">Текст лишається текстом, градієнти — градієнтами, а тіні й радіуси — властивостями шарів.</p><div class="foot"><span>HTML → Figma</span><span>01</span></div></section>
<section class="slide"><h2>Точність перенесення</h2><div class="grid"><div class="card"><div class="num">1:1</div><div class="label">Геометрія з браузера</div><span class="up">▲ пікселі</span></div><div class="card"><div class="num">100%</div><div class="label">Редагований текст</div><span class="up">▲ шрифти</span></div><div class="card"><div class="num">SVG</div><div class="label">Вектори, не картинки</div><span class="up">▲ якість</span></div></div><div class="foot"><span>HTML → Figma</span><span>02</span></div></section>
<section class="slide"><h2>Як користуватися</h2><ul><li>Перетягніть .html або вставте код</li><li>Оберіть розмір вікна</li><li>Натисніть «Імпортувати» — готово</li></ul><div class="foot"><span>HTML → Figma</span><span>03</span></div></section>
</body></html>`;
