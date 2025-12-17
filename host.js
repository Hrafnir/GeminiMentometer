/* Version: #7 */
// === KONFIGURASJON & TILSTAND ===
let peer = null;
let myRoomId = null;
let connections = []; // Liste over aktive dataConnections
let apiKey = localStorage.getItem('gemini_api_key') || '';

// Spill-tilstand
let currentScenario = {
    narrative: "",
    choices: []
};
let currentVotes = {}; // Format: { "peerId": "A", "peerId2": "B" }
let isVotingOpen = false;

// Historikk for kontekst til Gemini (holder de siste par rundene)
let narrativeHistory = [];

// === DOM ELEMENTER ===
const ui = {
    setupPanel: document.getElementById('setup-panel'),
    lobbyPanel: document.getElementById('lobby-panel'),
    gamePanel: document.getElementById('game-panel'),
    resultsPanel: document.getElementById('results-panel'),
    
    apiKeyInput: document.getElementById('api-key'),
    btnStartHosting: document.getElementById('btn-start-hosting'),
    
    roomCodeDisplay: document.getElementById('room-code-display'),
    playerCount: document.getElementById('player-count'),
    playerList: document.getElementById('player-list'),
    
    scenarioContextInput: document.getElementById('scenario-context'),
    btnGenerate: document.getElementById('btn-generate'),
    
    currentNarrative: document.getElementById('current-narrative'),
    votingResults: document.getElementById('voting-results'),
    btnLockVoting: document.getElementById('btn-lock-voting'),
    
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text')
};

// === HJELPEFUNKSJONER ===

