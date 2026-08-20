from PIL import Image
import os

ref_path = '/home/botom/devintest/arena/img2threejs/crown-chest.png'
render_path = '/home/botom/devintest/arena/img2threejs/cofre-glb-swe17/render.png'
out_path = '/home/botom/devintest/arena/img2threejs/cofre-glb-swe17/comparison.png'

ref = Image.open(ref_path).convert('RGBA')
render = Image.open(render_path).convert('RGBA')

# Resize to same height
h = 1024
ref = ref.resize((h, h), Image.LANCZOS)
render = render.resize((h, h), Image.LANCZOS)

# Background
bg = Image.new('RGBA', (h * 2 + 40, h + 40), (25, 25, 45, 255))
bg.paste(ref, (20, 20), ref)
bg.paste(render, (h + 40, 20), render)

bg.save(out_path)
print('Comparison saved to', out_path)
