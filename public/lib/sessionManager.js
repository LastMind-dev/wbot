/**
 * Gerenciador de Sessões WhatsApp com Resiliência Avançada
 * Responsável por: estado, reconexão, health check, monitoramento
 */

const { logger } = require('./logger');
const { 
    CONNECTION_STATUS, 
    RESILIENCE_CONFIG, 
    calculateReconnectDelay,
    shouldReconnect,
    isImmediateReconnect
} = require('./config');

/**
 * Classe que encapsula o estado de uma sessão WhatsApp
 */
class SessionState {
    constructor(instanceId) {
        this.instanceId = instanceId;
        this.client = null;
        this.qr = null;
        this.status = CONNECTION_STATUS.DISCONNECTED;
        
        // Timestamps
        this.createdAt = Date.now();
        this.loadingStartTime = null;
        this.lastActivity = Date.now();
        this.lastPing = null;
        this.lastSuccessfulPing = null;
        this.lastDeepCheck = null;
        this.lastSessionSave = null;
        this.authenticatedAt = null;
        this.disconnectTime = null;
        
        // Contadores
        this.reconnectAttempts = 0;
        this.consecutiveFailures = 0;
        this.contextErrors = 0;
        this.wsCheckFailures = 0;
        
        // Flags
        this.isReconnecting = false;
        this.needsReconnect = false;
        this.isShuttingDown = false;
        
        // Intervalos (para cleanup)
        this.intervals = {
            keepAlive: null,
            websocketCheck: null,
            presence: null,
            watchdog: null,
            gc: null,
            connectionMonitor: null
        };
        
        // Metadados
        this.disconnectReason = null;
        this.authFailureReason = null;
        this.lastState = null;
    }

    /**
     * Atualiza o status da sessão
     */
    setStatus(newStatus) {
        const oldStatus = this.status;
        this.status = newStatus;
        this.lastActivity = Date.now();
        
        if (oldStatus !== newStatus) {
            logger.session(this.instanceId, `Status: ${oldStatus} → ${newStatus}`);
        }
        
        return this;
    }

    /**
     * Registra atividade (para detectar inatividade)
     */
    touch() {
        this.lastActivity = Date.now();
        return this;
    }

    /**
     * Registra ping bem-sucedido
     */
    recordPing() {
        this.lastPing = Date.now();
        this.lastSuccessfulPing = Date.now();
        this.consecutiveFailures = 0;
        this.contextErrors = 0;
        return this;
    }

    /**
     * Registra falha de ping
     */
    recordFailure(isContextError = false) {
        if (isContextError) {
            this.contextErrors++;
        } else {
            this.consecutiveFailures++;
        }
        return this;
    }

    /**
     * Verifica se atingiu limite de falhas
     */
    hasExceededFailureThreshold() {
        return this.consecutiveFailures >= RESILIENCE_CONFIG.MAX_CONSECUTIVE_FAILURES ||
               this.contextErrors >= RESILIENCE_CONFIG.MAX_CONTEXT_ERRORS;
    }

    /**
     * Verifica se a sessão está inativa
     */
    isInactive() {
        const inactiveTime = Date.now() - this.lastActivity;
        return inactiveTime > RESILIENCE_CONFIG.INACTIVITY_THRESHOLD;
    }

    /**
     * Verifica se está travada em loading
     */
    isStuckInLoading() {
        if (!this.status.startsWith('LOADING') && this.status !== CONNECTION_STATUS.INITIALIZING) {
            return false;
        }
        const loadingTime = Date.now() - (this.loadingStartTime || Date.now());
        return loadingTime > RESILIENCE_CONFIG.LOADING_TIMEOUT;
    }

    /**
     * Verifica se é uma sessão zumbi (conectada mas não responde)
     */
    isZombie() {
        if (this.status !== CONNECTION_STATUS.CONNECTED) return false;
        
        const timeSinceLastPing = Date.now() - (this.lastSuccessfulPing || Date.now());
        return timeSinceLastPing > RESILIENCE_CONFIG.ZOMBIE_THRESHOLD;
    }

    /**
     * Limpa todos os intervalos da sessão
     */
    clearIntervals() {
        Object.keys(this.intervals).forEach(key => {
            if (this.intervals[key]) {
                clearInterval(this.intervals[key]);
                this.intervals[key] = null;
            }
        });
        return this;
    }

    /**
     * Prepara a sessão para reconexão
     */
    prepareForReconnect() {
        this.isReconnecting = true;
        this.clearIntervals();
        return this;
    }

    /**
     * Reseta contadores após conexão bem-sucedida
     */
    resetCounters() {
        this.reconnectAttempts = 0;
        this.consecutiveFailures = 0;
        this.contextErrors = 0;
        this.wsCheckFailures = 0;
        this.isReconnecting = false;
        this.needsReconnect = false;
        return this;
    }

