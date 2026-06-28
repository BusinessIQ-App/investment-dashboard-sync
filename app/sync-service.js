const express = require('express');
const cron = require('node-cron');
const { spawn } = require('child_process');
const { getPositions, getFullPicture } = require('./portfolio');
const { renderPositionsTable, renderTransactionsTable } = require('./render-tables');

const app = express();
const port = Number(process.env.SYNC_SERVICE_PORT || 8080);

let running = false;
let lastRun = null;

function runSync(trigger) {
  return new Promise((resolve, reject) => {
    if (running) {
      const result = {
        ok: false,
        skipped: true,
        reason: 'sync_already_running',
        trigger,
        lastRun
      };

      console.log(JSON.stringify(result));
      return resolve(result);
    }

    running = true;

    const startedAt = new Date().toISOString();

    console.log(`Starting sync trigger=${trigger} startedAt=${startedAt}`);

    const child = spawn('node', ['sync.js'], {
      cwd: __dirname,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      const text = data.toString();
      stdout += text;
      process.stdout.write(text);
    });

    child.stderr.on('data', data => {
      const text = data.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on('close', code => {
      const finishedAt = new Date().toISOString();

      lastRun = {
        trigger,
        startedAt,
        finishedAt,
        exitCode: code
      };

      running = false;

      const result = {
        ok: code === 0,
        trigger,
        startedAt,
        finishedAt,
        exitCode: code,
        stdoutTail: stdout.slice(-3000),
        stderrTail: stderr.slice(-3000)
      };

      if (code === 0) {
        console.log(`Sync completed trigger=${trigger} finishedAt=${finishedAt}`);
        resolve(result);
      } else {
        console.error(`Sync failed trigger=${trigger} exitCode=${code}`);
        reject(result);
      }
    });
  });
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    running,
    lastRun
  });
});

app.get('/sync', async (req, res) => {
  try {
    const result = await runSync('manual_get');
    res.json(result);
  } catch (err) {
    res.status(500).json(err);
  }
});

app.post('/sync', async (req, res) => {
  try {
    const result = await runSync('manual_post');
    res.json(result);
  } catch (err) {
    res.status(500).json(err);
  }
});

// Live SnapTrade reads (independent of the sync schedule and the DB).
// /positions  -> current holdings only.
// /transactions -> holdings + open-lot buy dates + FIFO realized sells.
app.get('/positions', async (req, res) => {
  try {
    const result = await getPositions();
    res.json(result);
  } catch (err) {
    console.error('positions failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/transactions', async (req, res) => {
  try {
    const result = await getFullPicture();
    res.json(result);
  } catch (err) {
    console.error('transactions failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Same data as /positions and /transactions, rendered as browser-readable HTML tables.
// The positions table sources from getFullPicture() (not the lightweight getPositions())
// so the First-buy column is populated from the activity feed — the JSON /positions
// endpoint stays activity-free and unchanged.
app.get('/positions-table', async (req, res) => {
  try {
    const result = await getFullPicture();
    res.type('html').send(renderPositionsTable(result));
  } catch (err) {
    console.error('positions-table failed:', err.message);
    res.status(500).type('html').send(`<pre>positions-table error: ${err.message}</pre>`);
  }
});

app.get('/transactions-table', async (req, res) => {
  try {
    const result = await getFullPicture();
    res.type('html').send(renderTransactionsTable(result));
  } catch (err) {
    console.error('transactions-table failed:', err.message);
    res.status(500).type('html').send(`<pre>transactions-table error: ${err.message}</pre>`);
  }
});

// Runs every 10 minutes from 04:00 through 19:50 Eastern, Monday-Friday.
cron.schedule(
  '*/10 4-19 * * 1-5',
  () => {
    runSync('scheduled_10min').catch(err => {
      console.error('Scheduled sync failed:', err);
    });
  },
  {
    timezone: 'America/New_York'
  }
);

// Final run at 20:00 Eastern, Monday-Friday.
cron.schedule(
  '0 20 * * 1-5',
  () => {
    runSync('scheduled_afterhours_close').catch(err => {
      console.error('Scheduled close sync failed:', err);
    });
  },
  {
    timezone: 'America/New_York'
  }
);

app.listen(port, '0.0.0.0', () => {
  console.log(`Sync service listening on port ${port}`);
  console.log('Schedule: every 10 minutes from 04:00 through 20:00 America/New_York, Monday-Friday');
});
