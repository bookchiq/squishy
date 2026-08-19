// squishy front-end — intention picker -> gentle, budgeted playback -> warm end.
// Static and keyless: it only reads videos.json (built offline) and plays via the
// YouTube IFrame Player API. All video-derived text is inserted via textContent /
// safe attributes — never innerHTML — so a crafted title cannot execute.

import {
  sessionFor,
  buildPool,
  buildReportTarget,
  nextStep,
  TOP_UP_SECONDS,
  pruneSeen,
  addSeen,
} from './lib/selection.mjs';

// --- Maintainer config -------------------------------------------------------
// EDIT THIS: where "Report this video" emails go. Reported IDs get hand-added to
// config/blocklist.json.
const MAINTAINER_EMAIL = 'you@example.com';
// ----------------------------------------------------------------------------

const YT_API_TIMEOUT_MS = 8000; // how long to wait for the IFrame API before giving up
const VIDEO_START_WATCHDOG_MS = 12000; // skip a video that never starts playing
const SEEN_KEY = 'squishy:seen:v1'; // localStorage key for the "already watched" store
const LIKED_KEY = 'squishy:liked:v1'; // localStorage key for videos this browser 👍'd
const REPORTED_KEY = 'squishy:reported:v1'; // localStorage key for videos this browser reported

const els = {
  picker: document.getElementById('picker'),
  pickerNote: document.getElementById('picker-note'),
  playerScreen: document.getElementById('player-screen'),
  playerFrame: document.querySelector('#player-screen .player-frame'),
  nowPlaying: document.getElementById('now-playing'),
  likeBtn: document.getElementById('like-btn'),
  skipBtn: document.getElementById('skip-btn'),
  reportBtn: document.getElementById('report-btn'),
  quitBtn: document.getElementById('quit-btn'),
  endScreen: document.getElementById('end-screen'),
  moreBtn: document.getElementById('more-btn'),
  restartBtn: document.getElementById('restart-btn'),
  livecamsScreen: document.getElementById('livecams-screen'),
  livecamsList: document.getElementById('livecams-list'),
  livecamsToggle: document.getElementById('livecams-toggle'),
  feedStatus: document.getElementById('feed-status'),
};

const state = {
  videos: [],
  session: null,
  pool: [],
  index: 0,
  cumulativeSeconds: 0,
  player: null,
  watchdog: null,
  seenEntries: [], // [{ id, ts }] persisted in localStorage
  seenIds: new Set(),
  voteEndpoint: '', // vote worker URL, from vote-config.json ('' = voting off)
  likedIds: new Set(), // videos this browser has 👍'd
  reportedIds: new Set(), // videos this browser has reported
};

function loadReported() {
  try {
    const raw = localStorage.getItem(REPORTED_KEY);
    state.reportedIds = new Set(raw ? JSON.parse(raw) : []);
  } catch {
    state.reportedIds = new Set();
  }
}

function persistReported() {
  try {
    localStorage.setItem(REPORTED_KEY, JSON.stringify([...state.reportedIds]));
  } catch {
    /* storage unavailable */
  }
}

function updateReportButton(video) {
  const reported = video && state.reportedIds.has(video.id);
  els.reportBtn.textContent = reported ? 'Reported ✓' : 'Report this video';
  els.reportBtn.disabled = !!reported;
}

// Report a video for the maintainer to review. Prefers the worker's /report route
// (no email exposed); falls back to a mailto when no endpoint is configured.
function report() {
  const video = currentVideo();
  if (!video || state.reportedIds.has(video.id)) return;

  if (!state.voteEndpoint) {
    window.location.href = buildReportTarget(video, MAINTAINER_EMAIL).mailto;
    return;
  }

  state.reportedIds.add(video.id);
  persistReported();
  updateReportButton(video);
  fetch(`${state.voteEndpoint}/report`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId: video.id, title: video.title }),
  }).catch(() => {
    /* network hiccup — still remembered locally */
  });
}

// --- 👍 voting ---------------------------------------------------------------
async function loadVoteConfig() {
  try {
    const res = await fetch('vote-config.json', { cache: 'no-cache' });
    if (res.ok) {
      const cfg = await res.json();
      state.voteEndpoint = String(cfg.endpoint || '').trim().replace(/\/$/, '');
    }
  } catch {
    /* no config — voting stays off */
  }
}

function loadLiked() {
  try {
    const raw = localStorage.getItem(LIKED_KEY);
    state.likedIds = new Set(raw ? JSON.parse(raw) : []);
  } catch {
    state.likedIds = new Set();
  }
}

function persistLiked() {
  try {
    localStorage.setItem(LIKED_KEY, JSON.stringify([...state.likedIds]));
  } catch {
    /* storage unavailable — keep in-memory for this page session */
  }
}

function updateLikeButton(video) {
  if (!state.voteEndpoint) {
    els.likeBtn.hidden = true;
    return;
  }
  els.likeBtn.hidden = false;
  const liked = video && state.likedIds.has(video.id);
  els.likeBtn.textContent = liked ? '👍 Liked' : '👍 Like';
  els.likeBtn.disabled = !!liked;
  els.likeBtn.classList.toggle('is-liked', !!liked);
}

