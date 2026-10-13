# Usage: python3 test/zoom.py <name> x y w h [scale]  -> test/out/<name>.zoom.png (original | figma | diff)
import sys
from PIL import Image
name, x, y, w, h = sys.argv[1], *map(int, sys.argv[2:6])
s = int(sys.argv[6]) if len(sys.argv) > 6 else 3
imgs = [Image.open(f'test/out/{name}.{k}.png').convert('RGB').crop((x, y, x + w, y + h)).resize((w * s, h * s), Image.NEAREST) for k in ('original', 'figma', 'diff')]
out = Image.new('RGB', (w * s, h * s * 3 + 8), 'black')
for i, im in enumerate(imgs):
    out.paste(im, (0, i * (h * s + 4)))
out.save(f'test/out/{name}.zoom.png')