// Logg til skjerm og konsoll
function log(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[HOST] ${msg}`);
    
    const logEl = document.getElementById('debug-log');
    if (logEl) {
        const entry = document.createElement('div');
        entry.textContent = `[${timestamp}] ${msg}`;
        if (type === 'error') entry.style.color = '#ff4444';
        if (type === 'success') entry.style.color = '#00ff00';
        logEl.appendChild(entry);
        logEl.scrollTop = logEl.scrollHeight;
    }
}

// Generer tilfeldig 4-bokstavs ID (A-Z)
function generateShortId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // Fjernet I, O for lesbarhet
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

// Vis/Skjul paneler
function showPanel(panelName) {
    ui.setupPanel.classList.add('hidden');
    ui.lobbyPanel.classList.add('hidden');
    ui.gamePanel.classList.add('hidden');
    ui.resultsPanel.classList.add('hidden');
    
    if (panelName === 'setup') ui.setupPanel.classList.remove('hidden');
    if (panelName === 'lobby') {
        ui.lobbyPanel.classList.remove('hidden');
        ui.gamePanel.classList.remove('hidden'); // Viser også game controls
        ui.resultsPanel.classList.remove('hidden'); // Viser resultater
    }
}

// === PEERJS LOGIKK ===

function initializePeer() {
    const requestedId = generateShortId();
    log(`Forsøker å opprette rom med ID: ${requestedId}...`);

    // Vi bruker standard PeerJS server (gratis, offentlig). 
    // I en produksjonsapp ville vi kanskje hostet vår egen peer-server.
    peer = new Peer(requestedId, {
        debug: 1
    });

    peer.on('open', (id) => {
        myRoomId = id;
        log(`Server startet! Rom-ID: ${id}`, 'success');
        
        // Oppdater UI
        ui.roomCodeDisplay.textContent = id;
        ui.statusDot.className = 'status-indicator status-connected';
        ui.statusText.textContent = `Online (ID: ${id})`;
        
        showPanel('lobby');
    });

    peer.on('connection', (conn) => {
        handleIncomingConnection(conn);
    });

    peer.on('error', (err) => {
        log(`PeerJS Feil: ${err.type}`, 'error');
        // Hvis ID er tatt ('unavailable-id'), prøv igjen automatisk
        if (err.type === 'unavailable-id') {
            log("ID var opptatt, prøver ny...", 'error');
            setTimeout(initializePeer, 1000);
        } else {
            alert(`Tilkoblingsfeil: ${err.type}`);
        }
    });
    
    peer.on('disconnected', () => {
        log("Mistet kontakten med PeerServer.", 'error');
        ui.statusDot.className = 'status-indicator status-disconnected';
    });
}

function handleIncomingConnection(conn) {
    log(`Ny tilkobling fra: ${conn.peer}`);
    
    conn.on('open', () => {
        log(`Tilkobling åpnet for ${conn.peer}.`);
        connections.push(conn);
        updatePlayerList();
        
        // Send nåværende tilstand til den nye spilleren hvis vi er midt i et spill
        if (currentScenario.narrative) {
            conn.send({
                type: 'SCENARIO',
                data: currentScenario
            });
        }
    });

    conn.on('data', (data) => {
        handleDataFromClient(conn.peer, data);
    });

    conn.on('close', () => {
        log(`Spiller ${conn.peer} koblet fra.`);
        connections = connections.filter(c => c !== conn);
        updatePlayerList();
    });
}

function handleDataFromClient(peerId, data) {
    // data format: { type: 'VOTE', choiceId: 'A', playerName: 'Navn' }
    
    if (data.type === 'VOTE') {
        if (!isVotingOpen) {
            log(`Mottok stemme fra ${data.playerName} (${peerId}), men stemming er stengt.`);
            return;
        }

        log(`Stemme mottatt fra ${data.playerName}: Valg ${data.choiceId}`);
        
        // Lagre stemmen (overskriver tidligere stemme fra samme client)
        currentVotes[peerId] = data.choiceId;
        
        // Oppdater også navnet på tilkoblingen i listen vår for sikkerhets skyld
        const conn = connections.find(c => c.peer === peerId);
        if (conn) conn.metadata = { name: data.playerName };

        renderVotingResults();
    }
}

function updatePlayerList() {
    ui.playerCount.textContent = connections.length;
    ui.playerList.innerHTML = '';
    
    if (connections.length === 0) {
        ui.playerList.innerHTML = '<li><i>Ingen spillere ennå...</i></li>';
        return;
    }

    connections.forEach(conn => {
        const li = document.createElement('li');
        // Vi bruker metadata.name hvis tilgjengelig (satt ved første stemme), ellers Peer ID
        const name = (conn.metadata && conn.metadata.name) ? conn.metadata.name : `Gjest (${conn.peer.substring(0,4)})`;
        li.textContent = `🎮 ${name}`;
        ui.playerList.appendChild(li);
    });
}

function broadcast(type, data) {
    log(`Sender ${type} til ${connections.length} klienter.`);
    connections.forEach(conn => {
        if (conn.open) {
            conn.send({ type, data });
        }
    });
}

// === GEMINI API LOGIKK ===

async function callGeminiApi(contextText) {
    if (!apiKey) {
        alert("Mangler API Key!");
        return;
    }

    // ENDRET: Bruker 'gemini-1.5-flash' som er mer stabil for gratis-APIet og raskere.
    const modelName = "gemini-1.5-flash"; 
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
    
    // Bygg historikk for kontekst
    let promptHistory = narrativeHistory.join("\n");
    
    const systemInstruction = `
        Du er Game Master for et rollespill med en gruppe elever (10. klasse). 
        Svar ALLTID med gyldig JSON. Ingen markdown formatting (som \`\`\`json).
        
        Formatet SKAL være:
        {
            "narrative": "Beskrivelse av situasjonen...",
            "choices": [
                { "id": "A", "text": "Handling 1" },
                { "id": "B", "text": "Handling 2" },
                { "id": "C", "text": "Handling 3" },
                { "id": "D", "text": "Handling 4" }
            ]
        }
        
        Hold beskrivelsen engasjerende men kort (maks 3-4 setninger).
        Gi alltid 2-4 valg.
    `;

    const userPrompt = `
        ${promptHistory ? "Tidligere hendelser:\n" + promptHistory : ""}
        
        Nåværende instruks/handling fra GM: 
        ${contextText || "Start et nytt, spennende scenario."}
        
        Generer neste scene og valg.
    `;

    const payload = {
        contents: [{
            parts: [{ text: systemInstruction + "\n\n" + userPrompt }]
        }]
    };

    try {
        log(`Sender forespørsel til Gemini (${modelName})...`);
        ui.btnGenerate.disabled = true;
        ui.btnGenerate.textContent = "Tenker...";
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error.message);
        }

        // Hent ut teksten
        let rawText = data.candidates[0].content.parts[0].text;
        
        // Vask teksten for markdown code blocks hvis Gemini ignorerte instruksen
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();

        const scenarioObj = JSON.parse(rawText);
        
        log("Fikk gyldig svar fra Gemini.", 'success');
        return scenarioObj;

    } catch (error) {
        log(`Feil med Gemini: ${error.message}`, 'error');
        alert(`Feil ved generering: ${error.message}`);
        return null;
    } finally {
        ui.btnGenerate.disabled = false;
        ui.btnGenerate.textContent = "Generer Neste Scenario (Gemini)";
    }
}

