/* Version: #13 */
// === KONFIGURASJON & TILSTAND ===
let peer = null;
let myRoomId = null;
let connections = []; 
let apiKey = localStorage.getItem('gemini_api_key') || '';
let currentModel = localStorage.getItem('gemini_model') || 'gemini-1.5-flash-002';

// Spill-tilstand
let gamePremise = ""; // Her lagres reglene/verdenen du skriver inn
let currentScenario = {
    narrative: "",
    choices: []
};
let currentVotes = {}; 
let isVotingOpen = false;
let narrativeHistory = [];
let roundCounter = 0;

// === DOM ELEMENTER ===
const ui = {
    setupPanel: document.getElementById('setup-panel'),
    lobbyPanel: document.getElementById('lobby-panel'),
    gamePanel: document.getElementById('game-panel'),
    resultsPanel: document.getElementById('voting-results'), // Merk: endret ID i host.html v12? Sjekker dette.
    gmInputPanel: document.getElementById('gm-input-panel'),
    
    apiKeyInput: document.getElementById('api-key'),
    modelNameInput: document.getElementById('model-name'),
    gamePremiseInput: document.getElementById('game-premise'),
    btnStartHosting: document.getElementById('btn-start-hosting'),
    
    roomCodeDisplay: document.getElementById('room-code-display'),
    playerCount: document.getElementById('player-count'),
    playerList: document.getElementById('player-list'),
    
    scenarioContextInput: document.getElementById('scenario-context'),
    chkCustomOption: document.getElementById('chk-custom-option'),
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
    ui.gmInputPanel.classList.add('hidden');
    
    if (panelName === 'setup') ui.setupPanel.classList.remove('hidden');
    if (panelName === 'game') {
        ui.lobbyPanel.classList.remove('hidden'); // Alltid vis lobby info på topp
        ui.gamePanel.classList.remove('hidden'); 
        ui.gmInputPanel.classList.remove('hidden'); 
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
        
        // Når vi starter, genererer vi introen automatisk
        startNewRound(true);
        showPanel('game');
        
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
            const validModels = data.models
                .filter(m => m.supportedGenerationMethods.includes("generateContent"))
                .map(m => m.name.replace("models/", ""));
            log("Tilgjengelige modeller funnet.", 'success');
        }
    } catch (e) { log(`Kunne ikke hente modelliste: ${e.message}`, 'error'); }
}

