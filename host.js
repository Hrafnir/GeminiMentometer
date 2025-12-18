/* Version: #15 */
// === KONFIGURASJON & TILSTAND ===
let peer = null;
let myRoomId = null;
let connections = []; 
let apiKey = localStorage.getItem('gemini_api_key') || '';
let currentModel = localStorage.getItem('gemini_model') || 'gemini-1.5-flash';

let gamePremise = ""; 
let currentScenario = { narrative: "", choices: [], imageUrl: "" };
let currentVotes = {}; 
let isVotingOpen = false;
let roundCounter = 0;

// Strukturert historikk for printing: [{ type: 'NARRATIVE'|'CHOICE', text: '...', image: 'url' }]
let fullGameLog = [];
// Ren tekst-historikk for Gemini context window
let narrativeContext = []; 

// === DOM ELEMENTER ===
const ui = {
    setupPanel: document.getElementById('setup-panel'),
    lobbyPanel: document.getElementById('lobby-panel'),
    gamePanel: document.getElementById('game-panel'),
    gmInputPanel: document.getElementById('gm-input-panel'),
    
    apiKeyInput: document.getElementById('api-key'),
    modelNameInput: document.getElementById('model-name'),
    gamePremiseInput: document.getElementById('game-premise'),
    btnStartHosting: document.getElementById('btn-start-hosting'),
    
    roomCodeDisplay: document.getElementById('room-code-display'),
    playerCount: document.getElementById('player-count'),
    playerList: document.getElementById('player-list'),
    btnViewHistory: document.getElementById('btn-view-history'),
    
    scenarioContextInput: document.getElementById('scenario-context'),
    chkCustomOption: document.getElementById('chk-custom-option'),
    btnGenerate: document.getElementById('btn-generate'),
    
    currentNarrative: document.getElementById('current-narrative'),
    sceneImageContainer: document.getElementById('scene-image-container'),
    sceneImage: document.getElementById('scene-image'),
    votingResults: document.getElementById('voting-results'),
    btnLockVoting: document.getElementById('btn-lock-voting'),
    
    historyModal: document.getElementById('history-modal'),
    historyContent: document.getElementById('history-content'),
    btnCloseHistory: document.getElementById('btn-close-history'),
    
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text')
};

// === LOGGING & TOOLS ===
function log(msg, type = 'info') {
    console.log(`[HOST] ${msg}`);
    const logEl = document.getElementById('debug-log');
    if (logEl) {
        const entry = document.createElement('div');
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        if (type === 'error') entry.style.color = '#ff4444';
        logEl.appendChild(entry);
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function generateShortId() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < 4; i++) result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
}

function showPanel(panelName) {
    ui.setupPanel.classList.add('hidden');
    ui.lobbyPanel.classList.add('hidden');
    ui.gamePanel.classList.add('hidden');
    ui.gmInputPanel.classList.add('hidden');
    
    if (panelName === 'setup') ui.setupPanel.classList.remove('hidden');
    if (panelName === 'game') {
        ui.lobbyPanel.classList.remove('hidden'); 
        ui.gamePanel.classList.remove('hidden'); 
        ui.gmInputPanel.classList.remove('hidden'); 
    }
}

