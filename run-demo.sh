#!/bin/bash
# P.Care Pharma — Local Demo Runner
# Boots backend + frontend for local verification.
set -e

echo "🏥 P.Care Pharma — Local Demo"
echo "=============================="

# --- Backend ---
cd backend
if [ ! -d node_modules ]; then echo "Installing backend deps..."; npm install; fi
if [ ! -f .env ]; then
  echo "⚠️  No backend/.env found. Creating a DUMMY one for UI-only demo."
  echo "   (Real data needs real Supabase keys — see .env.example)"
  cat > .env << 'ENVEOF'
SUPABASE_URL=https://dummy.supabase.co
SUPABASE_SERVICE_KEY=dummy-service-key
SUPABASE_ANON_KEY=dummy-anon-key
FRONTEND_URL=http://localhost:3000
NODE_ENV=development
PORT=4000
ENVEOF
fi
echo "▶ Starting backend on :4000..."
node src/server.js &
BACKEND_PID=$!
cd ..

# --- Frontend ---
cd frontend
if [ ! -d node_modules ]; then echo "Installing frontend deps..."; npm install; fi
echo "▶ Starting frontend on :3000..."
npm run dev &
FRONTEND_PID=$!
cd ..

echo ""
echo "✅ Backend:  http://localhost:4000/health"
echo "✅ Frontend: http://localhost:3000"
echo ""
echo "Press Ctrl+C to stop both."
trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null" EXIT
wait
