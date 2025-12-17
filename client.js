/* Version: #6 */
// === KONFIGURASJON & TILSTAND ===
let peer = null;
let conn = null;
let myPlayerName = "";
let currentScenarioId = null; // For å unngå dobbeltstemmer (valgfritt, men lurt)

// === DOM ELEMENTER ===
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
    choicesContainer: document.getElementById('choices-container'),
    voteStatus: document.getElementById('vote-status'),
    
    debugLog: document.getElementById('debug-log')
};

// === HJELPEFUNKSJONER ===

function log(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[CLIENT] ${msg}`);
    
    if (ui.debugLog) {
        const entry = document.createElement('div');
        entry.textContent = `[${timestamp}] ${msg}`;
        if (type === 'error') entry.style.color = '#ff4444';
        ui.debugLog.appendChild(entry);
        ui.debugLog.scrollTop = ui.debugLog.scrollHeight;
    }
}

function showPanel(panelName) {
    ui.loginPanel.classList.add('hidden');
    ui.waitingPanel.classList.add('hidden');
    ui.gamePanel.classList.add('hidden');
    
    if (panelName === 'login') ui.loginPanel.classList.remove('hidden');
    if (panelName === 'waiting') ui.waitingPanel.classList.remove('hidden');
    if (panelName === 'game') ui.gamePanel.classList.remove('hidden');
}

function setStatus(status) {
    if (status === 'connected') {
        ui.statusDot.className = 'status-indicator status-connected';
        ui.statusText.textContent = 'Tilkoblet';
    } else if (status === 'connecting') {
        ui.statusDot.className = 'status-indicator status-connecting';
        ui.statusText.textContent = 'Kobler til...';
    } else {
        ui.statusDot.className = 'status-indicator status-disconnected';
        ui.statusText.textContent = 'Frakoblet';
    }
}

// === PEERJS LOGIKK ===

function joinGame() {
    const name = ui.inputName.value.trim();
    const roomCode = ui.inputRoomCode.value.trim().toUpperCase();

    if (!name || !roomCode) {
        alert("Du må skrive både navn og romkode.");
        return;
    }
    
    if (roomCode.length !== 4) {
        alert("Romkoden skal være 4 bokstaver.");
        return;
    }

    myPlayerName = name;
    ui.btnJoin.disabled = true;
    ui.btnJoin.textContent = "Kobler til...";
    setStatus('connecting');

    // Vi trenger ikke en spesifikk ID for klienten, så vi lar PeerJS generere en.
    peer = new Peer({
        debug: 1
    });

    peer.on('open', (id) => {
        log(`Min Peer ID er: ${id}`);
        connectToHost(roomCode);
    });

    peer.on('error', (err) => {
        log(`Peer Feil: ${err.type}`, 'error');
        alert(`Kunne ikke starte peer: ${err.type}`);
        resetLogin();
    });
}

function connectToHost(hostId) {
    log(`Prøver å koble til Host: ${hostId}...`);
    
    // Vi sender med navnet i metadata med en gang
    conn = peer.connect(hostId, {
        metadata: { name: myPlayerName },
        serialization: 'json'
    });

    conn.on('open', () => {
        log("Tilkobling til Host vellykket!", 'success');
        setStatus('connected');
        showPanel('waiting');
    });

    conn.on('data', (data) => {
        handleDataFromHost(data);
    });

    conn.on('close', () => {
        log("Host koblet fra (eller forbindelsen brutt).", 'error');
        setStatus('disconnected');
        alert("Mistet kontakten med Host.");
        showPanel('login');
        resetLogin();
    });
    
    conn.on('error', (err) => {
        log(`Connection Error: ${err}`, 'error');
    });
    
    // Timeout-hack: Hvis 'open' ikke fyres av innen 5 sekunder, anta feil ID
    setTimeout(() => {
        if (!conn.open) {
            log("Tidsavbrudd ved tilkobling. Sjekk romkoden.", 'error');
            // Vi lukker ikke automatisk her, for noen ganger tar WebRTC tid, 
            // men vi gir brukeren beskjed i loggen.
        }
    }, 5000);
}

function resetLogin() {
    ui.btnJoin.disabled = false;
    ui.btnJoin.textContent = "Koble til";
    if (peer) {
        peer.destroy();
        peer = null;
    }
    conn = null;
}

// === SPILL LOGIKK ===

function handleDataFromHost(msg) {
    log(`Mottok data: ${msg.type}`);
    
    if (msg.type === 'SCENARIO') {
        renderScenario(msg.data);
    } else if (msg.type === 'VOTE_LOCKED') {
        // Deaktiver knapper hvis vi vil være strenge, 
        // men host.js ignorerer sene stemmer uansett.
        disableVotingButtons();
        ui.voteStatus.textContent = "Stemming avsluttet";
        ui.voteStatus.style.opacity = 1;
    }
}

function renderScenario(scenario) {
    // Vis spillpanelet
    showPanel('game');
    
    // Nullstill UI
    ui.choicesContainer.innerHTML = '';
    ui.voteStatus.style.opacity = 0;
    
    // Vis tekst (parse markdown)
    ui.scenarioText.innerHTML = marked.parse(scenario.narrative);
    
    // Generer knapper
    if (scenario.choices && scenario.choices.length > 0) {
        scenario.choices.forEach(choice => {
            const btn = document.createElement('button');
            btn.className = 'btn choice-btn';
            btn.innerHTML = `<strong>${choice.id}:</strong> ${choice.text}`;
            
            btn.addEventListener('click', () => {
                sendVote(choice.id);
                
                // Visuell feedback
                document.querySelectorAll('.choice-btn').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
            });
            
            ui.choicesContainer.appendChild(btn);
        });
    } else {
        ui.choicesContainer.innerHTML = '<p>Ingen valg tilgjengelig.</p>';
    }
}

function sendVote(choiceId) {
    if (!conn || !conn.open) {
        alert("Ingen forbindelse til Host!");
        return;
    }
    
    log(`Sender stemme: ${choiceId}`);
    
    conn.send({
        type: 'VOTE',
        choiceId: choiceId,
        playerName: myPlayerName
    });
    
    // Gi feedback til bruker
    ui.voteStatus.textContent = "Stemme registrert!";
    ui.voteStatus.style.opacity = 1;
}

function disableVotingButtons() {
    const btns = document.querySelectorAll('.choice-btn');
    btns.forEach(b => b.disabled = true);
}

// === EVENT LISTENERS ===

document.addEventListener('DOMContentLoaded', () => {
    
    if (ui.btnJoin) {
        ui.btnJoin.addEventListener('click', joinGame);
    }
    
    // Støtte for å trykke Enter i inputfeltene
    if (ui.inputRoomCode) {
        ui.inputRoomCode.addEventListener('keyup', (e) => {
            if (e.key === 'Enter') joinGame();
        });
    }
    
    log("client.js initialisert.");
});
/* Version: #6 */
