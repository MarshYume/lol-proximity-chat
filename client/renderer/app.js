const { ipcRenderer } = require('electron');
const io = require('socket.io-client');

// ── Configuration ─────────────────────────────────────────────
const SERVER_URL = 'http://localhost:3000';

// Portées de proximité en unités LoL (~14 800u = largeur totale de la map)
const ALLY_MAX_RANGE  = 3000; // alliés audibles jusqu'à ~20% de la map
const ENEMY_MAX_RANGE =  800; // ennemis audibles uniquement au corps-à-corps

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

// ── État global ───────────────────────────────────────────────
let socket       = null;
let localStream  = null;
let audioContext = null;
let myName       = '';
let myTeam       = null;
let myPosition   = null;
let isMuted      = false;

// socketId → RTCPeerConnection
const peerConnections = {};
// socketId → { gainNode, name, team }
const peers = {};

// ── Éléments UI ───────────────────────────────────────────────
const lolStatus    = document.getElementById('lol-status');
const joinPanel    = document.getElementById('join-panel');
const roomPanel    = document.getElementById('room-panel');
const summonerInput = document.getElementById('summoner-name');
const roomCodeInput = document.getElementById('room-code');
const btnJoin      = document.getElementById('btn-join');
const btnMute      = document.getElementById('btn-mute');
const btnLeave     = document.getElementById('btn-leave');
const roomLabel    = document.getElementById('room-label');
const playerList   = document.getElementById('player-list');

// ── LoL Live Client API ───────────────────────────────────────
ipcRenderer.on('lol-data', (_, gameData) => {
  lolStatus.textContent = '● LoL Running';
  lolStatus.className   = 'status online';

  if (!myName || !socket?.connected) return;

  // Trouve le joueur local dans la liste des 10 joueurs
  const me = gameData.allPlayers?.find(p => p.summonerName === myName);
  if (!me) return;

  // NOTE : allPlayers[i].position est normalement un objet {x, y, z}
  // représentant les coordonnées sur la carte LoL (vérifié dans l'API locale).
  // Si tu vois une chaîne ("TOP", "MID"...) c'est que Riot a changé le schéma —
  // dans ce cas il faudra trouver le bon champ dans la réponse JSON brute.
  if (me.position && typeof me.position === 'object') {
    myPosition = me.position;
    myTeam     = me.team; // "ORDER" (bleus) ou "CHAOS" (rouges)
    socket.emit('position-update', { position: myPosition, team: myTeam });
  }
});

ipcRenderer.on('lol-offline', () => {
  lolStatus.textContent = '● LoL Offline';
  lolStatus.className   = 'status offline';
});

// ── Calcul de proximité ───────────────────────────────────────
function getDistance(pos1, pos2) {
  const dx = pos1.x - pos2.x;
  const dz = pos1.z - pos2.z; // axe profondeur de la map (on ignore Y = hauteur)
  return Math.sqrt(dx * dx + dz * dz);
}

function calculateVolume(targetTeam, targetPosition) {
  if (!myPosition || !targetPosition || !myTeam) return 0;
  const isAlly   = targetTeam === myTeam;
  const maxRange = isAlly ? ALLY_MAX_RANGE : ENEMY_MAX_RANGE;
  const dist     = getDistance(myPosition, targetPosition);
  if (dist >= maxRange) return 0;
  return Math.max(0, 1 - dist / maxRange);
}

// ── Audio ─────────────────────────────────────────────────────
async function initAudio() {
  localStream  = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  audioContext = new AudioContext();
}

function setupRemoteAudio(socketId, remoteStream) {
  const source   = audioContext.createMediaStreamSource(remoteStream);
  const gainNode = audioContext.createGain();
  gainNode.gain.value = 0; // muet par défaut jusqu'à la 1ère mise à jour de position
  source.connect(gainNode);
  gainNode.connect(audioContext.destination);

  if (!peers[socketId]) peers[socketId] = {};
  peers[socketId].gainNode = gainNode;
}

function updateAllVolumes(positions) {
  Object.entries(peers).forEach(([id, peer]) => {
    if (!peer.gainNode) return;
    const data = positions[id];
    const vol  = data ? calculateVolume(data.team, data.position) : 0;

    // Transition douce (100 ms) pour éviter les artefacts audio
    peer.gainNode.gain.linearRampToValueAtTime(vol, audioContext.currentTime + 0.1);

    if (data) {
      peers[id].team = data.team;
      updatePlayerUI(id, data.name, data.team, vol);
    }
  });
}

