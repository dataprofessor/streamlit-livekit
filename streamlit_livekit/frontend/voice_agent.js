// voice_agent: a Streamlit components v2 component for talking to a LiveKit agent.
//
// Python passes { url, token, identity } in `data`. The browser joins the room,
// publishes the microphone, plays the agent's audio, shows audio meters and a
// live transcript, and reports back to Python:
//   - state value "connection_state": "idle" | "connecting" | "connected" | "ended"
//   - state value "transcript": [{ role: "user" | "agent", text }], final lines only
//   - trigger "new_conversation": the user wants a fresh room and token
//
// Streamlit calls the default export again whenever `data` changes, without
// remounting, so the room and DOM are kept per mount in `instances`.

const LIVEKIT_CLIENT_URL = "https://cdn.jsdelivr.net/npm/livekit-client@2.24.1/+esm";
let livekitModule = null;
const loadLiveKit = () => (livekitModule ??= import(LIVEKIT_CLIENT_URL));

const BAR_COUNT = 24;
const instances = new WeakMap();

export default function (component) {
  const { parentElement, data } = component;
  let instance = instances.get(parentElement);
  if (!instance) {
    instance = createInstance(parentElement);
    instances.set(parentElement, instance);
  }
  instance.component = component; // latest setStateValue / setTriggerValue
  if (instance.token !== data.token) instance.load(data);
  return instance.destroy;
}

