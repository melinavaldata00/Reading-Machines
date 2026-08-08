import os
import io
import base64
import numpy as np
import cv2
import pytesseract
from pytesseract import Output
from flask import Flask, request, jsonify
from flask_cors import CORS
from PIL import Image

app = Flask(__name__)
CORS(app)


@app.route('/')
def health():
    return jsonify({'status': 'ok', 'service': 'reading-machines cv layers'})

# ── helpers ───────────────────────────────────────────────

def decode_image(b64):
    data = base64.b64decode(b64.split(',')[-1])
    arr  = np.frombuffer(data, np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)

def encode_image(bgr):
    _, buf = cv2.imencode('.png', bgr)
    return 'data:image/png;base64,' + base64.b64encode(buf).decode()

def preprocess_ocr(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    return cv2.adaptiveThreshold(gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 11)

def preprocess_lines(img, kern):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    binary = cv2.adaptiveThreshold(gray, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 15)
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (kern, 5))
    return binary, cv2.dilate(binary, k, iterations=1)

def preprocess_letters(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3, 3), 0)
    return cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)[1]

def get_ocr_data(img, conf_thresh):
    proc = preprocess_ocr(img)
    data = pytesseract.image_to_data(proc, output_type=Output.DICT,
        lang='ita+eng', config='--oem 3 --psm 6')
    boxes, words = [], []
    for i in range(len(data['text'])):
        txt = data['text'][i].strip()
        try:
            conf = float(data['conf'][i])
        except:
            conf = -1
        if txt and conf >= conf_thresh:
            boxes.append({
                'x': int(data['left'][i]),
                'y': int(data['top'][i]),
                'w': int(data['width'][i]),
                'h': int(data['height'][i]),
                'text': txt,
                'conf': conf,
                'line': int(data['line_num'][i]),
                'block': int(data['block_num'][i]),
            })
            words.append(txt)
    return boxes, ' '.join(words)

# ── routes ────────────────────────────────────────────────