// ── WebRTC (natif, sans dépendance externe) ───────────────────
async function createPeerConnection(targetId, initiator) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  peerConnections[targetId] = pc;
  if (!peers[targetId]) peers[targetId] = {};

  // Ajoute les pistes audio locales
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // Relais des candidats ICE via le serveur
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('signal', {
        targetId,
        signal: { type: 'candidate', candidate: candidate.toJSON() },
      });
    }
  };

  // Réception du flux audio distant
  pc.ontrack = ({ streams }) => {
    if (streams[0]) setupRemoteAudio(targetId, streams[0]);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      removePeer(targetId);
    }
  };

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('signal', { targetId, signal: { type: 'offer', sdp: offer.sdp } });
  }

  return pc;
}

async function handleSignal(fromId, signal) {
  try {
    if (signal.type === 'offer') {
      const pc = await createPeerConnection(fromId, false);
      await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { targetId: fromId, signal: { type: 'answer', sdp: answer.sdp } });

    } else if (signal.type === 'answer') {
      const pc = peerConnections[fromId];
      if (pc) await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });

    } else if (signal.type === 'candidate') {
      const pc = peerConnections[fromId];
      if (pc?.remoteDescription) {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      }
    }
  } catch (e) {
    console.error('Erreur WebRTC signal:', e);
  }
}

function removePeer(socketId) {
  peerConnections[socketId]?.close();
  delete peerConnections[socketId];
  delete peers[socketId];
  document.getElementById(`player-${socketId}`)?.remove();
}

// ── Socket.io ─────────────────────────────────────────────────
function connectSocket(roomCode, summonerName) {
  socket = io(SERVER_URL);

  socket.on('connect', () => {
    socket.emit('join-room', { roomCode, summonerName });
  });

  // Joueurs déjà dans la room → ils initieront les offres WebRTC vers nous
  socket.on('existing-players', (players) => {
    players.forEach(p => {
      peers[p.socketId] = { name: p.name };
      addPlayerToUI(p.socketId, p.name, null, 0);
    });
  });

  // Nouveau joueur → c'est nous qui initions la connexion WebRTC
  socket.on('player-joined', async ({ socketId, name }) => {
    peers[socketId] = { name };
    addPlayerToUI(socketId, name, null, 0);
    await createPeerConnection(socketId, true);
  });

  socket.on('signal', async ({ fromId, signal }) => {
    await handleSignal(fromId, signal);
  });

  socket.on('positions-update', (positions) => {
    updateAllVolumes(positions);
  });

  socket.on('player-left', ({ socketId }) => {
    removePeer(socketId);
  });

  socket.on('disconnect', () => {
    console.log('Déconnecté du serveur');
  });
}

// ── UI ────────────────────────────────────────────────────────
function addPlayerToUI(socketId, name, team, volume) {
  if (document.getElementById(`player-${socketId}`)) return;

  const teamClass = team === 'ORDER' ? 'blue' : team === 'CHAOS' ? 'red' : 'unknown';
  const div = document.createElement('div');
  div.className = 'player-item';
  div.id = `player-${socketId}`;
  div.innerHTML = `
    <span class="dot ${teamClass}" id="dot-${socketId}"></span>
    <span class="player-name">${name}</span>
    <span class="player-vol" id="vol-${socketId}">—</span>
  `;
  playerList.appendChild(div);
}

function updatePlayerUI(socketId, name, team, volume) {
  if (!document.getElementById(`player-${socketId}`)) {
    addPlayerToUI(socketId, name, team, volume);
  }
  const dot = document.getElementById(`dot-${socketId}`);
  const vol = document.getElementById(`vol-${socketId}`);
  if (dot) dot.className = `dot ${team === 'ORDER' ? 'blue' : 'red'}`;
  if (vol) vol.textContent = volume > 0 ? `${Math.round(volume * 100)}%` : '—';
}

// ── Événements boutons ────────────────────────────────────────
btnJoin.addEventListener('click', async () => {
  const name = summonerInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  if (!name || !code) return;

  myName = name;

  try {
    await initAudio();
    connectSocket(code, name);
    joinPanel.classList.add('hidden');
    roomPanel.classList.remove('hidden');
    roomLabel.textContent = code;
  } catch (e) {
    alert('Accès au microphone refusé. Autorise le micro et relance l\'app.');
  }
});

btnMute.addEventListener('click', () => {
  isMuted = !isMuted;
  localStream?.getAudioTracks().forEach(t => (t.enabled = !isMuted));
  btnMute.textContent      = isMuted ? '🔇' : '🎤';
  btnMute.style.background = isMuted ? '#555' : '';
});

btnLeave.addEventListener('click', () => {
  socket?.disconnect();
  Object.keys(peerConnections).forEach(removePeer);
  playerList.innerHTML = '';
  joinPanel.classList.remove('hidden');
  roomPanel.classList.add('hidden');
  myName = myTeam = myPosition = null;
});