function createInstance(root) {
  const $ = (selector) => root.querySelector(selector);
  const host = root.host || root;
  const els = {
    toggle: $(".toggle"),
    mute: $(".mute"),
    status: $(".status"),
    transcript: $(".transcript"),
    userState: $(".meter.user .state"),
    agentState: $(".meter.agent .state"),
    canvases: { user: $(".meter.user canvas"), agent: $(".meter.agent canvas") },
  };

  const self = {
    component: null,
    token: null,
    conn: null,
    room: null,
    ended: false,
    autoStart: false,
    segments: new Map(), // segment id -> message element
    finals: new Map(), // segment id -> { role, text }, final lines only
    reported: {},
    audioCtx: null,
    analysers: { user: null, agent: null },
    rafId: 0,
  };

  const setStatus = (text) => (els.status.textContent = text);

  // Send a state value to Python, skipping repeats so we don't cause extra reruns
  function report(key, value) {
    const json = JSON.stringify(value);
    if (self.reported[key] === json) return;
    self.reported[key] = json;
    self.component.setStateValue(key, value);
  }

  // ---- Transcript ---------------------------------------------------------
  function upsertMessage(segmentId, role, text) {
    let el = self.segments.get(segmentId);
    if (!el) {
      el = document.createElement("div");
      el.className = `msg ${role}`;
      el.innerHTML = '<span class="who"></span><span class="text"></span>';
      el.querySelector(".who").textContent = role === "agent" ? "Agent:" : "You:";
      els.transcript.appendChild(el);
      self.segments.set(segmentId, el);
    }
    el.querySelector(".text").textContent = text;
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }

  // ---- Audio meters -------------------------------------------------------
  // Each side's audio track feeds a Web Audio AnalyserNode. The bars show the
  // energy in voice frequencies (about 90 Hz to 4.5 kHz), redrawn every frame.
  function attachAnalyser(side, mediaStreamTrack) {
    if (!self.audioCtx || !mediaStreamTrack) return;
    detachAnalyser(side);
    const source = self.audioCtx.createMediaStreamSource(new MediaStream([mediaStreamTrack]));
    const analyser = self.audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.75;
    source.connect(analyser); // analysis only; playback goes through the <audio> element
    self.analysers[side] = { source, analyser, data: new Uint8Array(analyser.frequencyBinCount) };
  }

  function detachAnalyser(side) {
    if (self.analysers[side]) self.analysers[side].source.disconnect();
    self.analysers[side] = null;
  }

  function bandLevels(side) {
    const levels = new Array(BAR_COUNT).fill(0);
    const a = self.analysers[side];
    if (!a) return levels;
    a.analyser.getByteFrequencyData(a.data);
    const binHz = self.audioCtx.sampleRate / a.analyser.fftSize;
    const lo = Math.max(1, Math.round(90 / binHz));
    const hi = Math.min(a.data.length, Math.round(4500 / binHz));
    const perBar = Math.max(1, Math.floor((hi - lo) / BAR_COUNT));
    for (let i = 0; i < BAR_COUNT; i++) {
      let sum = 0;
      for (let j = 0; j < perBar; j++) sum += a.data[lo + i * perBar + j] || 0;
      levels[i] = sum / perBar / 255;
    }
    return levels;
  }

  function drawBars(side, color) {
    const canvas = els.canvases[side];
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = color;
    const levels = bandLevels(side);
    const gap = 3;
    const barW = (w - gap * (BAR_COUNT - 1)) / BAR_COUNT;
    if (barW <= 0) return; // too narrow to draw, e.g. while the page is laying out
    for (let i = 0; i < BAR_COUNT; i++) {
      const level = levels[i];
      const barH = Math.max(3, Math.pow(level, 1.4) * h); // curve so quiet noise stays low
      ctx.globalAlpha = 0.25 + 0.75 * Math.min(1, level * 1.5);
      ctx.beginPath();
      ctx.roundRect(i * (barW + gap), (h - barH) / 2, barW, barH, Math.min(barW / 2, 3));
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function renderLoop() {
    // Theme colors are read each frame, so a theme switch shows up immediately
    const style = getComputedStyle(host);
    drawBars("user", style.getPropertyValue("--st-blue-color").trim() || "#3b82f6");
    drawBars("agent", style.getPropertyValue("--st-primary-color").trim() || "#ff4b4b");
    self.rafId = requestAnimationFrame(renderLoop);
  }

  // ---- Connection ---------------------------------------------------------
  function resetUi() {
    self.ended = false;
    self.segments.clear();
    self.finals.clear();
    els.transcript.replaceChildren();
    els.toggle.textContent = "Start conversation";
    els.toggle.disabled = false;
    els.mute.textContent = "Mute";
    els.mute.disabled = true;
    els.userState.textContent = "";
    els.agentState.textContent = "";
    setStatus("Not connected");
    detachAnalyser("user");
    detachAnalyser("agent");
  }

  function showEnded(reason, DisconnectReason) {
    const why = DisconnectReason[reason];
    setStatus(
      why === "CLIENT_INITIATED" || !why
        ? "Conversation ended."
        : `Disconnected (${why.toLowerCase().replace(/_/g, " ")}).`
    );
    detachAnalyser("user");
    detachAnalyser("agent");
    els.userState.textContent = "";
    els.agentState.textContent = "";
    els.mute.textContent = "Mute";
    els.mute.disabled = true;
    // Each token starts one conversation; the next one needs a new token from Python
    self.ended = true;
    els.toggle.textContent = "New conversation";
    els.toggle.disabled = false;
    report("connection_state", "ended");
  }

  async function connect() {
    els.toggle.disabled = true;
    setStatus("Connecting...");
    report("connection_state", "connecting");

    let LK;
    try {
      LK = await loadLiveKit();
    } catch (err) {
      console.error(err);
      setStatus("Could not load the LiveKit client. Check your network connection.");
      els.toggle.disabled = false;
      report("connection_state", "idle");
      return;
    }
    const { Room, RoomEvent, Track, DisconnectReason } = LK;

    // Created inside the click, so the browser lets audio start
    self.audioCtx ??= new AudioContext();
    try {
      await self.audioCtx.resume();
    } catch (err) {
      console.warn(err);
    }

    const room = new Room({ adaptiveStream: true, dynacast: true });
    self.room = room;

    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.style.display = "none";
      root.appendChild(el);
      if (participant.isAgent) attachAnalyser("agent", track.mediaStreamTrack);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track, pub, participant) => {
      track.detach().forEach((el) => el.remove());
      if (participant.isAgent) detachAnalyser("agent");
    });
    room.on(RoomEvent.LocalTrackPublished, (pub) => {
      if (!pub.track || pub.track.kind !== Track.Kind.Audio) return;
      attachAnalyser("user", pub.track.mediaStreamTrack);
      els.userState.textContent = "live";
      // The browser may swap the underlying track, e.g. after a device change
      pub.track.on("restarted", () => attachAnalyser("user", pub.track.mediaStreamTrack));
    });

    // The agent publishes its state (listening, thinking, speaking) as an attribute
    const showAgentState = (p) => {
      if (p.isAgent) els.agentState.textContent = p.attributes["lk.agent.state"] || "";
    };
    room.on(RoomEvent.ParticipantAttributesChanged, (changed, p) => showAgentState(p));
    room.on(RoomEvent.ParticipantConnected, (p) => {
      showAgentState(p);
      if (p.isAgent && !els.status.textContent.startsWith("Microphone")) {
        setStatus("Agent joined. Start talking.");
      }
    });
    room.on(RoomEvent.Disconnected, (reason) => showEnded(reason, DisconnectReason));

    // Live transcripts of both sides, sent by the agent on the lk.transcription topic
    room.registerTextStreamHandler("lk.transcription", async (reader, participantInfo) => {
      const attrs = reader.info.attributes || {};
      const segmentId = attrs["lk.segment_id"] || reader.info.id;
      const role = participantInfo.identity === self.conn.identity ? "user" : "agent";
      let text = "";
      try {
        for await (const chunk of reader) {
          text += chunk;
          upsertMessage(segmentId, role, text);
        }
      } catch (err) {
        console.error("Failed to read transcription stream:", err);
        return;
      }
      // Only final lines go to Python, to avoid a rerun for every interim update.
      // The agent marks its own speech final on the stream's trailer, which
      // livekit-client merges into reader.info once the stream ends.
      const final = (reader.info.attributes || {})["lk.transcription_final"];
      if (final !== "false" && text.trim()) {
        self.finals.set(segmentId, { role, text: text.trim() });
        report("transcript", [...self.finals.values()]);
      }
    });

    try {
      await room.connect(self.conn.url, self.conn.token);
    } catch (err) {
      console.error(err);
      setStatus(`Could not connect: ${err.message}`);
      els.toggle.disabled = false;
      self.room = null;
      report("connection_state", "idle");
      return;
    }

    try {
      await room.startAudio();
    } catch (err) {
      console.warn(err);
    }
    report("connection_state", "connected");
    els.toggle.textContent = "End conversation";
    els.toggle.disabled = false;

    try {
      await room.localParticipant.setMicrophoneEnabled(true);
      els.mute.disabled = false;
    } catch (err) {
      // Stay connected so the agent can still be heard, but say why it can't hear you
      console.error(err);
      setStatus("Microphone blocked: allow mic access for this page and start a new conversation.");
      els.userState.textContent = "blocked";
      return;
    }
    const agentHere = [...room.remoteParticipants.values()].some((p) => p.isAgent);
    setStatus(agentHere ? "Agent joined. Start talking." : "Connected. Waiting for agent...");
  }

  async function leaveRoom() {
    const room = self.room;
    self.room = null;
    if (!room) return;
    room.removeAllListeners(); // replacing the conversation, so don't show "ended"
    await room.disconnect();
  }

  // ---- Controls -----------------------------------------------------------
  els.toggle.addEventListener("click", async () => {
    if (self.ended) {
      // Ask Python for a fresh room and token; connect as soon as they arrive
      self.autoStart = true;
      els.toggle.disabled = true;
      setStatus("Starting a new conversation...");
      self.component.setTriggerValue("new_conversation", true);
    } else if (self.room && self.room.state === "connected") {
      await self.room.disconnect();
    } else {
      await connect();
    }
  });

  els.mute.addEventListener("click", async () => {
    if (!self.room) return;
    const enabled = self.room.localParticipant.isMicrophoneEnabled;
    await self.room.localParticipant.setMicrophoneEnabled(!enabled);
    els.mute.textContent = enabled ? "Unmute" : "Mute";
    els.userState.textContent = enabled ? "muted" : "live";
  });

  // ---- Lifecycle ----------------------------------------------------------
  self.load = async (data) => {
    self.token = data.token;
    self.conn = data;
    await leaveRoom();
    resetUi();
    report("connection_state", "idle");
    report("transcript", []);
    if (self.autoStart) {
      self.autoStart = false;
      await connect();
    }
  };

  self.destroy = () => {
    cancelAnimationFrame(self.rafId);
    leaveRoom();
    self.audioCtx?.close();
    instances.delete(root);
  };

  renderLoop();
  return self;
}
