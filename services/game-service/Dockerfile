# Build context: ./services (so the shared `common` package can be copied in).
FROM python:3.12-slim
WORKDIR /srv
ENV PYTHONUNBUFFERED=1 PYTHONPATH=/srv/common
COPY game-service/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY common /srv/common
COPY game-service/app app
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
