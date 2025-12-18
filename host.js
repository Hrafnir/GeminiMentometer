/* Version: #18 */
// === KONFIGURASJON & TILSTAND ===
let peer = null;
let myRoomId = null;
let connections = []; 
let apiKey = localStorage.getItem('gemini_api_key') || '';

// Modeller
let textModel = localStorage.getItem('gemini_text_model') || 'gemini-3-flash-preview';
let imageModel = localStorage.getItem('gemini_image_model') || 'gemini-2.5-flash-image';

let gamePremise = ""; 
let currentScenario = { narrative: "", choices: [], imageUrl: "" };
let currentVotes = {}; 
let isVotingOpen = false;
let roundCounter = 0;
let fullGameLog = [];
let narrativeContext = []; 

// === DOM ELEMENTER ===
const ui = {
    setupPanel: document.getElementById('setup-panel'),
    lobbyPanel: document.getElementById('lobby-panel'),
    gamePanel: document.getElementById('game-panel'),
    gmInputPanel: document.getElementById('gm-input-panel'),
    
    apiKeyInput: document.getElementById('api-key'),
    modelNameText: document.getElementById('model-name-text'),
    modelNameImage: document.getElementById('model-name-image'),
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
    imageCredit: document.getElementById('image-credit'),
    votingResults: document.getElementById('voting-results'),
    btnLockVoting: document.getElementById('btn-lock-voting'),
    
    historyModal: document.getElementById('history-modal'),
    historyContent: document.getElementById('history-content'),
    btnCloseHistory: document.getElementById('btn-close-history'),
    
    statusDot: document.getElementById('status-dot'),
    statusText: document.getElementById('status-text')
};

// === LOGGING ===
function log(msg, type = 'info') {
    console.log(`[HOST] ${msg}`);
    const logEl = document.getElementById('debug-log');
    if (logEl) {
        const entry = document.createElement('div');
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
        if (type === 'error') entry.style.color = '#ff4444';
        if (type === 'success') entry.style.color = '#00ff00';
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
        
        checkAvailableModels();
        startNewRound(true);
        showPanel('game');
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

// === GEMINI API (2-TRINNS RAKETT) ===

async function checkAvailableModels() {
    if (!apiKey) return;
    try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
        const data = await res.json();
        
        log("=== DINE MODELLER ===", 'success');
        if (data.models) {
            const valid = data.models.map(m => m.name.replace("models/", ""));
            valid.forEach(m => log(`- ${m}`));
        }
    } catch (e) { log(`Modell-sjekk feilet: ${e.message}`, 'error'); }
}

// STEG 1: Generer Historie (Tekst)
async function callTextApi(contextText, isIntro = false) {
    if (!apiKey) { alert("Mangler API Key!"); return null; }
    
    // Oppdater modellvalg
    textModel = ui.modelNameText.value.trim();
    localStorage.setItem('gemini_text_model', textModel);

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${textModel}:generateContent?key=${apiKey}`;
    let promptHistory = narrativeContext.join("\n\n");
    
    const systemInstruction = `
        ROLLE: Game Master.
        VERDEN: "${gamePremise}"
        
        INSTRUKT OM BILDER:
        Du skal generere en 'image_prompt' på engelsk som beskriver scenen visuelt (lyssetting, motiv, stemning).
        
        OUTPUT FORMAT (JSON):
        {
            "narrative": "Historietekst (Markdown).",
            "image_prompt": "Visual description in English.",
            "choices": [
                { "id": "A", "text": "Handling", "chance": "50% (Valgfritt)", "effect": "Konsekvens" },
                ...
            ]
        }
    `;

    let userPrompt = isIntro 
        ? `Start eventyret! Introduser verdenen og første scene.` 
        : `HISTORIKK:\n${promptHistory}\n\nSISTE INPUT:\n${contextText}\n\nSkriv Kapittel ${roundCounter}.`;

    try {
        log(`Genererer tekst med ${textModel}...`);
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: systemInstruction + "\n\n" + userPrompt }] }] })
        });

        const data = await response.json();
        if (data.error) throw new Error(data.error.message);

        let rawText = data.candidates[0].content.parts[0].text;
        rawText = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(rawText);

    } catch (error) {
        log(`Tekst-generering feilet: ${error.message}`, 'error');
        alert(`Tekst-feil: ${error.message}`);
        return null;
    }
}

// STEG 2: Generer Bilde (Native Gemini Image)
async function callImageApi(prompt) {
    if (!prompt) return null;
    
    imageModel = ui.modelNameImage.value.trim();
    localStorage.setItem('gemini_image_model', imageModel);

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${imageModel}:generateContent?key=${apiKey}`;
    
    // Forbedre prompten litt
    const enhancedPrompt = `${prompt}, cinematic lighting, detailed, 8k, atmospheric, survival horror style`;
    
    try {
        log(`Genererer bilde med ${imageModel}...`);
        
        // Payload for bildegenerering varierer litt, men Gemini API bruker ofte standard generateContent 
        // hvor modellen returnerer "inlineData" (mimeType image/jpeg) i stedet for tekst.
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: enhancedPrompt }] }] })
        });

        const data = await response.json();
        if (data.error) {
            log(`Bilde-generering feil (ignorerer bilde): ${data.error.message}`, 'warning');
            return null; 
        }

        // Sjekk om vi fikk bilde-data
        const part = data.candidates?.[0]?.content?.parts?.[0];
        if (part && part.inline_data) {
            // Suksess! Vi har rådata.
            return `data:${part.inline_data.mime_type};base64,${part.inline_data.data}`;
        } else {
            log("Modellen returnerte ikke bilde-data. Sjekk modellnavnet.", 'warning');
            return null;
        }

    } catch (error) {
        log(`Bilde-feil: ${error.message}`, 'error');
        return null;
    }
}

