# HROne Web UI setup

## Start backend
Keep the existing FastAPI backend and MongoDB running on port 8001:

```bash
cd ~/Projects/hrone-assignment/candidate_kit
source .venv/bin/activate
export MONGO_URI="mongodb://localhost:27017"
export MONGO_DB="hrone_attendance"
uvicorn app.main:app --reload --port 8001
```

## Start frontend (second terminal)

```bash
cd ~/Projects/hrone-assignment/candidate_kit/frontend
npm install
npm run dev
```

Open http://localhost:5173. The frontend proxies API calls to the backend on port 8001.

## What is included
- Responsive admin dashboard with employee count, attendance KPIs, department summary, late-arrival leaderboard.
- Employee directory with search and add employee modal.
- Attendance list and CSV export.
- Department summary analytics and late leaderboard charts.
- Employee portal preview with monthly stats and punch-in/punch-out actions.
- Demo role selector on the sign-in page.

## Security limitation
The login screen currently provides demo role selection only. It is not a secure authentication system. Do not use this UI with real employee data or expose it to the internet until server-side authentication, password hashing, session/token validation, and authorization on protected backend endpoints are implemented. The current API endpoints are not role-protected.