    /**
     * Incrementa tentativa de reconexão
     */
    incrementReconnectAttempts() {
        this.reconnectAttempts++;
        
        // Reset após máximo atingido (sistema resiliente)
        if (this.reconnectAttempts >= RESILIENCE_CONFIG.MAX_RECONNECT_ATTEMPTS) {
            logger.warn(this.instanceId, `Máximo de tentativas atingido (${RESILIENCE_CONFIG.MAX_RECONNECT_ATTEMPTS}), resetando contador`);
            this.reconnectAttempts = 0;
        }
        
        return this;
    }

    /**
     * Retorna objeto serializado para API
     */
    toJSON() {
        return {
            instanceId: this.instanceId,
            status: this.status,
            hasClient: !!this.client,
            hasBrowser: this.client?.pupBrowser?.isConnected() || false,
            hasPage: this.client?.pupPage && !this.client.pupPage.isClosed(),
            hasQr: !!this.qr,
            lastActivity: this.lastActivity,
            lastPing: this.lastSuccessfulPing,
            reconnectAttempts: this.reconnectAttempts,
            consecutiveFailures: this.consecutiveFailures,
            isReconnecting: this.isReconnecting,
            uptime: this.status === CONNECTION_STATUS.CONNECTED ? 
                    Date.now() - (this.authenticatedAt || this.createdAt) : 0
        };
    }
}

/**
 * Gerenciador central de sessões
 */
class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.isShuttingDown = false;
    }

    /**
     * Obtém ou cria uma sessão
     */
    getOrCreate(instanceId) {
        if (!this.sessions.has(instanceId)) {
            this.sessions.set(instanceId, new SessionState(instanceId));
        }
        return this.sessions.get(instanceId);
    }

    /**
     * Obtém uma sessão existente
     */
    get(instanceId) {
        return this.sessions.get(instanceId);
    }

    /**
     * Verifica se existe uma sessão
     */
    has(instanceId) {
        return this.sessions.has(instanceId);
    }

    /**
     * Remove uma sessão
     */
    delete(instanceId) {
        const session = this.sessions.get(instanceId);
        if (session) {
            session.clearIntervals();
        }
        return this.sessions.delete(instanceId);
    }

    /**
     * Retorna número de sessões
     */
    get size() {
        return this.sessions.size;
    }

    /**
     * Retorna todas as sessões
     */
    entries() {
        return this.sessions.entries();
    }

    /**
     * Retorna array de sessões
     */
    toArray() {
        return Array.from(this.sessions.values());
    }

    /**
     * Filtra sessões por status
     */
    filterByStatus(status) {
        return this.toArray().filter(s => s.status === status);
    }

    /**
     * Conta sessões por status
     */
    countByStatus() {
        const counts = {};
        for (const session of this.sessions.values()) {
            counts[session.status] = (counts[session.status] || 0) + 1;
        }
        return counts;
    }

    /**
     * Detecta sessões zumbis
     */
    getZombies() {
        return this.toArray().filter(s => s.isZombie());
    }

    /**
     * Detecta sessões travadas em loading
     */
    getStuckSessions() {
        return this.toArray().filter(s => s.isStuckInLoading());
    }

    /**
     * Detecta sessões inativas
     */
    getInactiveSessions() {
        return this.toArray().filter(s => 
            s.status === CONNECTION_STATUS.CONNECTED && s.isInactive()
        );
    }

    /**
     * Calcula uso de memória estimado
     */
    getMemoryStats() {
        const processMemory = process.memoryUsage();
        return {
            totalSessions: this.size,
            connectedSessions: this.filterByStatus(CONNECTION_STATUS.CONNECTED).length,
            rss: processMemory.rss,
            heapTotal: processMemory.heapTotal,
            heapUsed: processMemory.heapUsed,
            external: processMemory.external,
            rssMB: Math.round(processMemory.rss / 1024 / 1024),
            heapUsedMB: Math.round(processMemory.heapUsed / 1024 / 1024),
            heapPercentage: (processMemory.heapUsed / processMemory.heapTotal * 100).toFixed(1)
        };
    }

    /**
     * Prepara todas as sessões para shutdown
     */
    prepareForShutdown() {
        this.isShuttingDown = true;
        for (const session of this.sessions.values()) {
            session.isShuttingDown = true;
            session.clearIntervals();
        }
    }

    /**
     * Retorna resumo para API de health
     */
    getHealthSummary() {
        const stats = this.countByStatus();
        const memory = this.getMemoryStats();
        const zombies = this.getZombies();
        const stuck = this.getStuckSessions();

        return {
            total: this.size,
            byStatus: stats,
            zombies: zombies.length,
            stuck: stuck.length,
            memory,
            sessions: this.toArray().map(s => s.toJSON())
        };
    }
}

// Singleton
const sessionManager = new SessionManager();

module.exports = { SessionState, SessionManager, sessionManager };
