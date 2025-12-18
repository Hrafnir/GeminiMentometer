/* Version: #8 */
let peer = null;
let conn = null;
let myPlayerName = "";

const ui = {
    loginPanel: document.getElementById('login-panel'),
    waitingPanel: document.getElementById('waiting-panel'),
    gamePanel: document.getElementById('game-panel'),
    inputName: document.getElementById('player-name'),
    inputRoomCode: document.getElementById('room-code'),
    btnJoin: document.getElementById('btn-join'),
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text'),
    scenarioText: document.getElementById('scenario-text'),
    clientImageContainer: document.getElementById('client-image-container'),
    clientImage: document.getElementById('client-image'),
    choicesContainer: document.getElementById('choices-container'),
    voteStatus: document.getElementById('vote-status'),
    debugLog: document.getElementById('debug-log')
};

function log(msg, type = 'info') {
    const logEl = ui.debugLog;
    if (logEl) {
        const div = document.createElement('div');
        div.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        if (type === 'error') div.style.color = '#f44';
        logEl.appendChild(div);
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function showPanel(name) {
    ui.loginPanel.classList.add('hidden');
    ui.waitingPanel.classList.add('hidden');
    ui.gamePanel.classList.add('hidden');
    if (name === 'login') ui.loginPanel.classList.remove('hidden');
    if (name === 'waiting') ui.waitingPanel.classList.remove('hidden');
    if (name === 'game') ui.gamePanel.classList.remove('hidden');
}

function setStatus(s) {
    ui.statusDot.className = `status-indicator status-${s}`;
    ui.statusText.textContent = s === 'connected' ? 'Tilkoblet' : (s === 'connecting' ? 'Kobler til...' : 'Frakoblet');
}

function joinGame() {
    const name = ui.inputName.value.trim();
    const code = ui.inputRoomCode.value.trim().toUpperCase();
    if (!name || code.length !== 4) return alert("Sjekk navn og kode.");
    myPlayerName = name;
    ui.btnJoin.disabled = true;
    setStatus('connecting');
    peer = new Peer({ debug: 1 });
    peer.on('open', () => connectToHost(code));
    peer.on('error', (e) => { alert(e.type); ui.btnJoin.disabled = false; });
}

function connectToHost(hostId) {
    conn = peer.connect(hostId, { metadata: { name: myPlayerName } });
    conn.on('open', () => { setStatus('connected'); showPanel('waiting'); });
    conn.on('data', (msg) => {
        if (msg.type === 'SCENARIO') renderScenario(msg.data);
        if (msg.type === 'VOTE_LOCKED') {
            document.querySelectorAll('.choice-btn').forEach(b => b.disabled = true);
            ui.voteStatus.textContent = "Stemming avsluttet";
            ui.voteStatus.style.opacity = 1;
        }
    });
    conn.on('close', () => { setStatus('disconnected'); showPanel('login'); ui.btnJoin.disabled = false; });
}

function renderScenario(data) {
    showPanel('game');
    ui.choicesContainer.innerHTML = '';
    ui.voteStatus.style.opacity = 0;
    ui.scenarioText.innerHTML = marked.parse(data.narrative);
    
    // Vis bilde
    if (data.imageUrl) {
        ui.clientImage.src = data.imageUrl;
        ui.clientImageContainer.style.display = 'block';
    } else {
        ui.clientImageContainer.style.display = 'none';
    }

    if (data.choices) {
        data.choices.forEach(c => {
            const btn = document.createElement('button');
            btn.className = 'btn choice-btn';
            let html = `<strong>${c.id}:</strong> ${c.text}`;
            if (c.chance || c.effect) html += `<br><small style="color:#bbb">${c.chance || ''} ${c.effect || ''}</small>`;
            btn.innerHTML = html;
            btn.onclick = () => {
                conn.send({ type: 'VOTE', choiceId: c.id, playerName: myPlayerName });
                document.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                ui.voteStatus.textContent = "Stemme registrert!";
                ui.voteStatus.style.opacity = 1;
            };
            ui.choicesContainer.appendChild(btn);
        });
    }
}

document.addEventListener('DOMContentLoaded', () => {
    if (ui.btnJoin) ui.btnJoin.onclick = joinGame;
    if (ui.inputRoomCode) ui.inputRoomCode.onkeyup = (e) => { if(e.key==='Enter') joinGame(); };
});
/* Version: #8 */