// === SPILLFLYT ===

async function startNewRound(isIntro = false) {
    const context = ui.scenarioContextInput.value;
    ui.currentNarrative.innerHTML = "<em style='color:#888'>Gemini skriver historien...</em>";
    ui.sceneImageContainer.style.display = 'none';
    
    ui.btnGenerate.disabled = true;
    ui.btnGenerate.textContent = "Jobber...";

    // 1. Hent tekst
    const scenario = await callTextApi(context, isIntro);
    
    if (scenario) {
        roundCounter++;
        currentScenario = scenario;
        
        // 2. Hent bilde (hvis vi har prompt)
        if (scenario.image_prompt) {
            ui.currentNarrative.innerHTML += "<br><em style='color:#888'>...og maler bildet...</em>";
            const imageBase64 = await callImageApi(scenario.image_prompt);
            if (imageBase64) {
                currentScenario.imageUrl = imageBase64;
                ui.sceneImage.src = imageBase64;
                ui.sceneImageContainer.style.display = 'block';
                ui.imageCredit.textContent = `Generert av ${imageModel}`;
            }
        }

        // Fortsett flyten
        finishRoundSetup(isIntro, scenario);
    }
    
    ui.btnGenerate.disabled = false;
    ui.btnGenerate.textContent = "Generer Neste Kapittel";
}

function finishRoundSetup(isIntro, scenario) {
    // Eget forslag logikk
    if (ui.chkCustomOption && ui.chkCustomOption.checked) {
        currentScenario.choices.push({ id: "X", text: "Eget forslag (Klassen diskuterer)", effect: "GM bestemmer" });
        ui.chkCustomOption.checked = false;
    }

    currentVotes = {}; 
    isVotingOpen = true;
    
    let chapterTitle = isIntro ? "INTRO" : `KAPITTEL ${roundCounter}`;
    narrativeContext.push(`${chapterTitle}: ${scenario.narrative}`);
    if (narrativeContext.length > 8) narrativeContext.shift(); 

    fullGameLog.push({ 
        type: 'NARRATIVE', 
        title: chapterTitle,
        text: scenario.narrative,
        image: scenario.imageUrl
    });

    ui.currentNarrative.innerHTML = marked.parse(scenario.narrative);
    ui.scenarioContextInput.value = ""; 
    ui.btnGenerate.textContent = "Oppdater (Reset)"; 
    ui.btnGenerate.style.backgroundColor = ""; 

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
            fullGameLog.push({ type: 'CHOICE', text: resText }); 
            ui.scenarioContextInput.value = resText;
        }
    } else {
        ui.scenarioContextInput.value = "Tiden rant ut.";
    }

    ui.btnGenerate.textContent = ">>> GENERER NESTE KAPITTEL >>>";
    ui.btnGenerate.style.backgroundColor = "#00c853"; 
    ui.gmInputPanel.scrollIntoView({ behavior: 'smooth' });
}

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
    if (ui.modelNameText) ui.modelNameText.value = textModel;
    if (ui.modelNameImage) ui.modelNameImage.value = imageModel;
    
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

    log("host.js v18 (Dual Model) klar.");
});
/* Version: #18 */