// === PEERJS ===
function initializePeer() {
    const requestedId = generateShortId();
    log(`Oppretter rom: ${requestedId}...`);
    peer = new Peer(requestedId, { debug: 1 });

    peer.on('open', (id) => {
        myRoomId = id;
        log(`Server startet! ID: ${id}`, 'success');
        ui.roomCodeDisplay.textContent = id;
        ui.statusDot.className = 'status-indicator status-connected';
        ui.statusText.textContent = `Online (${id})`;
        startNewRound(true);
        showPanel('game');
        checkAvailableModels();
    });

    peer.on('connection', (conn) => handleIncomingConnection(conn));
    peer.on('error', (err) => {
        if (err.type === 'unavailable-id') setTimeout(initializePeer, 1000);
        else alert(`Feil: ${err.type}`);
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
    if (data.type === 'VOTE' && isVotingOpen) {
        currentVotes[peerId] = data.choiceId;
        const conn = connections.find(c => c.peer === peerId);
        if (conn) conn.metadata = { name: data.playerName };
        renderVotingResults();
    }
}

function updatePlayerList() {
    ui.playerCount.textContent = connections.length;
    ui.playerList.innerHTML = '';
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

// === GEMINI & IMAGE API ===

async function checkAvailableModels() {
    if (!apiKey) return;
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await res.json();
        if (data.models) log("Modell-liste hentet OK.", 'success');
    } catch (e) { log(`Modell-sjekk feilet: ${e.message}`, 'error'); }
}

async function callGeminiApi(contextText, isIntro = false) {
    if (!apiKey) { alert("Mangler API Key!"); return; }
    const modelToUse = ui.modelNameInput.value.trim() || "gemini-1.5-flash";
    localStorage.setItem('gemini_model', modelToUse); 

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;
    let promptHistory = narrativeContext.join("\n\n");
    
    // Instruks som ber om 'image_prompt' i tillegg
    const systemInstruction = `
        ROLLE: Game Master.
        VERDEN: "${gamePremise}"
        
        OUTPUT FORMAT (JSON):
        {
            "narrative": "Historietekst (Markdown).",
            "image_prompt": "Short visual description of the scene in English. Focus on lighting, mood, characters. No text in image.",
            "choices": [
                { "id": "A", "text": "Handling", "chance": "50% (Valgfritt)", "effect": "Konsekvens (Valgfritt)" },
                ...
            ]
        }
        
        VIKTIG:
        - Gi alltid 'image_prompt' (engelsk).
        - Bruk 'chance'/'effect' ved farlige valg.
    `;

    let userPrompt = isIntro 
        ? `Start eventyret! Introduser verdenen og første scene.` 
        : `HISTORIKK:\n${promptHistory}\n\nSISTE INPUT:\n${contextText}\n\nSkriv Kapittel ${roundCounter}.`;

    try {
        ui.btnGenerate.disabled = true;
        ui.btnGenerate.textContent = "Forfatter...";
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: systemInstruction + "\n\n" + userPrompt }] }] })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        let rawText = data.candidates[0].content.parts[0].text;
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        const scenarioObj = JSON.parse(rawText);
        
        // Generer bilde URL hvis vi fikk en prompt
        if (scenarioObj.image_prompt) {
            // Vi bruker Pollinations.ai (gratis, URL-basert)
            const encodedPrompt = encodeURIComponent(scenarioObj.image_prompt + " cinematic lighting, highly detailed, 8k, atmospheric");
            scenarioObj.imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1024&height=576&nologo=true&seed=${Math.floor(Math.random()*1000)}`;
        }
        
        return scenarioObj;

    } catch (error) {
        log(`Feil: ${error.message}`, 'error');
        return null;
    } finally {
        ui.btnGenerate.disabled = false;
        ui.btnGenerate.textContent = "Generer Neste Kapittel";
    }
}

// === SPILLFLYT ===

async function startNewRound(isIntro = false) {
    const context = ui.scenarioContextInput.value;
    ui.currentNarrative.innerHTML = "<em style='color:#888'>Genererer tekst og bilde...</em>";
    ui.sceneImageContainer.style.display = 'none';
    
    const scenario = await callGeminiApi(context, isIntro);
    if (!scenario) return;

    roundCounter++;
    currentScenario = scenario;
    
    // Eget forslag logikk
    if (ui.chkCustomOption && ui.chkCustomOption.checked) {
        currentScenario.choices.push({ id: "X", text: "Eget forslag (Klassen diskuterer)", effect: "GM bestemmer" });
        ui.chkCustomOption.checked = false;
    }

    currentVotes = {}; 
    isVotingOpen = true;
    
    // Lagre til kontekst (Gemini minne)
    let chapterTitle = isIntro ? "INTRO" : `KAPITTEL ${roundCounter}`;
    narrativeContext.push(`${chapterTitle}: ${scenario.narrative}`);
    if (narrativeContext.length > 8) narrativeContext.shift(); 

    // Lagre til Full Logg (Print)
    fullGameLog.push({ 
        type: 'NARRATIVE', 
        title: chapterTitle,
        text: scenario.narrative,
        image: scenario.imageUrl
    });

    // Oppdater UI
    ui.currentNarrative.innerHTML = marked.parse(scenario.narrative);
    ui.scenarioContextInput.value = ""; 
    ui.btnGenerate.textContent = "Oppdater (Reset)"; 
    ui.btnGenerate.style.backgroundColor = ""; 
    
    // Vis bilde
    if (scenario.imageUrl) {
        ui.sceneImage.src = scenario.imageUrl;
        ui.sceneImageContainer.style.display = 'block';
    }

    renderVotingResults();
    broadcast('SCENARIO', currentScenario);
    
    ui.gamePanel.scrollIntoView({ behavior: 'smooth' });
}

function renderVotingResults() {
    ui.votingResults.innerHTML = '';
    if (!currentScenario.choices) return;
    
    const totalVotes = Object.keys(currentVotes).length;
    const counts = {};
    currentScenario.choices.forEach(c => counts[c.id] = 0);
    Object.values(currentVotes).forEach(v => { if (counts[v] !== undefined) counts[v]++; });

    currentScenario.choices.forEach(c => {
        const count = counts[c.id] || 0;
        const pct = totalVotes > 0 ? (count / totalVotes) * 100 : 0;
        const div = document.createElement('div');
        div.className = 'result-bar-wrapper';
        div.innerHTML = `
            <div class="result-label"><span>${c.id}: ${c.text}</span><span>${count} (${Math.round(pct)}%)</span></div>
            <div class="result-track"><div class="result-fill" style="width: ${pct}%"></div></div>
        `;
        ui.votingResults.appendChild(div);
    });
}

function lockVoting() {
    if (!isVotingOpen) return;
    isVotingOpen = false;
    broadcast('VOTE_LOCKED', {});
    
    // Finn vinner
    const counts = {};
    Object.values(currentVotes).forEach(v => counts[v] = (counts[v] || 0) + 1);
    let winnerId = null, max = -1;
    for (const [id, c] of Object.entries(counts)) if (c > max) { max = c; winnerId = id; }
    
    if (winnerId) {
        const choice = currentScenario.choices.find(c => c.id === winnerId);
        if (choice) {
            let resText = choice.id === "X" ? "Klassen valgte eget forslag..." : `Spillerne valgte: "${choice.text}"`;
            if (choice.chance) resText += ` (Sjanse: ${choice.chance})`;
            
            narrativeContext.push(resText);
            fullGameLog.push({ type: 'CHOICE', text: resText }); // Logg valget
            ui.scenarioContextInput.value = resText;
        }
    } else {
        ui.scenarioContextInput.value = "Tiden rant ut.";
    }

    ui.btnGenerate.textContent = ">>> GENERER NESTE KAPITTEL >>>";
    ui.btnGenerate.style.backgroundColor = "#00c853"; 
    ui.gmInputPanel.scrollIntoView({ behavior: 'smooth' });
}

// === HISTORY / PRINT FUNKSJONALITET ===
function showHistory() {
    ui.historyContent.innerHTML = '';
    
    fullGameLog.forEach(entry => {
        const div = document.createElement('div');
        div.style.marginBottom = "30px";
        div.style.borderBottom = "1px solid #333";
        div.style.paddingBottom = "20px";
        
        if (entry.type === 'NARRATIVE') {
            div.innerHTML = `
                <h3 style="color: #bb86fc;">${entry.title}</h3>
                ${entry.image ? `<img src="${entry.image}" style="max-width: 300px; float: right; margin-left: 20px; border-radius: 5px;">` : ''}
                <div>${marked.parse(entry.text)}</div>
                <div style="clear: both;"></div>
            `;
        } else if (entry.type === 'CHOICE') {
            div.innerHTML = `<p style="font-weight: bold; color: #03dac6;">➔ ${entry.text}</p>`;
        }
        ui.historyContent.appendChild(div);
    });
    
    ui.historyModal.classList.remove('hidden');
}

// === INIT ===
document.addEventListener('DOMContentLoaded', () => {
    if (ui.apiKeyInput) ui.apiKeyInput.value = apiKey;
    
    if (ui.btnStartHosting) ui.btnStartHosting.addEventListener('click', () => {
        apiKey = ui.apiKeyInput.value.trim();
        gamePremise = ui.gamePremiseInput.value.trim();
        if (!apiKey || !gamePremise) { alert("Mangler nøkkel eller premiss!"); return; }
        localStorage.setItem('gemini_api_key', apiKey);
        initializePeer();
    });

    if (ui.btnGenerate) ui.btnGenerate.addEventListener('click', () => startNewRound(false));
    if (ui.btnLockVoting) ui.btnLockVoting.addEventListener('click', lockVoting);
    
    if (ui.btnViewHistory) ui.btnViewHistory.addEventListener('click', showHistory);
    if (ui.btnCloseHistory) ui.btnCloseHistory.addEventListener('click', () => ui.historyModal.classList.add('hidden'));

    log("host.js v15 klar.");
});
/* Version: #15 */