// === SPILLFLYT LOGIKK ===

async function startNewRound() {
    const context = ui.scenarioContextInput.value;
    
    const scenario = await callGeminiApi(context);
    
    if (!scenario) return; // Feilet

    // Oppdater tilstand
    currentScenario = scenario;
    currentVotes = {}; // Nullstill stemmer
    isVotingOpen = true;
    
    // Lagre til historikk (kun narrativ for kontekst)
    narrativeHistory.push(`GM: ${scenario.narrative}`);
    // Vi beholder bare de siste 5 innslagene for å spare tokens
    if (narrativeHistory.length > 5) narrativeHistory.shift();

    // Oppdater Host UI
    ui.currentNarrative.innerHTML = marked.parse(scenario.narrative); // Bruk marked for fin formatering
    ui.scenarioContextInput.value = ""; // Tøm input
    
    // Generer tomme søyler
    renderVotingResults();

    // Send til klienter
    broadcast('SCENARIO', currentScenario);
}

function renderVotingResults() {
    ui.votingResults.innerHTML = '';
    
    if (!currentScenario.choices || currentScenario.choices.length === 0) {
        ui.votingResults.innerHTML = '<p>Venter på scenario...</p>';
        return;
    }

    const totalVotes = Object.keys(currentVotes).length;
    
    // Tell opp stemmer per valg
    const counts = {};
    currentScenario.choices.forEach(c => counts[c.id] = 0);
    
    Object.values(currentVotes).forEach(choiceId => {
        if (counts[choiceId] !== undefined) {
            counts[choiceId]++;
        }
    });

    // Tegn søyler
    currentScenario.choices.forEach(choice => {
        const count = counts[choice.id] || 0;
        const percentage = totalVotes > 0 ? (count / totalVotes) * 100 : 0;
        
        const wrapper = document.createElement('div');
        wrapper.className = 'result-bar-wrapper';
        
        wrapper.innerHTML = `
            <div class="result-label">
                <span>${choice.id}: ${choice.text}</span>
                <span>${count} stemmer (${Math.round(percentage)}%)</span>
            </div>
            <div class="result-track">
                <div class="result-fill" style="width: ${percentage}%"></div>
            </div>
        `;
        
        ui.votingResults.appendChild(wrapper);
    });
}

function lockVoting() {
    isVotingOpen = false;
    broadcast('VOTE_LOCKED', {}); // Gi beskjed til klienter (valgfritt, men god UX)
    log("Avstemning låst manuelt.");
    
    // Finn vinneren for å legge til historikken
    // (Enkel logikk: den med flest stemmer)
    // Dette er kun for GMs kontekst neste runde
    const counts = {};
    Object.values(currentVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
    
    let winnerId = null;
    let maxVotes = -1;
    for (const [id, count] of Object.entries(counts)) {
        if (count > maxVotes) {
            maxVotes = count;
            winnerId = id;
        }
    }
    
    if (winnerId) {
        const winningChoice = currentScenario.choices.find(c => c.id === winnerId);
        if (winningChoice) {
            narrativeHistory.push(`Spillerne valgte: ${winningChoice.text}`);
            log(`Vinnende valg lagt til historikk: ${winningChoice.text}`);
        }
    }
}

// === EVENT LISTENERS ===

document.addEventListener('DOMContentLoaded', () => {
    // Fyll inn API key hvis lagret
    if (ui.apiKeyInput) {
        ui.apiKeyInput.value = apiKey;
    }

    // Start Host knapp
    if (ui.btnStartHosting) {
        ui.btnStartHosting.addEventListener('click', () => {
            const key = ui.apiKeyInput.value.trim();
            if (!key) {
                alert("Du må legge inn en API Key.");
                return;
            }
            apiKey = key;
            localStorage.setItem('gemini_api_key', apiKey);
            
            initializePeer();
        });
    }

    // Generer scenario knapp
    if (ui.btnGenerate) {
        ui.btnGenerate.addEventListener('click', startNewRound);
    }

    // Lås stemming knapp
    if (ui.btnLockVoting) {
        ui.btnLockVoting.addEventListener('click', lockVoting);
    }
    
    log("host.js initialisert (v7).");
});
/* Version: #7 */
