# Campaign Copilot - Monorepo

An AI-native Mini CRM codebase split into three primary services:

1. **`crm-api`** (Port `3001`): The core CRM service. Manages customer state, campaigns, receipt logs, and Gemini AI interactions.
2. **`channel-service`** (Port `3002`): The mock message gateway. Simulates carrier behavior (WhatsApp, SMS), async delivery, and fires delivery status receipts back to CRM API.
3. **`frontend`** (Port `5173`): React + Vite single-page dashboard app styled with Tailwind CSS.

---

## Local Setup & Dev Instructions

### Prerequisites
- Node.js (version 18+ recommended)
- `npm` (packaged with Node.js)

### 1. CRM API Service
```bash
cd crm-api
# Copy configuration
cp .env.example .env
# Install dependencies (if not already done)
npm install
# Start development server
npm run dev
```

### 2. Channel Service
```bash
cd channel-service
# Copy configuration
cp .env.example .env
# Install dependencies (if not already done)
npm install
# Start development server
npm run dev
```

### 3. Frontend App
```bash
cd frontend
# Install dependencies (if not already done)
npm install
# Start Vite development server
npm run dev
```

---

## Environment Variables

To run the services locally or deploy them to production (such as Vercel and Render), configure the following environment variables:

### 1. `frontend` (Vercel)
Create a `.env` file in the `frontend/` directory (already in `.gitignore`):
- `VITE_CRM_API_URL`: The URL of the deployed `crm-api` (e.g., `https://crm-api-service.onrender.com` in production, or `http://localhost:3001` in development).

### 2. `crm-api` (Render)
Create a `.env` file in the `crm-api/` directory (already in `.gitignore`):
- `PORT`: Port to listen on (e.g., `3001`).
- `GEMINI_API_KEY`: API key for Google Gemini AI co-pilot.
- `SUPABASE_URL`: The URL of your Supabase project.
- `SUPABASE_ANON_KEY`: The anonymous public API key of your Supabase project.
- `CHANNEL_SERVICE_URL`: The URL of the deployed `channel-service` (e.g., `https://channel-service.onrender.com` in production, or `http://localhost:3002` in development).
- `FRONTEND_URL`: The URL of the deployed `frontend` (used for CORS configuration; e.g. `https://xeno-crm.vercel.app` or `http://localhost:5173`).

### 3. `channel-service` (Render)
Create a `.env` file in the `channel-service/` directory (already in `.gitignore`):
- `PORT`: Port to listen on (e.g., `3002`).
- `CRM_API_URL`: The URL of the deployed `crm-api` to send simulated callbacks back to (e.g. `https://crm-api-service.onrender.com` or `http://localhost:3001`).
- `FRONTEND_URL`: The URL of the deployed `frontend` (used for CORS; e.g., `https://xeno-crm.vercel.app` or `http://localhost:5173`).