function like() {
  const video = currentVideo();
  if (!video || !state.voteEndpoint || state.likedIds.has(video.id)) return;
  // Optimistic: mark liked immediately; the POST is fire-and-forget.
  state.likedIds.add(video.id);
  persistLiked();
  updateLikeButton(video);
  fetch(`${state.voteEndpoint}/vote`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ videoId: video.id }),
  }).catch(() => {
    /* network hiccup — the like is still remembered locally; scores rebuild daily */
  });
}

// --- "Already watched" memory (localStorage) --------------------------------
function loadSeen() {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const entries = raw ? JSON.parse(raw) : [];
    state.seenEntries = pruneSeen(entries, { now: Date.now() });
  } catch {
    state.seenEntries = []; // private mode / disabled storage — degrade to in-memory
  }
  state.seenIds = new Set(state.seenEntries.map((e) => e.id));
}

function markSeen(id) {
  if (!id || state.seenIds.has(id)) return;
  state.seenEntries = pruneSeen(addSeen(state.seenEntries, id, Date.now()), { now: Date.now() });
  state.seenIds = new Set(state.seenEntries.map((e) => e.id));
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(state.seenEntries));
  } catch {
    /* storage unavailable — keep the in-memory set for this page session */
  }
}

// --- YouTube IFrame API loader (with failure + timeout) ----------------------
let ytReadyResolve;
let ytReadyReject;
const ytReady = new Promise((resolve, reject) => {
  ytReadyResolve = resolve;
  ytReadyReject = reject;
});
window.onYouTubeIframeAPIReady = () => ytReadyResolve();

function loadYouTubeApi() {
  if (window.YT && window.YT.Player) {
    ytReadyResolve();
    return;
  }
  if (document.getElementById('yt-iframe-api')) return;
  const tag = document.createElement('script');
  tag.id = 'yt-iframe-api';
  tag.src = 'https://www.youtube.com/iframe_api';
  tag.onerror = () => ytReadyReject(new Error('Could not load the YouTube player script.'));
  document.head.appendChild(tag);
}

// Resolve when the API is ready, reject if it never loads — so a blocked/offline
// player degrades to a warm message instead of a permanent blank screen.
function ytReadyWithTimeout() {
  return Promise.race([
    ytReady,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('YouTube player timed out.')), YT_API_TIMEOUT_MS)
    ),
  ]);
}

