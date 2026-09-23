FROM python:3.12-slim
WORKDIR /app
COPY server.py demo_data.py ./
COPY web ./web
ENV PORT=8080 PYTHONUNBUFFERED=1
EXPOSE 8080
USER nobody
CMD ["python3", "server.py"]
