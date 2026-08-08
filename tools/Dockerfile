FROM python:3.10-slim

# tesseract-ocr: the actual OCR engine binary (pytesseract is just a wrapper)
# tesseract-ocr-ita: Italian language data, used by server.py (lang='ita+eng')
# libgl1 / libglib2.0-0: common runtime deps for opencv on slim/minimal images
RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-ita \
    libgl1 \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py .
COPY fonts ./fonts

ENV PORT=5050
EXPOSE 5050

CMD ["sh", "-c", "gunicorn -w 1 -b 0.0.0.0:${PORT} --timeout 180 server:app"]