// --- Feed loading ------------------------------------------------------------
async function loadFeed() {
  try {
    const res = await fetch('videos.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`videos.json ${res.status}`);
    const data = await res.json();
    state.videos = Array.isArray(data.videos) ? data.videos : [];
  } catch (err) {
    state.videos = [];
    console.warn('Could not load the feed:', err);
  }
}

// --- Screen helpers ----------------------------------------------------------
function show(screen) {
  els.picker.hidden = screen !== 'picker';
  els.playerScreen.hidden = screen !== 'player';
  els.endScreen.hidden = screen !== 'end';
}

function warmPickerNote(text) {
  show('picker');
  els.pickerNote.hidden = false;
  els.pickerNote.textContent = text;
}

// --- Session flow ------------------------------------------------------------
function beginPlayback() {
  loadYouTubeApi();
  ytReadyWithTimeout()
    .then(() => playCurrent())
    .catch((err) => {
      console.warn(err);
      warmPickerNote("We couldn't reach the video player just now — please try again in a moment. 🐾");
    });
}

function startSession(minutes) {
  const session = sessionFor(minutes);
  if (!session) return;
  state.session = session;
  state.pool = buildPool(state.videos, session.preference, Math.random, state.seenIds);
  state.index = 0;
  state.cumulativeSeconds = 0;

  if (state.pool.length === 0) {
    warmPickerNote('The feed is empty right now — check back soon, or run the build to fill it. 🐾');
    return;
  }

  els.pickerNote.hidden = true;
  show('player');
  beginPlayback();
}

function currentVideo() {
  return state.pool[state.index];
}

function playCurrent() {
  const video = currentVideo();
  if (!video) return endSession();

  // Update the "now playing" line and report link via safe DOM APIs.
  els.nowPlaying.textContent = `${video.title} · ${video.channel}`;
  updateReportButton(video);
  updateLikeButton(video);
  // Vertical Shorts get a portrait frame so they aren't letterboxed into 16:9.
  els.playerFrame.classList.toggle('portrait', video.orientation === 'portrait');

  armWatchdog();

  // One player instance, reused across videos AND sessions (loadVideoById). Never
  // re-construct — that would orphan the old player and its event handlers.
  if (!state.player) {
    state.player = new window.YT.Player('player', {
      videoId: video.id,
      playerVars: { autoplay: 1, rel: 0, modestbranding: 1, playsinline: 1 },
      events: {
        onStateChange: onPlayerStateChange,
        onError: onPlayerError,
      },
    });
  } else {
    state.player.loadVideoById(video.id);
  }
}

function armWatchdog() {
  clearWatchdog();
  // If the video never reaches PLAYING (autoplay blocked, endless buffering, an
  // interstitial), skip it rather than stalling the session on a dead frame.
  state.watchdog = setTimeout(() => advance(), VIDEO_START_WATCHDOG_MS);
}

function clearWatchdog() {
  if (state.watchdog) {
    clearTimeout(state.watchdog);
    state.watchdog = null;
  }
}

function onPlayerStateChange(event) {
  const YTP = window.YT.PlayerState;
  if (event.data === YTP.PLAYING) {
    clearWatchdog(); // it started — stand the watchdog down
    markSeen(currentVideo()?.id); // remember it so we don't replay it
    return;
  }
  if (event.data === YTP.ENDED) {
    clearWatchdog();
    const step = nextStep(
      {
        index: state.index,
        cumulativeSeconds: state.cumulativeSeconds,
        poolLength: state.pool.length,
        budgetSeconds: state.session.budgetSeconds,
      },
      currentVideo()?.durationSeconds
    );
    state.index = step.index;
    state.cumulativeSeconds = step.cumulativeSeconds;
    if (step.action === 'end') endSession();
    else playCurrent();
  }
}

// A non-embeddable or unavailable video errors instead of firing ENDED — skip it.
// Errored videos do not count against the watch budget.
function onPlayerError() {
  advance();
}

// User skip: credit only the time actually watched (not the full duration), then
// move on — so skipping something that isn't for you doesn't burn your budget.
function skip() {
  const watched = Math.floor(state.player?.getCurrentTime?.() || 0);
  const step = nextStep(
    {
      index: state.index,
      cumulativeSeconds: state.cumulativeSeconds,
      poolLength: state.pool.length,
      budgetSeconds: state.session.budgetSeconds,
    },
    watched
  );
  state.index = step.index;
  state.cumulativeSeconds = step.cumulativeSeconds;
  clearWatchdog();
  if (step.action === 'end') endSession();
  else playCurrent();
}

function advance() {
  clearWatchdog();
  state.index += 1;
  if (state.index >= state.pool.length) return endSession();
  playCurrent();
}

function endSession() {
  clearWatchdog();
  try {
    state.player?.stopVideo?.();
  } catch {
    /* ignore */
  }
  show('end');
}

function aFewMore() {
  // Fresh short pool with a small BOUNDED top-up budget — not another full session.
  state.session = { ...state.session, budgetSeconds: TOP_UP_SECONDS };
  state.pool = buildPool(state.videos, ['short'], Math.random, state.seenIds);
  state.index = 0;
  state.cumulativeSeconds = 0;
  if (state.pool.length === 0) return endSession();
  show('player');
  beginPlayback();
}

// --- Live cams (optional) ----------------------------------------------------
async function loadLiveCams() {
  try {
    const res = await fetch('livecams.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const data = await res.json();
    const list = Array.isArray(data.livecams) ? data.livecams : [];
    // Drop unset placeholders so the section only shows real streams.
    return list.filter((c) => c && typeof c.id === 'string' && !c.id.startsWith('REPLACE_ME'));
  } catch {
    return [];
  }
}

function renderLiveCams(cams) {
  els.livecamsList.replaceChildren();
  for (const cam of cams) {
    const figure = document.createElement('figure');
    figure.className = 'livecam';

    const frame = document.createElement('div');
    frame.className = 'player-frame';
    const iframe = document.createElement('iframe');
    iframe.src = `https://www.youtube.com/embed/${encodeURIComponent(cam.id)}`;
    iframe.title = cam.label || 'Live cam';
    iframe.allow = 'encrypted-media; picture-in-picture';
    iframe.allowFullscreen = true;
    frame.appendChild(iframe);

    const caption = document.createElement('figcaption');
    caption.textContent = cam.label || 'Live cam'; // safe: text, not markup

    figure.append(frame, caption);
    els.livecamsList.appendChild(figure);
  }
}

// --- Wire up -----------------------------------------------------------------
function init() {
  loadSeen();
  loadLiked();
  loadReported();
  loadVoteConfig();
  for (const btn of document.querySelectorAll('.choice[data-minutes]')) {
    btn.addEventListener('click', () => startSession(Number(btn.dataset.minutes)));
  }
  els.likeBtn.addEventListener('click', like);
  els.skipBtn.addEventListener('click', skip);
  els.reportBtn.addEventListener('click', report);
  els.quitBtn.addEventListener('click', endSession);
  els.moreBtn.addEventListener('click', aFewMore);
  els.restartBtn.addEventListener('click', () => {
    els.pickerNote.hidden = true;
    show('picker');
  });

  els.livecamsToggle.addEventListener('click', () => {
    els.livecamsScreen.hidden = !els.livecamsScreen.hidden;
  });

  loadFeed().then(() => {
    if (state.videos.length === 0) {
      els.feedStatus.textContent = 'The feed is empty right now. 🐾';
    }
  });

  loadLiveCams().then((cams) => {
    if (cams.length > 0) {
      renderLiveCams(cams);
      els.livecamsToggle.hidden = false;
    }
  });
}

init();
