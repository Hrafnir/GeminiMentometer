/* Version: #10 */
// === KONFIGURASJON & TILSTAND ===
let peer = null;
let myRoomId = null;
let connections = []; 
let apiKey = localStorage.getItem('gemini_api_key') || '';
let currentModel = localStorage.getItem('gemini_model') || 'gemini-1.5-flash-002';

// Spill-tilstand
let currentScenario = {
    narrative: "",
    choices: []
};
let currentVotes = {}; 
let isVotingOpen = false;
let narrativeHistory = [];
let roundCounter = 1;

// === DOM ELEMENTER ===
const ui = {
    setupPanel: document.getElementById('setup-panel'),
    lobbyPanel: document.getElementById('lobby-panel'),
    gamePanel: document.getElementById('game-panel'),
    resultsPanel: document.getElementById('results-panel'),
    
    apiKeyInput: document.getElementById('api-key'),
    modelNameInput: document.getElementById('model-name'),
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

function log(msg, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[HOST] ${msg}`);
    
    const logEl = document.getElementById('debug-log');
    if (logEl) {
        const entry = document.createElement('div');
        entry.textContent = `[${timestamp}] ${msg}`;
        if (type === 'error') entry.style.color = '#ff4444';
        if (type === 'success') entry.style.color = '#00ff00';
        if (type === 'warning') entry.style.color = '#ffff00';
        logEl.appendChild(entry);
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function generateShortId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 4; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

function showPanel(panelName) {
    ui.setupPanel.classList.add('hidden');
    ui.lobbyPanel.classList.add('hidden');
    ui.gamePanel.classList.add('hidden');
    ui.resultsPanel.classList.add('hidden');
    
    if (panelName === 'setup') ui.setupPanel.classList.remove('hidden');
    if (panelName === 'lobby') {
        ui.lobbyPanel.classList.remove('hidden');
        ui.gamePanel.classList.remove('hidden'); 
        ui.resultsPanel.classList.remove('hidden'); 
    }
}

// === PEERJS LOGIKK ===

function initializePeer() {
    const requestedId = generateShortId();
    log(`Forsøker å opprette rom med ID: ${requestedId}...`);

    peer = new Peer(requestedId, { debug: 1 });

    peer.on('open', (id) => {
        myRoomId = id;
        log(`Server startet! Rom-ID: ${id}`, 'success');
        
        ui.roomCodeDisplay.textContent = id;
        ui.statusDot.className = 'status-indicator status-connected';
        ui.statusText.textContent = `Online (ID: ${id})`;
        
        showPanel('lobby');
        checkAvailableModels();
    });

    peer.on('connection', (conn) => {
        handleIncomingConnection(conn);
    });

    peer.on('error', (err) => {
        log(`PeerJS Feil: ${err.type}`, 'error');
        if (err.type === 'unavailable-id') {
            setTimeout(initializePeer, 1000);
        } else {
            alert(`Tilkoblingsfeil: ${err.type}`);
        }
    });
}

function handleIncomingConnection(conn) {
    conn.on('open', () => {
        connections.push(conn);
        updatePlayerList();
        if (currentScenario.narrative) {
            conn.send({ type: 'SCENARIO', data: currentScenario });
        }
    });
    conn.on('data', (data) => handleDataFromClient(conn.peer, data));
    conn.on('close', () => {
        connections = connections.filter(c => c !== conn);
        updatePlayerList();
    });
}

function handleDataFromClient(peerId, data) {
    if (data.type === 'VOTE') {
        if (!isVotingOpen) return;
        currentVotes[peerId] = data.choiceId;
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
        const name = (conn.metadata && conn.metadata.name) ? conn.metadata.name : `Gjest (${conn.peer.substring(0,4)})`;
        li.textContent = `🎮 ${name}`;
        ui.playerList.appendChild(li);
    });
}

function broadcast(type, data) {
    connections.forEach(conn => { if (conn.open) conn.send({ type, data }); });
}

// === GEMINI API LOGIKK ===

async function checkAvailableModels() {
    if (!apiKey) return;
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.models) {
            log("=== TILGJENGELIGE MODELLER ===", 'success');
            const validModels = data.models
                .filter(m => m.supportedGenerationMethods.includes("generateContent"))
                .map(m => m.name.replace("models/", ""));
            validModels.forEach(m => log(`- ${m}`));
            log("==============================", 'success');
        }
    } catch (e) { log(`Kunne ikke hente modelliste: ${e.message}`, 'error'); }
}

async function callGeminiApi(contextText) {
    if (!apiKey) { alert("Mangler API Key!"); return; }

    const modelToUse = ui.modelNameInput.value.trim() || "gemini-1.5-flash-002";
    localStorage.setItem('gemini_model', modelToUse); 

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;
    
    let promptHistory = narrativeHistory.join("\n");
    const systemInstruction = `
        Du er Game Master for et rollespill.
        Svar ALLTID med gyldig JSON.
        Format: { "narrative": "...", "choices": [{ "id": "A", "text": "..." }, ...] }
        Driv historien fremover basert på spillernes valg. Lag nye utfordringer.
        Narrativ: Maks 4 setninger.
        Valg: 2-4 stk.
    `;
    const userPrompt = `
        Tidligere historikk:
        ${promptHistory}
        
        Siste hendelse/Instruks: 
        ${contextText}
        
        Generer neste del av historien (Kapittel ${roundCounter}).
    `;

    const payload = {
        contents: [{ parts: [{ text: systemInstruction + "\n\n" + userPrompt }] }]
    };

    try {
        ui.btnGenerate.disabled = true;
        ui.btnGenerate.textContent = "Tenker...";
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        let rawText = data.candidates[0].content.parts[0].text;
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const scenarioObj = JSON.parse(rawText);
        
        log("Svar mottatt fra Gemini.", 'success');
        return scenarioObj;

    } catch (error) {
        log(`Feil: ${error.message}`, 'error');
        alert(`Feil: ${error.message}`);
        return null;
    } finally {
        ui.btnGenerate.disabled = false;
        ui.btnGenerate.textContent = "Generer Neste Kapittel"; // Endret tekst
    }
}

// === SPILLFLYT ===

async function startNewRound() {
    const context = ui.scenarioContextInput.value;
    
    // UI Feedback
    ui.currentNarrative.innerHTML = "<em style='color:#888'>Gemini skriver historien...</em>";
    ui.votingResults.innerHTML = "";
    
    const scenario = await callGeminiApi(context);
    if (!scenario) return;

    roundCounter++;
    currentScenario = scenario;
    currentVotes = {}; 
    isVotingOpen = true;
    
    // Legg til historikk
    narrativeHistory.push(`GM: ${scenario.narrative}`);
    if (narrativeHistory.length > 8) narrativeHistory.shift(); // Økte minnet litt

    // Vis resultat
    ui.currentNarrative.innerHTML = marked.parse(scenario.narrative);
    ui.scenarioContextInput.value = ""; // Tøm input for neste runde
    
    // Reset knappetekst til standard mens spillet pågår
    ui.btnGenerate.textContent = "Oppdater Scenario (Reset)"; 
    ui.btnGenerate.style.backgroundColor = ""; // Reset farge
    
    renderVotingResults();
    broadcast('SCENARIO', currentScenario);
    
    // Scroll ned til resultatene
    ui.resultsPanel.scrollIntoView({ behavior: 'smooth' });
}

function renderVotingResults() {
    ui.votingResults.innerHTML = '';
    if (!currentScenario.choices || currentScenario.choices.length === 0) {
        return;
    }
    const totalVotes = Object.keys(currentVotes).length;
    const counts = {};
    currentScenario.choices.forEach(c => counts[c.id] = 0);
    Object.values(currentVotes).forEach(choiceId => { if (counts[choiceId] !== undefined) counts[choiceId]++; });

    currentScenario.choices.forEach(choice => {
        const count = counts[choice.id] || 0;
        const percentage = totalVotes > 0 ? (count / totalVotes) * 100 : 0;
        
        const wrapper = document.createElement('div');
        wrapper.className = 'result-bar-wrapper';
        wrapper.innerHTML = `
            <div class="result-label"><span>${choice.id}: ${choice.text}</span><span>${count} (${Math.round(percentage)}%)</span></div>
            <div class="result-track"><div class="result-fill" style="width: ${percentage}%"></div></div>
        `;
        ui.votingResults.appendChild(wrapper);
    });
}

function lockVoting() {
    if (!isVotingOpen) return;
    
    isVotingOpen = false;
    broadcast('VOTE_LOCKED', {});
    log("Stemming låst.");
    
    // 1. Finn vinneren
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
    
    // 2. Forbered neste runde automatisk
    if (winnerId) {
        const winningChoice = currentScenario.choices.find(c => c.id === winnerId);
        if (winningChoice) {
            const resultText = `Spillerne valgte: "${winningChoice.text}".`;
            narrativeHistory.push(resultText);
            
            // HER ER MAGIEN: Vi legger vinner-valget rett inn i input-feltet til GM!
            ui.scenarioContextInput.value = resultText + " Hva skjer nå?";
            
            log(`Vinner: ${winningChoice.text}`);
        }
    } else {
        ui.scenarioContextInput.value = "Ingen stemte. Tiden rant ut. Hva skjer?";
    }

    // 3. Led oppmerksomheten til "Generer"-knappen
    ui.btnGenerate.textContent = ">>> GENERER NESTE KAPITTEL >>>";
    ui.btnGenerate.style.backgroundColor = "#00c853"; // Grønn farge for "Go"
    
    // Scroll opp slik at GM ser knappen
    ui.gamePanel.scrollIntoView({ behavior: 'smooth' });
}

document.addEventListener('DOMContentLoaded', () => {
    if (ui.apiKeyInput) ui.apiKeyInput.value = apiKey;
    if (ui.modelNameInput) ui.modelNameInput.value = currentModel;

    if (ui.btnStartHosting) {
        ui.btnStartHosting.addEventListener('click', () => {
            const key = ui.apiKeyInput.value.trim();
            const model = ui.modelNameInput.value.trim();
            if (!key) { alert("Mangler API Key."); return; }
            
            apiKey = key;
            currentModel = model;
            localStorage.setItem('gemini_api_key', apiKey);
            localStorage.setItem('gemini_model', currentModel);
            
            initializePeer();
        });
    }

    if (ui.btnGenerate) ui.btnGenerate.addEventListener('click', startNewRound);
    
    if (ui.btnLockVoting) ui.btnLockVoting.addEventListener('click', lockVoting);
    
    log("host.js v10 (Auto-flow) klar.");
});
/* Version: #10 */