async function callGeminiApi(contextText, isIntro = false) {
    if (!apiKey) { alert("Mangler API Key!"); return; }

    const modelToUse = ui.modelNameInput.value.trim() || "gemini-1.5-flash-002";
    localStorage.setItem('gemini_model', modelToUse); 

    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${modelToUse}:generateContent?key=${apiKey}`;
    
    let promptHistory = narrativeHistory.join("\n\n");
    
    // === SYSTEM INSTRUCTION (DENNE STYRER ALT) ===
    const systemInstruction = `
        ROLLE:
        Du er en Game Master (GM) for et tekstbasert rollespill.
        
        VERDEN & REGLER (FRA GM):
        "${gamePremise}"
        
        DIN OPPGAVE:
        Skriv neste del av historien basert på spillernes valg.
        
        KRAV TIL OUTPUT (JSON):
        Returner KUN gyldig JSON. Format:
        {
            "narrative": "Historietekst (bruk Markdown for fet tekst osv). Vær beskrivende.",
            "choices": [
                { 
                    "id": "A", 
                    "text": "Beskrivelse av handling",
                    "chance": "50% (Valgfritt, kun ved risiko)",
                    "effect": "Høy skade / Død (Valgfritt, beskriv konsekvens)"
                },
                ...
            ]
        }
        
        VIKTIG OM MEKANIKK:
        - Hvis en handling er farlig (angrep, hopping, stjeling), LEGG TIL "chance" (f.eks "40%") og "effect" (f.eks "Du kan bli oppdaget").
        - Hvis handlingen er trygg, utelat disse feltene.
        - Gi alltid 2-4 valg.
    `;

    let userPrompt = "";
    if (isIntro) {
        userPrompt = `Start eventyret nå! Introduser verdenen og den første utfordringen.`;
    } else {
        userPrompt = `
            HISTORIKK:
            ${promptHistory}
            
            SISTE HENDELSE / GM INPUT: 
            ${contextText}
            
            Skriv Kapittel ${roundCounter}. Flett inn konsekvensen av valget over.
        `;
    }

    const payload = {
        contents: [{ parts: [{ text: systemInstruction + "\n\n" + userPrompt }] }]
    };

    try {
        ui.btnGenerate.disabled = true;
        ui.btnGenerate.textContent = "Forfatter historie...";
        
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
        
        return scenarioObj;

    } catch (error) {
        log(`Feil: ${error.message}`, 'error');
        alert(`Feil: ${error.message}`);
        return null;
    } finally {
        ui.btnGenerate.disabled = false;
        ui.btnGenerate.textContent = "Generer Neste Kapittel";
    }
}

// === SPILLFLYT ===

async function startNewRound(isIntro = false) {
    const context = ui.scenarioContextInput.value;
    
    ui.currentNarrative.innerHTML = "<em style='color:#888'>Gemini skriver historien...</em>";
    ui.votingResults.innerHTML = "";
    
    const scenario = await callGeminiApi(context, isIntro);
    if (!scenario) return;

    roundCounter++;
    currentScenario = scenario;
    
    // === HÅNDTERING AV "EGET FORSLAG" ===
    if (ui.chkCustomOption && ui.chkCustomOption.checked) {
        currentScenario.choices.push({
            id: "X",
            text: "Eget forslag (Klassen diskuterer)",
            effect: "GM bestemmer utfallet"
        });
        // Fjern haken etter bruk så den ikke henger på for alltid
        ui.chkCustomOption.checked = false;
    }

    currentVotes = {}; 
    isVotingOpen = true;
    
    // Lagre narrativet
    if (isIntro) {
        narrativeHistory.push(`INTRO: ${scenario.narrative}`);
    } else {
        narrativeHistory.push(`KAPITTEL ${roundCounter}: ${scenario.narrative}`);
    }
    
    if (narrativeHistory.length > 8) narrativeHistory.shift(); 

    // Vis resultat
    ui.currentNarrative.innerHTML = marked.parse(scenario.narrative);
    ui.scenarioContextInput.value = ""; 
    
    ui.btnGenerate.textContent = "Oppdater Scenario (Reset)"; 
    ui.btnGenerate.style.backgroundColor = ""; 
    
    renderVotingResults();
    broadcast('SCENARIO', currentScenario);
    
    // Scroll til historie
    ui.gamePanel.scrollIntoView({ behavior: 'smooth' });
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
            let resultText = "";
            
            // Spesialhåndtering hvis "Eget forslag" vant
            if (winningChoice.id === "X") {
                resultText = "SPILLERNE VALGTE EGET FORSLAG: [Skriv hva klassen ble enige om her...]";
                log("Klassen valgte eget forslag!");
            } else {
                resultText = `SPILLERNE VALGTE: "${winningChoice.text}"`;
                // Hvis det var sjanse involvert, kan GM legge til resultat av terningkast her
                if (winningChoice.chance) {
                    resultText += ` (Sjanse: ${winningChoice.chance}. Utfall: [Skriv om de lyktes eller feilet...])`;
                }
            }
            
            narrativeHistory.push(resultText); // Lagre valget i historikken
            ui.scenarioContextInput.value = resultText;
        }
    } else {
        ui.scenarioContextInput.value = "Ingen stemte. Tiden rant ut.";
    }

    ui.btnGenerate.textContent = ">>> GENERER NESTE KAPITTEL >>>";
    ui.btnGenerate.style.backgroundColor = "#00c853"; 
    
    // Scroll ned til input-feltet slik at GM ser det
    ui.gmInputPanel.scrollIntoView({ behavior: 'smooth' });
}

document.addEventListener('DOMContentLoaded', () => {
    if (ui.apiKeyInput) ui.apiKeyInput.value = apiKey;
    if (ui.modelNameInput) ui.modelNameInput.value = currentModel;

    if (ui.btnStartHosting) {
        ui.btnStartHosting.addEventListener('click', () => {
            const key = ui.apiKeyInput.value.trim();
            const model = ui.modelNameInput.value.trim();
            const premise = ui.gamePremiseInput.value.trim();
            
            if (!key) { alert("Mangler API Key."); return; }
            if (!premise) { alert("Du må skrive et premiss/intro for spillet."); return; }
            
            apiKey = key;
            currentModel = model;
            gamePremise = premise; // Lagre premisset
            
            localStorage.setItem('gemini_api_key', apiKey);
            localStorage.setItem('gemini_model', currentModel);
            
            initializePeer();
        });
    }

    if (ui.btnGenerate) ui.btnGenerate.addEventListener('click', () => startNewRound(false));
    if (ui.btnLockVoting) ui.btnLockVoting.addEventListener('click', lockVoting);
    
    log("host.js v13 (Premise & Mechanics) klar.");
});
/* Version: #13 */
