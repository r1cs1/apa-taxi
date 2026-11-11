/* Apa TAXI — a Hungarian-style taximeter for dad's family chauffeur service. */
(() => {
  "use strict";

  // Budapest regulated taxi tariff, valid from 1 August 2026.
  const OFFICIAL = { baseFee: 1300, kmFee: 521, minFee: 130 };

  const LS_SETTINGS = "apataxi.settings.v1";
  const LS_TRIP = "apataxi.trip.v1";
  const LS_HISTORY = "apataxi.history.v1";

  const GPS_MAX_ACCURACY_M = 50;   // ignore fixes worse than this
  const GPS_MIN_STEP_M = 4;        // ignore jitter smaller than this
  const GPS_MAX_SPEED_MS = 70;     // ~250 km/h, anything faster is a GPS jump
  const SPEED_STALE_MS = 6000;     // no movement for this long => standing

  // ---------- helpers ----------
  const $ = (id) => document.getElementById(id);
  const load = (key, fallback) => {
    try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
  };
  const save = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } };
  const nf = new Intl.NumberFormat("hu-HU", { maximumFractionDigits: 0 });
  const ft = (n) => `${nf.format(Math.round(n))} Ft`;
  const pad = (n) => String(Math.floor(n)).padStart(2, "0");
  const hms = (ms) => { const s = ms / 1000; return `${pad(s / 3600)}:${pad((s % 3600) / 60)}:${pad(s % 60)}`; };
  const ms2 = (ms) => { const s = ms / 1000; return s >= 3600 ? hms(ms) : `${pad(s / 60)}:${pad(s % 60)}`; };
  const clock = (t) => new Date(t).toLocaleTimeString("hu-HU", { hour: "2-digit", minute: "2-digit" });
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function haversine(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---------- state ----------
  let settings = { ...OFFICIAL, passengers: [], passenger: "", demo: false, sound: true, ...load(LS_SETTINGS, {}) };
  // older versions stored a single passenger name
  if (!Array.isArray(settings.passengers)) settings.passengers = [];
  if (settings.passenger && !settings.passengers.includes(settings.passenger)) settings.passengers.unshift(settings.passenger);
  const freshTrip = () => ({
    status: "idle",      // idle | running | paused | done
    startedAt: null, endedAt: null,
    elapsedMs: 0,        // running time (pauses excluded)
    waitMs: 0,           // time billed at the per-minute rate
    distanceM: 0,        // total distance driven
    billedDistanceM: 0,  // distance billed at the per-km rate
    lastTick: null,
  });
  let trip = { ...freshTrip(), ...load(LS_TRIP, {}) };
  let history = load(LS_HISTORY, []);

  // live (not persisted)
  let anchor = null;          // last accepted GPS point
  let pendingDistM = 0;       // distance accepted since last tick
  let speedKmh = 0;
  let lastMoveAt = 0;
  let gpsWatchId = null;
  let demoTimer = null;
  let wakeLock = null;
  let lastFareShown = -1;

  // Below this speed the meter charges per minute, above it per km (Hungarian "átváltási sebesség").
  const thresholdKmh = () => (settings.kmFee > 0 ? (settings.minFee * 60) / settings.kmFee : Infinity);

  const fareParts = () => {
    const started = trip.status !== "idle";
    const base = started ? settings.baseFee : 0;
    const km = (trip.billedDistanceM / 1000) * settings.kmFee;
    const wait = (trip.waitMs / 60000) * settings.minFee;
    return { base, km, wait, total: base + km + wait };
  };

  // ---------- GPS ----------
  function onFix(lat, lon, accuracy, gpsSpeedMs, t) {
    if (accuracy != null && accuracy > GPS_MAX_ACCURACY_M) { setGps("weak", accuracy); return; }
    setGps("ok", accuracy);
    const fix = { lat, lon, t };
    if (!anchor) { anchor = fix; return; }

    const d = haversine(anchor, fix);
    const dt = Math.max((t - anchor.t) / 1000, 0.001);
    const hasSpeed = typeof gpsSpeedMs === "number" && !Number.isNaN(gpsSpeedMs);

    // Standing still per the GPS chip: don't let jitter add distance.
    if (hasSpeed && gpsSpeedMs < 0.7 && d < 25) { updateSpeed(gpsSpeedMs * 3.6); return; }

    if (d < Math.max(GPS_MIN_STEP_M, (accuracy || 0) * 0.6)) return; // jitter, keep the anchor

    const computed = d / dt;
    if (computed > GPS_MAX_SPEED_MS) { anchor = fix; return; } // teleport; re-anchor

    if (trip.status === "running") pendingDistM += d;
    anchor = fix;
    updateSpeed((hasSpeed ? gpsSpeedMs : computed) * 3.6);
  }

  function updateSpeed(kmh) {
    speedKmh = speedKmh * 0.35 + kmh * 0.65;
    if (kmh > 1) lastMoveAt = Date.now();
  }

  function setGps(state, acc) {
    const el = $("gpsBadge");
    if (settings.demo) { el.className = "badge badge-warn"; el.textContent = "DEMÓ"; return; }
    const map = {
      ok: ["badge-ok", `GPS ✓${acc ? ` ±${Math.round(acc)} m` : ""}`],
      weak: ["badge-warn", `GPS gyenge ±${Math.round(acc)} m`],
      wait: ["badge-muted", "GPS keresés…"],
      denied: ["badge-bad", "GPS tiltva"],
      none: ["badge-bad", "Nincs GPS"],
    };
    const [cls, txt] = map[state] || map.wait;
    el.className = `badge ${cls}`;
    el.textContent = txt;
  }

  function startGps() {
    stopGps();
    anchor = null;
    if (settings.demo) { startDemo(); setGps("ok"); return; }
    if (!("geolocation" in navigator)) { setGps("none"); toast("Ez a böngésző nem ad helyadatot. Próbáld a Demó módot!"); return; }
    setGps("wait");
    gpsWatchId = navigator.geolocation.watchPosition(
      (p) => onFix(p.coords.latitude, p.coords.longitude, p.coords.accuracy, p.coords.speed, p.timestamp || Date.now()),
      (err) => {
        if (err.code === 1) { setGps("denied"); toast("A helymeghatározás le van tiltva. Engedélyezd a böngészőben!"); }
        else setGps("wait");
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }

  function stopGps() {
    if (gpsWatchId != null) navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
    if (demoTimer) clearInterval(demoTimer);
    demoTimer = null;
  }

  // Demo: a simulated Budapest drive with traffic lights and a traffic jam.
  function startDemo() {
    let lat = 47.5149, lon = 19.0779, bearing = 215, v = 0, step = 0;
    const plan = [
      // [seconds, target km/h]
      [10, 50], [25, 50], [8, 0], [15, 0], [8, 35], [20, 35], [12, 8], [20, 8], [8, 60], [30, 60], [8, 0], [12, 0],
    ];
    const totalSteps = plan.reduce((s, p) => s + p[0], 0);
    demoTimer = setInterval(() => {
      let t = step % totalSteps, target = 0;
      for (const [len, kmh] of plan) { if (t < len) { target = kmh; break; } t -= len; }
      v += Math.max(-3, Math.min(2.5, target / 3.6 - v)); // m/s with accel limits
      v = Math.max(0, v);
      if (step % 37 === 0) bearing += (Math.random() - 0.5) * 80;
      const R = 6371000, rad = Math.PI / 180;
      lat += ((v * Math.cos(bearing * rad)) / R) / rad;
      lon += ((v * Math.sin(bearing * rad)) / (R * Math.cos(lat * rad))) / rad;
      const jitter = () => (Math.random() - 0.5) * 0.00002;
      onFix(lat + jitter(), lon + jitter(), 5, v, Date.now());
      step++;
    }, 1000);
  }

  // ---------- meter loop ----------
  function tick() {
    const now = Date.now();
    if (trip.status === "running") {
      const dt = trip.lastTick ? Math.max(0, now - trip.lastTick) : 0;
      if (now - lastMoveAt > SPEED_STALE_MS) speedKmh *= 0.5;
      if (speedKmh < 0.5) speedKmh = 0;

      trip.elapsedMs += dt;
      trip.distanceM += pendingDistM;
      if (speedKmh >= thresholdKmh()) trip.billedDistanceM += pendingDistM;
      else trip.waitMs += dt;
      pendingDistM = 0;
      trip.lastTick = now;
    } else {
      pendingDistM = 0;
      if (now - lastMoveAt > SPEED_STALE_MS) speedKmh = 0;
    }
    render();
  }

  function render() {
    const p = fareParts();
    const total = Math.round(p.total);
    const fareEl = $("fare");
    fareEl.textContent = nf.format(total);
    if (total !== lastFareShown && trip.status === "running") {
      const box = fareEl.parentElement;
      box.classList.remove("tick"); void box.offsetWidth; box.classList.add("tick");
    }
    lastFareShown = total;

    $("time").textContent = hms(trip.elapsedMs);
    $("dist").textContent = (trip.distanceM / 1000).toFixed(2);
    $("speed").textContent = Math.round(speedKmh);
    $("wait").textContent = ms2(trip.waitMs);

    $("bBase").textContent = ft(p.base);
    $("bKm").textContent = ft(p.km);
    $("bWait").textContent = ft(p.wait);
    $("bKmInfo").textContent = `${(trip.billedDistanceM / 1000).toFixed(2)} km × ${nf.format(settings.kmFee)} Ft`;
    $("bWaitInfo").textContent = `${(trip.waitMs / 60000).toFixed(1)} perc × ${nf.format(settings.minFee)} Ft`;

    const mode = $("modeLabel");
    if (trip.status === "running") {
      const byKm = speedKmh >= thresholdKmh();
      mode.textContent = byKm ? "● KM-DÍJ" : "● IDŐDÍJ";
      mode.classList.toggle("wait", !byKm);
    } else {
      mode.textContent = trip.status === "paused" ? "SZÜNET" : trip.status === "done" ? "VÉGE" : "SZABAD";
      mode.classList.remove("wait");
    }

    const lamp = $("statusLamp");
    lamp.className = "lamp " + (trip.status === "running" ? "lamp-busy" : trip.status === "paused" ? "lamp-paused" : "lamp-free");
    lamp.textContent = trip.status === "running" ? "FOGLALT" : trip.status === "paused" ? "SZÜNET" : "SZABAD";

    const s = trip.status;
    $("startBtn").textContent = s === "paused" ? "FOLYTATÁS" : s === "done" ? "ÚJ FUVAR" : "INDULÁS";
    $("startBtn").disabled = s === "running";
    $("pauseBtn").disabled = s !== "running";
    $("stopBtn").disabled = !(s === "running" || s === "paused");

    $("debtTotal").textContent = ft(history.reduce((sum, h) => sum + h.total, 0));
  }

  // ---------- actions ----------
  function start() {
    if (trip.status === "done") trip = freshTrip();
    if (trip.status === "idle") {
      trip.startedAt = Date.now();
      beep([660, 880]);
      toast(pick([
        "Jó napot! Hova lesz a fuvar? 🚕",
        "Az óra elindult. Kérjük, kösse be magát!",
        "Apa Taxi – mert a busz nem jön be a ház elé.",
        "Indulunk! A borravaló nincs benne az árban. 😉",
      ]));
    }
    trip.status = "running";
    trip.lastTick = Date.now();
    pendingDistM = 0;
    requestWakeLock();
    persist();
    render();
  }

  function pause() {
    if (trip.status !== "running") return;
    tick();
    trip.status = "paused";
    persist();
    render();
  }

  function stop() {
    if (!(trip.status === "running" || trip.status === "paused")) return;
    if (trip.status === "running") tick();
    trip.status = "done";
    trip.endedAt = Date.now();
    const p = fareParts();
    const record = {
      id: trip.endedAt,
      passenger: settings.passenger || "Családtag",
      startedAt: trip.startedAt, endedAt: trip.endedAt,
      distanceM: trip.distanceM, elapsedMs: trip.elapsedMs, waitMs: trip.waitMs,
      billedDistanceM: trip.billedDistanceM,
      base: p.base, km: p.km, wait: p.wait, total: Math.round(p.total),
      rates: { baseFee: settings.baseFee, kmFee: settings.kmFee, minFee: settings.minFee },
    };
    history.unshift(record);
    history = history.slice(0, 200);
    save(LS_HISTORY, history);
    persist();
    releaseWakeLock();
    beep([880, 660, 990]);
    render();
    showReceipt(record);
  }

  function newTrip() {
    trip = freshTrip();
    persist();
    closeModals();
    render();
  }

  function persist() { save(LS_TRIP, trip); }

  // ---------- receipt ----------
  function showReceipt(r) {
    const no = String(r.id).slice(-6);
    const payment = pick([
      "1 db ölelés", "Mosogatás (1 hét)", "Kocsimosás", "Szemétlevitel", "Puszi (2 db)",
      "Szobarendrakás", "Egy hideg sör apának", "Csend az autóban", "Hálás mosoly",
    ]);
    const tipTip = Math.round((r.total * 0.15) / 10) * 10;
    const footer = pick([
      "Köszönjük, hogy az Apa Taxit választotta!",
      "Legközelebb is szívesen – de azért kérdezzen előtte.",
      "A sofőr értékelése kötelező, csak 5 csillag adható.",
      "Hűségprogram: 10 fuvar után a 11. is fizetős.",
      "A zenét a sofőr választja. Ez nem vita tárgya.",
    ]);
    $("receipt").innerHTML = `
      <h3>APA TAXI</h3>
      <div class="center muted">Családi Személyszállító Bt.<br>Adószám: 12345678-A-PA · Sofőr: Apa</div>
      <hr>
      <div class="line"><span>Nyugtaszám</span><span>#${no}</span></div>
      <div class="line"><span>Dátum</span><span>${new Date(r.endedAt).toLocaleDateString("hu-HU")}</span></div>
      <div class="line"><span>Indulás / érkezés</span><span>${clock(r.startedAt)} – ${clock(r.endedAt)}</span></div>
      <div class="line"><span>Utas</span><span>${esc(r.passenger)}</span></div>
      <hr>
      <div class="line"><span>Megtett táv</span><span>${(r.distanceM / 1000).toFixed(2)} km</span></div>
      <div class="line"><span>Menetidő</span><span>${hms(r.elapsedMs)}</span></div>
      <hr>
      <div class="line"><span>Alapdíj</span><span>${ft(r.base)}</span></div>
      <div class="line"><span>Km-díj (${(r.billedDistanceM / 1000).toFixed(2)} km × ${nf.format(r.rates.kmFee)})</span><span>${ft(r.km)}</span></div>
      <div class="line"><span>Várakozás (${(r.waitMs / 60000).toFixed(1)} p × ${nf.format(r.rates.minFee)})</span><span>${ft(r.wait)}</span></div>
      <hr>
      <div class="line total"><span>FIZETENDŐ</span><span>${ft(r.total)}</span></div>
      <div class="line muted"><span>Javasolt borravaló (15%)</span><span>${ft(tipTip)}</span></div>
      <div class="line"><span>Elfogadott fizetőeszköz</span><span>${payment}</span></div>
      <hr>
      <div class="center">Értékelje sofőrünket:<div class="stars">★★★★★</div></div>
      <div class="center muted">${footer}</div>
      <div class="center"><span class="stamp">FIZETENDŐ!</span></div>
    `;
    openModal("receiptModal");
  }

  // ---------- history ----------
  function showHistory() {
    const list = $("historyList");
    if (!history.length) {
      list.innerHTML = `<div class="empty">Még nincs fuvar. A család egyelőre nem tartozik semmivel. (Egyelőre.)</div>`;
    } else {
      const total = history.reduce((s, h) => s + h.total, 0);
      list.innerHTML = `<div class="item"><span><b>Összesen</b><small>${history.length} fuvar</small></span><b>${ft(total)}</b></div>` +
        history.map((h, i) => `
          <div class="item" data-idx="${i}">
            <span>${esc(h.passenger)}<small>${new Date(h.endedAt).toLocaleDateString("hu-HU")} ${clock(h.startedAt)} · ${(h.distanceM / 1000).toFixed(1)} km · ${hms(h.elapsedMs)}</small></span>
            <b>${ft(h.total)}</b>
          </div>`).join("");
      list.querySelectorAll("[data-idx]").forEach((el) =>
        el.addEventListener("click", () => { closeModals(); showReceipt(history[+el.dataset.idx]); }));
    }
    openModal("historyModal");
  }

  // ---------- settings ----------
  function openSettings() {
    $("setPassengers").value = settings.passengers.join("\n");
    $("setBase").value = settings.baseFee;
    $("setKm").value = settings.kmFee;
    $("setMin").value = settings.minFee;
    $("setDemo").checked = settings.demo;
    $("setSound").checked = settings.sound;
    updateHint();
    openModal("settingsModal");
  }

  function updateHint() {
    const km = +$("setKm").value || 0, min = +$("setMin").value || 0;
    const th = km > 0 ? (min * 60) / km : 0;
    $("thresholdHint").textContent =
      `Átváltási sebesség: ${th.toFixed(1)} km/h — ez alatt percdíj, fölötte km-díj számolódik (mint az igazi taxiórában).`;
  }

  function saveSettings() {
    const num = (id, fb) => { const v = parseFloat($(id).value); return Number.isFinite(v) && v >= 0 ? v : fb; };
    const demoChanged = $("setDemo").checked !== settings.demo;
    const passengers = [...new Set($("setPassengers").value.split(/[\n,]/).map((s) => s.trim().slice(0, 30)).filter(Boolean))].slice(0, 12);
    settings = {
      ...settings,
      passengers,
      passenger: passengers.includes(settings.passenger) ? settings.passenger : "",
      baseFee: num("setBase", settings.baseFee),
      kmFee: num("setKm", settings.kmFee),
      minFee: num("setMin", settings.minFee),
      demo: $("setDemo").checked,
      sound: $("setSound").checked,
    };
    save(LS_SETTINGS, settings);
    if (demoChanged) startGps();
    closeModals();
    renderPassengers();
    render();
    toast("Beállítások mentve");
  }

  // ---------- passengers ----------
  function renderPassengers() {
    const box = $("passengerChips");
    box.innerHTML = "";
    const chip = (label, cls, onClick) => {
      const b = document.createElement("button");
      b.className = `chip ${cls}`;
      b.textContent = label;
      b.addEventListener("click", onClick);
      box.appendChild(b);
    };
    if (!settings.passengers.length) {
      const s = document.createElement("b");
      s.className = "chip-static";
      s.textContent = "Családtag";
      box.appendChild(s);
      chip("+ utasok", "chip-add", openSettings);
      return;
    }
    settings.passengers.forEach((name) =>
      chip(name, name === settings.passenger ? "active" : "", () => {
        settings.passenger = settings.passenger === name ? "" : name; // tap again to deselect
        save(LS_SETTINGS, settings);
        renderPassengers();
      }));
  }

  // ---------- UI plumbing ----------
  function openModal(id) { closeModals(); $(id).hidden = false; }
  function closeModals() { document.querySelectorAll(".modal").forEach((m) => (m.hidden = true)); }

  let toastTimer = null;
  function toast(msg) {
    const el = $("toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  let audio = null;
  function beep(freqs) {
    if (!settings.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      freqs.forEach((f, i) => {
        const o = audio.createOscillator(), g = audio.createGain();
        const t0 = audio.currentTime + i * 0.16;
        o.type = "square"; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.14);
        o.connect(g).connect(audio.destination);
        o.start(t0); o.stop(t0 + 0.15);
      });
    } catch { /* no audio, no problem */ }
  }

  async function requestWakeLock() {
    try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch { /* optional */ }
  }
  function releaseWakeLock() { try { wakeLock && wakeLock.release(); } catch { /* ignore */ } wakeLock = null; }

  $("startBtn").addEventListener("click", start);
  $("pauseBtn").addEventListener("click", pause);
  $("stopBtn").addEventListener("click", stop);
  $("newTripBtn").addEventListener("click", newTrip);
  $("settingsBtn").addEventListener("click", openSettings);
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("historyBtn").addEventListener("click", showHistory);
  $("resetRatesBtn").addEventListener("click", () => {
    $("setBase").value = OFFICIAL.baseFee; $("setKm").value = OFFICIAL.kmFee; $("setMin").value = OFFICIAL.minFee; updateHint();
  });
  $("clearHistoryBtn").addEventListener("click", () => {
    if (!confirm("Biztosan elengeded a család összes tartozását? Ez nem visszavonható!")) return;
    history = []; save(LS_HISTORY, history); closeModals(); render(); toast("Apa nagylelkű volt. Ezúttal.");
  });
  ["setKm", "setMin"].forEach((id) => $(id).addEventListener("input", updateHint));
  document.querySelectorAll("[data-close]").forEach((el) => el.addEventListener("click", closeModals));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && trip.status === "running") requestWakeLock();
  });

  // ?demo=1 in the URL turns on demo mode
  const qs = new URLSearchParams(location.search);
  if (qs.has("demo")) { settings.demo = qs.get("demo") !== "0"; save(LS_SETTINGS, settings); }

  // A page reload mid-trip resumes the meter; the gap counts as waiting time.
  if (trip.status === "running") requestWakeLock();
  startGps();
  renderPassengers();
  render();
  setInterval(tick, 250);
})();
