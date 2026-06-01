FROM node:20-alpine AS frontend-build

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.12-slim

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PYTHONPATH=/app/backend
ENV NEWHORIZONS_HOST=0.0.0.0
ENV NEWHORIZONS_PORT=5051
ENV NEWHORIZONS_FRONTEND_DIST=/app/frontend/dist
ENV NEWHORIZONS_DATA_ROOT=/data/mqtt_store
ENV NEWHORIZONS_PROFILES_DIR=/data/profiles

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend ./backend
COPY mock_data ./mock_data
COPY --from=frontend-build /app/frontend/dist ./frontend/dist

EXPOSE 5051/tcp

CMD ["python", "-m", "newhorizons_backend.standalone"]
