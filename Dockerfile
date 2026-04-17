FROM python:3.11-slim

# Set working directory
WORKDIR /app

# ✅ FIX (A-05): Install Node.js for frontend build
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy requirements file (needs to copy the backend folder since it's inside backend/)
COPY backend/requirements.txt ./backend/

# Install the underlying dependencies
RUN pip install --no-cache-dir -r backend/requirements.txt

# Copy the rest of the application
COPY . .

# ✅ FIX (A-05): Build frontend static assets for production
RUN cd frontend && npm ci --production=false && npm run build

# Expose the necessary port
EXPOSE 8000

# Set environment variables commonly used in python
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

# Command to run the application (Uses os.environ.get('PORT') inside app.py)
CMD ["python", "backend/app.py"]