@app.route('/layer', methods=['POST'])
def layer():
    body  = request.json
    img   = decode_image(body['image'])
    layer = body['layer']
    conf  = int(body.get('conf', 10))
    kern  = int(body.get('kern', 31))
    larea = int(body.get('larea', 500))
    letter= int(body.get('letter', 20))
    pixel = int(body.get('pixel', 12))
    obscure_mode = body.get('obscure', 'black')

    result = {'boxes': [], 'text': '', 'svg': None}

    if layer == 'decode':
        boxes, text = get_ocr_data(img, conf)
        out = img.copy()
        line_colors = [
            (192,57,43),(36,113,163),(30,132,73),(211,84,0),
            (108,52,131),(17,122,101),(125,102,8),(26,82,118),
        ]
        for b in boxes:
            c = line_colors[(b['line']-1) % len(line_colors)]
            cv2.rectangle(out, (b['x'],b['y']), (b['x']+b['w'],b['y']+b['h']), c, 2)
        result['boxes'] = boxes
        result['text']  = text
        result['image'] = encode_image(out)

    elif layer == 'boxes':
        boxes, text = get_ocr_data(img, conf)
        out = img.copy()
        for b in boxes:
            cv2.rectangle(out, (b['x'],b['y']), (b['x']+b['w'],b['y']+b['h']), (30,132,73), 2)
        result['boxes'] = boxes
        result['text']  = text
        result['image'] = encode_image(out)

    elif layer == 'lines':
        _, dilated = preprocess_lines(img, kern)
        contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        out = img.copy()
        boxes = []
        for c in contours:
            if cv2.contourArea(c) < larea:
                continue
            x,y,w,h = cv2.boundingRect(c)
            cv2.rectangle(out, (x,y), (x+w,y+h), (255,0,0), 2)
            boxes.append({'x':x,'y':y,'w':w,'h':h,'text':'','conf':100,'line':0,'block':0})
        result['boxes'] = boxes
        result['image'] = encode_image(out)

    elif layer == 'letters':
        binary = preprocess_letters(img)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        out = img.copy()
        boxes = []
        for c in contours:
            if cv2.contourArea(c) < letter:
                continue
            x,y,w,h = cv2.boundingRect(c)
            cv2.rectangle(out, (x,y), (x+w,y+h), (255,0,255), 2)
            boxes.append({'x':x,'y':y,'w':w,'h':h,'text':'','conf':100,'line':0,'block':0})
        result['boxes'] = boxes
        result['image'] = encode_image(out)

    elif layer == 'outline':
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.GaussianBlur(gray, (3, 3), 0)
        _, bin_inv = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        _, bin_std = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        kernel_clean = cv2.getStructuringElement(cv2.MORPH_RECT, (2, 2))
        cl_inv = cv2.morphologyEx(bin_inv, cv2.MORPH_OPEN, kernel_clean, iterations=1)
        cl_std = cv2.morphologyEx(bin_std, cv2.MORPH_OPEN, kernel_clean, iterations=1)
        ct_inv, _ = cv2.findContours(cl_inv, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        ct_std, _ = cv2.findContours(cl_std, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        contours = ct_inv if len(ct_inv) >= len(ct_std) else ct_std

        out = np.zeros_like(img)
        paths = []
        areas = [cv2.contourArea(c) for c in contours]
        max_area = max(areas, default=1)
        for c, area in zip(contours, areas):
            if area < letter:
                continue
            pts = c.reshape(-1, 2).tolist()
            if len(pts) < 3:
                continue
            cv2.drawContours(out, [c], -1, (255, 255, 255), 1)
            x, y, w, h = cv2.boundingRect(c)
            cx, cy = float(x + w / 2), float(y + h / 2)
            rel_pts = [[int(p[0]) - cx, int(p[1]) - cy] for p in pts]
            paths.append({
                "cx": round(cx, 1),
                "cy": round(cy, 1),
                "pts": rel_pts,
                "areaN": round(area / max_area, 4),
                "w": int(w), "h": int(h),
            })
        print(f"outline: {len(paths)} paths (letter={letter})")
        result["paths"] = paths
        result["image"] = encode_image(out)

    elif layer == 'merge':
        binary = preprocess_letters(img)
        k = cv2.getStructuringElement(cv2.MORPH_RECT, (kern, 7))
        merged = cv2.dilate(binary, k, iterations=1)
        result['image'] = encode_image(cv2.cvtColor(merged, cv2.COLOR_GRAY2BGR))

    elif layer == 'obscure':
        boxes, text = get_ocr_data(img, conf)
        out = img.copy()
        for b in boxes:
            x,y,w,h = b['x'],b['y'],b['w'],b['h']
            roi = out[y:y+h, x:x+w]
            if obscure_mode == 'black':
                out[y:y+h, x:x+w] = 0
            elif obscure_mode == 'blur':
                out[y:y+h, x:x+w] = cv2.GaussianBlur(roi, (51,51), 30)
            elif obscure_mode == 'pixel':
                small = cv2.resize(roi, (max(1,w//pixel), max(1,h//pixel)),
                    interpolation=cv2.INTER_LINEAR)
                out[y:y+h, x:x+w] = cv2.resize(small, (w,h),
                    interpolation=cv2.INTER_NEAREST)
        result['boxes'] = boxes
        result['text']  = text
        result['image'] = encode_image(out)

    elif layer == 'svg':
        _, dilated = preprocess_lines(img, kern)
        contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        h, w = img.shape[:2]
        parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}">',
                 '<rect width="100%" height="100%" fill="white"/>']
        out = np.zeros_like(img)
        boxes = []
        for c in contours:
            if cv2.contourArea(c) < larea:
                continue
            approx = cv2.approxPolyDP(c, 2.0, True)
            pts = approx.reshape(-1, 2)
            if len(pts) < 3:
                continue
            d = f"M {pts[0][0]} {pts[0][1]}"
            for px,py in pts[1:]:
                d += f" L {px} {py}"
            d += " Z"
            parts.append(f'<path d="{d}" fill="none" stroke="black" stroke-width="1"/>')
            cv2.drawContours(out, [c], -1, (255,255,255), 2)
            rx,ry,rw,rh = cv2.boundingRect(c)
            boxes.append({'x':rx,'y':ry,'w':rw,'h':rh,'text':'','conf':100,'line':0,'block':0})
        parts.append('</svg>')
        result['svg']   = '\n'.join(parts)
        result['boxes'] = boxes
        result['image'] = encode_image(out)

    return jsonify(result)


@app.route('/font-loop', methods=['POST'])
def font_loop():
    from PIL import Image as PILImage, ImageDraw, ImageFont

    body      = request.json
    letter    = body.get('letter', 'A').strip()
    max_iter  = int(body.get('max_iter', 7))
    threshold = int(body.get('threshold', 15))
    intensity = float(body.get('intensity', 0.6))
    font_size_ratio = float(body.get('font_size', 0.75))
    dim       = int(body.get('dim', 300))

    font_name  = body.get('font_name', 'ABC Gaisyr')
    font_style = body.get('font_style', 'normal')

    # map font name + style to possible file paths (user fonts + project fonts)
    font_map = {
        ('ABC Gaisyr',        'normal'): ['ABCGaisyrMono-Light-Trial.otf'],
        ('ABC Gaisyr',        'italic'): ['ABCGaisyrMono-Light-Trial.otf'],
        ('Millionaire',       'normal'): ['millionairetrial-roman.otf'],
        ('Millionaire',       'italic'): ['millionairetrial-italic.otf'],
        ('MillionaireScript', 'normal'): ['millionairetrial-script.otf'],
    }
    search_dirs = [
        '/Users/melina/Library/Fonts',
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts'),
        os.path.expanduser('~/Library/Fonts'),
    ]
    fallback_files = ['Helvetica.ttc', 'Arial.ttf']
    fallback_dirs  = ['/System/Library/Fonts']

    font_path = None
    for fname in font_map.get((font_name, font_style), []):
        for d in search_dirs:
            candidate = os.path.join(d, fname)
            if os.path.exists(candidate):
                font_path = candidate
                break
        if font_path:
            break

    if not font_path:
        for fname in fallback_files:
            for d in fallback_dirs:
                candidate = os.path.join(d, fname)
                if os.path.exists(candidate):
                    font_path = candidate
                    break
            if font_path:
                break

    print(f'[font-loop] font_name={font_name!r} style={font_style!r} → {font_path}')

    def render_letter(char, dim):
        img = PILImage.new('RGB', (dim, dim), (255, 255, 255))
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype(font_path, int(dim * font_size_ratio)) if font_path else ImageFont.load_default()
        except:
            font = ImageFont.load_default()
        try:
            bbox = draw.textbbox((0, 0), char, font=font)
            x = (dim - (bbox[2] - bbox[0])) // 2 - bbox[0]
            y = (dim - (bbox[3] - bbox[1])) // 2 - bbox[1]
            draw.text((x, y), char, fill=(0, 0, 0), font=font)
        except:
            draw.text((dim // 4, dim // 4), char, fill=(0, 0, 0))
        return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

    def measure_conf(char, img):
        h, w = img.shape[:2]
        strip = np.ones((h, w * 5 + 40, 3), dtype=np.uint8) * 255
        for i in range(5):
            strip[:h, i * (w + 8):i * (w + 8) + w] = img
        try:
            data = pytesseract.image_to_data(strip, lang='eng',
                output_type=Output.DICT,
                config='--psm 7 --oem 3')
            confs = [int(c) for c in data['conf'] if int(c) > 0]
            return round(float(np.mean(confs))) if confs else 0
        except:
            return 0

    def iter_fourier(img, intensity):
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
        f = np.fft.fft2(gray)
        fshift = np.fft.fftshift(f)
        h, w = gray.shape
        cy, cx = h // 2, w // 2
        raggio = max(2, int((1 - intensity) * min(cy, cx)))
        mask = np.zeros((h, w))
        cv2.circle(mask, (cx, cy), raggio, 1, -1)
        fshift_filtered = fshift * mask
        f_back = np.fft.ifftshift(fshift_filtered)
        img_back = np.abs(np.fft.ifft2(f_back))
        img_back = cv2.normalize(img_back, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        binary = cv2.adaptiveThreshold(img_back, 255,
            cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
            cv2.THRESH_BINARY_INV, 11, 2)
        contours, hierarchy = cv2.findContours(binary, cv2.RETR_TREE, cv2.CHAIN_APPROX_NONE)
        result = np.ones((h, w, 3), dtype=np.uint8) * 255
        if hierarchy is not None:
            for c in contours:
                if cv2.contourArea(c) > 15:
                    cv2.drawContours(result, [c], -1, (0, 0, 0), 1)
        return result

    def extract_paths(img):
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        _, binary = cv2.threshold(gray, 128, 255, cv2.THRESH_BINARY_INV)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        paths = []
        areas = [cv2.contourArea(c) for c in contours]
        max_area = max(areas, default=1)
        for c, area in zip(contours, areas):
            if area < 8:
                continue
            pts = c.reshape(-1, 2).tolist()
            if len(pts) < 2:
                continue
            x, y, w, h = cv2.boundingRect(c)
            cx, cy = float(x + w / 2), float(y + h / 2)
            rel_pts = [[int(p[0]) - cx, int(p[1]) - cy] for p in pts]
            paths.append({
                'cx': round(cx, 1),
                'cy': round(cy, 1),
                'pts': rel_pts,
                'areaN': round(area / max_area, 4),
            })
        return paths

    img        = render_letter(letter, dim)
    conf_prev  = measure_conf(letter, img)
    final_img  = img.copy()
    blind_iter = max_iter
    final_conf = conf_prev

    for it in range(1, max_iter + 1):
        img_new = iter_fourier(img, intensity)
        conf    = measure_conf(letter, img_new)
        if conf < threshold and conf_prev >= threshold:
            final_img  = img.copy()
            blind_iter = it - 1
            final_conf = conf_prev
        img       = img_new
        conf_prev = conf

    if blind_iter == max_iter:
        final_img  = img
        final_conf = conf_prev

    paths = extract_paths(final_img)

    return jsonify({
        'paths':      paths,
        'blind_iter': blind_iter,
        'final_conf': final_conf,
        'dim':        dim,
    })


if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5050))
    print(f'\n  CV LAYERS server running on port {port}\n')
    app.run(host='0.0.0.0', port=port, debug=False)