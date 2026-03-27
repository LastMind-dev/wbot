/**
 * Configurações Centralizadas para WhatsApp Server v4.0
 * Simplificado: 1 monitor unificado, circuit breaker, cleanup de processos
 */

const path = require('path');

// Estados de conexão possíveis
const CONNECTION_STATUS = {
    CONNECTED: 'CONNECTED',
    DISCONNECTED: 'DISCONNECTED',
    RECONNECTING: 'RECONNECTING',
    QR_REQUIRED: 'QR_REQUIRED',
    QR_CODE: 'QR_CODE',
    AUTH_FAILURE: 'AUTH_FAILURE',
    INITIALIZING: 'INITIALIZING',
    LOADING: 'LOADING',
    SYNC_TIMEOUT: 'SYNC_TIMEOUT',
    INIT_ERROR: 'INIT_ERROR'
};

// Razões que NÃO devem reconectar
const NO_RECONNECT_REASONS = [
    'LOGOUT',
    'TOS_BLOCK',
    'SMB_TOS_BLOCK',
    'BANNED'
];

// Razões que devem reconectar IMEDIATAMENTE (delay curto)
const IMMEDIATE_RECONNECT_REASONS = [
    'CONFLICT',
    'UNPAIRED',
    'NAVIGATION',
    'TIMEOUT',
    'NETWORK_ERROR'
];

// Configurações de estabilidade de conexão
const RESILIENCE_CONFIG = {
    // ═══════════════════════════════════════════════════════════════
    // MONITOR UNIFICADO — único sistema de verificação
    // ═══════════════════════════════════════════════════════════════
    MONITOR_INTERVAL: 180000,           // Verificação a cada 3 MIN
    MONITOR_STARTUP_DELAY: 30000,       // Esperar 30s após startup antes de começar

    // ═══════════════════════════════════════════════════════════════
    // TIMEOUTS (em ms)
    // ═══════════════════════════════════════════════════════════════
    STATE_CHECK_TIMEOUT: 15000,         // Timeout para verificar estado
    DESTROY_TIMEOUT: 15000,             // Timeout para destruir cliente (increased)
    INIT_TIMEOUT: 180000,               // 3 min para inicialização
    GRACEFUL_SHUTDOWN_TIMEOUT: 30000,   // 30s para shutdown gracioso

    // ═══════════════════════════════════════════════════════════════
    // CIRCUIT BREAKER — para real de reconexão
    // ═══════════════════════════════════════════════════════════════
    MAX_RECONNECT_ATTEMPTS: 10,         // Tentativas antes de abrir circuito
    CIRCUIT_OPEN_DURATION: 600000,      // 10 min de pausa quando circuito abre
    CIRCUIT_HALF_OPEN_ATTEMPTS: 2,      // Tentativas em half-open antes de fechar
    RECONNECT_RESET_AFTER: 1800000,     // Reset contador após 30 min conectado

    // ═══════════════════════════════════════════════════════════════
    // DELAYS DE RECONEXÃO (em ms)
    // ═══════════════════════════════════════════════════════════════
    RECONNECT_BASE_DELAY: 5000,         // Delay base (5s)
    RECONNECT_MAX_DELAY: 300000,        // Delay máximo (5 min)
    RECONNECT_IMMEDIATE_DELAY: 3000,    // Delay para reconexão imediata
    RECONNECT_JITTER_MAX: 3000,         // Jitter máximo aleatório

    // ═══════════════════════════════════════════════════════════════
    // THRESHOLDS (em ms)
    // ═══════════════════════════════════════════════════════════════
    INACTIVITY_THRESHOLD: 900000,       // 15 min sem atividade = problema
    LOADING_TIMEOUT: 300000,            // 5 min máximo em loading
    PING_TIMEOUT_THRESHOLD: 600000,     // 10 min sem ping = problema
    ZOMBIE_THRESHOLD: 1800000,          // 30 min = sessão zumbi

    // ═══════════════════════════════════════════════════════════════
    // PROTEÇÃO CONTRA ERROS DE CONTEXTO
    // ═══════════════════════════════════════════════════════════════
    MAX_CONTEXT_ERRORS: 5,              // Máximo antes de reconectar
    MAX_CONSECUTIVE_FAILURES: 5,        // Falhas de probe antes de reconectar

    // ═══════════════════════════════════════════════════════════════
    // LIMITES DE MEMÓRIA (em bytes)
    // ═══════════════════════════════════════════════════════════════
    MAX_HEAP_PER_INSTANCE: 500 * 1024 * 1024,  // 500MB por instância
    MAX_TOTAL_HEAP: 2 * 1024 * 1024 * 1024,    // 2GB total
    HEAP_WARNING_THRESHOLD: 0.8,        // 80% = alerta
    HEAP_CRITICAL_THRESHOLD: 0.95,      // 95% = crítico

    // ═══════════════════════════════════════════════════════════════
    // CAMINHOS
    // ═══════════════════════════════════════════════════════════════
    SESSION_STORAGE_PATH: process.env.SESSION_STORAGE_PATH || path.join(__dirname, '..', '.wwebjs_auth'),
    CACHE_PATH: process.env.CACHE_PATH || path.join(__dirname, '..', '.wwebjs_cache')
};

// Configurações do Puppeteer — limpas e validadas
const PUPPETEER_CONFIG = {
    headless: true,
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-software-rasterizer',
        '--disable-background-networking',
        '--disable-default-apps',
        '--disable-sync',
        '--disable-translate',
        '--hide-scrollbars',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--safebrowsing-disable-auto-update',
        // Evitar throttling do Chrome em background
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        // Estabilidade de rede
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--force-color-profile=srgb'
    ],
    timeout: 60000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false
};

// Configurações do cliente WhatsApp — sem userAgent customizado
const WHATSAPP_CLIENT_CONFIG = {
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    authTimeoutMs: 0,
    qrMaxRetries: 0,
    restartOnAuthFail: true,
    bypassCSP: true
};

/**
 * Calcula delay com backoff exponencial e jitter
 */
function calculateReconnectDelay(attempt, immediate = false) {
    if (immediate) {
        return RESILIENCE_CONFIG.RECONNECT_IMMEDIATE_DELAY + (attempt * 1500);
    }
    const exponentialDelay = RESILIENCE_CONFIG.RECONNECT_BASE_DELAY * Math.pow(1.5, attempt);
    const cappedDelay = Math.min(exponentialDelay, RESILIENCE_CONFIG.RECONNECT_MAX_DELAY);
    const jitter = Math.random() * RESILIENCE_CONFIG.RECONNECT_JITTER_MAX;
    return Math.floor(cappedDelay + jitter);
}

/**
 * Verifica se uma razão de desconexão deve permitir reconexão
 */
function shouldReconnect(reason) {
    return !NO_RECONNECT_REASONS.includes(reason);
}

/**
 * Verifica se uma razão requer reconexão imediata
 */
function isImmediateReconnect(reason) {
    return IMMEDIATE_RECONNECT_REASONS.includes(reason);
}

module.exports = {
    CONNECTION_STATUS,
    NO_RECONNECT_REASONS,
    IMMEDIATE_RECONNECT_REASONS,
    RESILIENCE_CONFIG,
    PUPPETEER_CONFIG,
    WHATSAPP_CLIENT_CONFIG,
    calculateReconnectDelay,
    shouldReconnect,
    isImmediateReconnect
};
