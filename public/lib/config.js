/**
 * Configurações Centralizadas para Resiliência do WhatsApp Bot
 * Todas as constantes de tempo, limites e thresholds em um só lugar
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
    // INTERVALOS DE VERIFICAÇÃO (em ms)
    // Valores mais conservadores para evitar desconexões por excesso de checks
    // ═══════════════════════════════════════════════════════════════
    HEARTBEAT_INTERVAL: 180000, // Ping a cada 3 MINUTOS (era 45s - muito agressivo!)
    WEBSOCKET_CHECK_INTERVAL: 0, // DESABILITADO - redundante com heartbeat e causa instabilidade
    PRESENCE_UPDATE_INTERVAL: 0, // DESABILITADO - WhatsApp detecta automação
    HEALTH_CHECK_INTERVAL: 300000, // Health check a cada 5 MIN (era 90s)
    DEEP_HEALTH_CHECK_INTERVAL: 1800000, // Deep check a cada 30 MIN (era 10min)
    RECOVERY_CHECK_INTERVAL: 300000, // Recovery check a cada 5 MIN (era 3min)
    MEMORY_CHECK_INTERVAL: 900000, // Verificar memória a cada 15 min (era 10min)
    ZOMBIE_CHECK_INTERVAL: 600000, // Verificar zumbis a cada 10 min (era 5min)

    // ═══════════════════════════════════════════════════════════════
    // TIMEOUTS (em ms)
    // ═══════════════════════════════════════════════════════════════
    STATE_CHECK_TIMEOUT: 15000, // Timeout para verificar estado
    DESTROY_TIMEOUT: 10000, // Timeout para destruir cliente
    INIT_TIMEOUT: 180000, // 3 min para inicialização
    DEEP_CHECK_TIMEOUT: 20000, // Timeout para deep check
    GRACEFUL_SHUTDOWN_TIMEOUT: 30000, // 30s para shutdown gracioso

    // ═══════════════════════════════════════════════════════════════
    // LIMITES DE RECONEXÃO
    // ═══════════════════════════════════════════════════════════════
    MAX_RECONNECT_ATTEMPTS: 20, // Máximo de tentativas antes de pausar
    MAX_CONSECUTIVE_FAILURES: 10, // Falhas antes de forçar reconexão (era 5 - ainda sensível)
    RECONNECT_RESET_AFTER: 1800000, // Reset contador após 30 min conectado

    // ═══════════════════════════════════════════════════════════════
    // DELAYS DE RECONEXÃO (em ms)
    // ═══════════════════════════════════════════════════════════════
    RECONNECT_BASE_DELAY: 5000, // Delay base (5s)
    RECONNECT_MAX_DELAY: 300000, // Delay máximo (5 min)
    RECONNECT_IMMEDIATE_DELAY: 3000, // Delay para reconexão imediata
    RECONNECT_JITTER_MAX: 3000, // Jitter máximo aleatório

    // ═══════════════════════════════════════════════════════════════
    // THRESHOLDS (em ms)
    // Valores mais tolerantes para evitar falsos positivos
    // ═══════════════════════════════════════════════════════════════
    INACTIVITY_THRESHOLD: 900000, // 15 min sem atividade = problema (era 10min)
    LOADING_TIMEOUT: 300000, // 5 min máximo em loading
    PING_TIMEOUT_THRESHOLD: 600000, // 10 min sem ping = problema (era 5min)
    ZOMBIE_THRESHOLD: 1800000, // 30 min = sessão zumbi (era 15min)

    // ═══════════════════════════════════════════════════════════════
    // PROTEÇÃO CONTRA ERROS DE CONTEXTO
    // Mais tolerante a erros temporários
    // ═══════════════════════════════════════════════════════════════
    CONTEXT_ERROR_COOLDOWN: 10000, // Espera após erro de contexto
    MAX_CONTEXT_ERRORS: 15, // Máximo antes de reconectar (era 8)
    PAGE_NAVIGATION_DELAY: 5000, // Delay após navegação

    // ═══════════════════════════════════════════════════════════════
    // LIMITES DE MEMÓRIA (em bytes)
    // ═══════════════════════════════════════════════════════════════
    MAX_HEAP_PER_INSTANCE: 500 * 1024 * 1024, // 500MB por instância
    MAX_TOTAL_HEAP: 2 * 1024 * 1024 * 1024, // 2GB total
    HEAP_WARNING_THRESHOLD: 0.8, // 80% = alerta
    HEAP_CRITICAL_THRESHOLD: 0.95, // 95% = crítico

    // ═══════════════════════════════════════════════════════════════
    // CAMINHOS
    // ═══════════════════════════════════════════════════════════════
    SESSION_STORAGE_PATH: process.env.SESSION_STORAGE_PATH || path.join(__dirname, '..', '.wwebjs_auth'),
    CACHE_PATH: process.env.CACHE_PATH || path.join(__dirname, '..', '.wwebjs_cache'),

    // ═══════════════════════════════════════════════════════════════
    // FLAGS DE FUNCIONALIDADE
    // ═══════════════════════════════════════════════════════════════
    ENABLE_AUTO_RECONNECT: true,
    ENABLE_HEALTH_CHECK: true,
    ENABLE_DEEP_HEALTH_CHECK: false, // DESABILITADO - causa instabilidade com pupPage.evaluate extensivo
    ENABLE_MEMORY_MONITORING: true,
    ENABLE_ZOMBIE_DETECTION: true,
    ENABLE_AUTO_RECOVERY: true
};

// Configurações do Puppeteer otimizadas para estabilidade
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
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows',
        '--disable-background-timer-throttling',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-domain-reliability',
        '--disable-component-update',
        '--disable-breakpad',
        '--disable-features=site-per-process',
        '--enable-features=NetworkService,NetworkServiceInProcess',
        '--force-color-profile=srgb',
        '--disable-web-security',
        '--allow-running-insecure-content',
        '--js-flags="--max-old-space-size=512"',
        '--memory-pressure-off',
        '--max_old_space_size=512'
    ],
    timeout: 60000,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false
};

// Configurações do cliente WhatsApp
const WHATSAPP_CLIENT_CONFIG = {
    takeoverOnConflict: true,
    takeoverTimeoutMs: 10000,
    authTimeoutMs: 0,
    qrMaxRetries: 0,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    restartOnAuthFail: true,
    bypassCSP: true
};

/**
 * Calcula delay com backoff exponencial e jitter
 * @param {number} attempt - Número da tentativa (0-indexed)
 * @param {boolean} immediate - Se deve usar delay curto
 * @returns {number} Delay em milissegundos
 */
function calculateReconnectDelay(attempt, immediate = false) {
    if (immediate) {
        // Delay curto com pequeno incremento
        return RESILIENCE_CONFIG.RECONNECT_IMMEDIATE_DELAY + (attempt * 1500);
    }

    // Backoff exponencial: base * (1.5 ^ attempt)
    const exponentialDelay = RESILIENCE_CONFIG.RECONNECT_BASE_DELAY * Math.pow(1.5, attempt);

    // Limitar ao máximo
    const cappedDelay = Math.min(exponentialDelay, RESILIENCE_CONFIG.RECONNECT_MAX_DELAY);

    // Adicionar jitter aleatório
    const jitter = Math.random() * RESILIENCE_CONFIG.RECONNECT_JITTER_MAX;

    return Math.floor(cappedDelay + jitter);
}

/**
 * Verifica se uma razão de desconexão deve permitir reconexão
 * @param {string} reason - Razão da desconexão
 * @returns {boolean}
 */
function shouldReconnect(reason) {
    return !NO_RECONNECT_REASONS.includes(reason);
}

/**
 * Verifica se uma razão requer reconexão imediata
 * @param {string} reason - Razão da desconexão
 * @returns {boolean}
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