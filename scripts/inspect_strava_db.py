import os
import sqlite3

# Windows default; on macOS/Linux point this at your Electron userData path instead
# (app.getPath('userData') inside the app — see CLAUDE.md).
DB_PATH = os.path.join(os.environ.get('APPDATA', ''), 'mien', 'mien.db')
db = sqlite3.connect(DB_PATH)
c = db.cursor()

print('--- Tables matching strava/workout ---')
for row in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%strava%' OR name LIKE '%workout%')"):
    print(' ', row[0])

print('--- Workouts in health_metrics (count + date range) ---')
c.execute("SELECT COUNT(*), MIN(date), MAX(date) FROM health_metrics WHERE metric_type='workout'")
print(' ', c.fetchone())

print('--- Workouts by source ---')
for row in c.execute("SELECT source, COUNT(*) FROM health_metrics WHERE metric_type='workout' GROUP BY source ORDER BY 2 DESC"):
    print(' ', row)

print('--- strava_streams table ---')
try:
    c.execute('SELECT COUNT(*) FROM strava_streams')
    print('  rows:', c.fetchone()[0])
    c.execute('SELECT COUNT(DISTINCT activity_id) FROM strava_streams')
    print('  distinct activities:', c.fetchone()[0])
except Exception as e:
    print('  (no table or error):', e)
