/**
 * ConnectionMonitor v4.0 — Monitor Unificado de Conexão
 *
 * Substitui os 6 monitores sobrepostos (heartbeat, watchdog, healthCheck,
 * deepHealthCheck, instanceRecovery, memoryMonitor) por 1 único sistema
 * centralizado com lógica de decisão sequencial.
 *
 * Regra principal: NUNCA dispara mais de 1 reconexão por instância por ciclo.
 */

const { logger } = require('./logger');
const { CONNECTION_STATUS, RESILIENCE_CONFIG } = require('./config');

// Estados do Circuit Breaker
const CB_STATE = {
    CLOSED: 'CLOSED',       // Normal - reconexões permitidas
    OPEN: 'OPEN',           // Bloqueado - muitas falhas, pausa
    HALF_OPEN: 'HALF_OPEN'  // Testando - permite tentativas limitadas
};

class CircuitBreaker {
    constructor(instanceId) {
        this.instanceId = instanceId;
        this.state = CB_STATE.CLOSED;
        this.failures = 0;
        this.halfOpenAttempts = 0;
        this.openedAt = null;
        this.lastFailure = null;
    }

    recordFailure() {
        this.failures++;
        this.lastFailure = Date.now();

        if (this.state === CB_STATE.HALF_OPEN) {
            // Falhou em half-open, voltar para open
            this.state = CB_STATE.OPEN;
            this.openedAt = Date.now();
            this.halfOpenAttempts = 0;
            logger.warn(this.instanceId, `Circuit breaker: HALF_OPEN → OPEN (falha em teste)`);
            return false;
        }

        if (this.failures >= RESILIENCE_CONFIG.MAX_RECONNECT_ATTEMPTS) {
            this.state = CB_STATE.OPEN;
            this.openedAt = Date.now();
            logger.warn(this.instanceId, `Circuit breaker: CLOSED → OPEN (${this.failures} falhas)`);
            return false;
        }

        return true; // Pode tentar reconectar
    }

    recordSuccess() {
        this.state = CB_STATE.CLOSED;
        this.failures = 0;
        this.halfOpenAttempts = 0;
        this.openedAt = null;
    }

    canReconnect() {
        if (this.state === CB_STATE.CLOSED) {
            return true;
        }

        if (this.state === CB_STATE.OPEN) {
            const elapsed = Date.now() - (this.openedAt || 0);
            if (elapsed >= RESILIENCE_CONFIG.CIRCUIT_OPEN_DURATION) {
                this.state = CB_STATE.HALF_OPEN;
                this.halfOpenAttempts = 0;
                logger.info(this.instanceId, `Circuit breaker: OPEN → HALF_OPEN (${Math.round(elapsed/1000)}s elapsed)`);
                return true;
            }
            return false;
        }

        if (this.state === CB_STATE.HALF_OPEN) {
            return this.halfOpenAttempts < RESILIENCE_CONFIG.CIRCUIT_HALF_OPEN_ATTEMPTS;
        }

        return false;
    }

    incrementHalfOpenAttempt() {
        this.halfOpenAttempts++;
    }

    toJSON() {
        return {
            state: this.state,
            failures: this.failures,
            openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
            lastFailure: this.lastFailure ? new Date(this.lastFailure).toISOString() : null
        };
    }
}

class ConnectionMonitor {
    constructor() {
        this.sessionManager = null;
        this.pool = null;
        this.forceReconnectFn = null;
        this.startSessionFn = null;
        this.interval = null;
        this.circuitBreakers = new Map();  // instanceId → CircuitBreaker
        this.reconnectingThisCycle = new Set(); // Prevents multiple reconnects per cycle
        this.memoryHistory = [];
        this.maxMemoryHistory = 10;
    }

    /**
     * Inicializa o monitor com as referências necessárias
     */
    init({ sessionManager, pool, forceReconnectFn, startSessionFn }) {
        this.sessionManager = sessionManager;
        this.pool = pool;
        this.forceReconnectFn = forceReconnectFn;
        this.startSessionFn = startSessionFn;
        logger.info(null, 'ConnectionMonitor unificado inicializado');
    }

    /**
     * Inicia o ciclo de monitoramento
     */
    start() {
        if (this.interval) {
            clearInterval(this.interval);
        }

        // Delay inicial para dar tempo das sessões iniciarem
        setTimeout(() => {
            this.interval = setInterval(() => this.runCycle(), RESILIENCE_CONFIG.MONITOR_INTERVAL);
            logger.info(null, `ConnectionMonitor: ciclo a cada ${RESILIENCE_CONFIG.MONITOR_INTERVAL / 1000}s`);
        }, RESILIENCE_CONFIG.MONITOR_STARTUP_DELAY);

        return this.interval;
    }

    /**
     * Para o monitoramento
     */
    stop() {
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }

    /**
     * Obtém ou cria circuit breaker para uma instância
     */
    getCircuitBreaker(instanceId) {
        if (!this.circuitBreakers.has(instanceId)) {
            this.circuitBreakers.set(instanceId, new CircuitBreaker(instanceId));
        }
        return this.circuitBreakers.get(instanceId);
    }

    /**
     * Executa um ciclo completo de monitoramento
     * Verifica TODAS as instâncias, mas no máximo 1 reconexão por instância por ciclo
     */
    async runCycle() {
        this.reconnectingThisCycle.clear();

        try {
            // 1. Verificar memória do processo
            this._checkMemory();

            // 2. Verificar sessões em memória
            await this._checkActiveSessions();

            // 3. Verificar instâncias que deveriam estar ativas (DB enabled=1)
            await this._checkMissingInstances();

        } catch (err) {
            logger.error(null, `ConnectionMonitor cycle error: ${err.message}`);
        }
    }

    /**
     * Verifica memória do processo (substitui memoryMonitor.check)
     */
    _checkMemory() {
        const memUsage = process.memoryUsage();
        const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
        const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);
        const heapPercentage = ((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(1);

        // Registrar no histórico
        this.memoryHistory.push({ timestamp: Date.now(), heapUsed: memUsage.heapUsed });
        if (this.memoryHistory.length > this.maxMemoryHistory) {
            this.memoryHistory.shift();
        }

        logger.memory(null, `Heap: ${heapUsedMB}MB/${heapTotalMB}MB (${heapPercentage}%) | Sessions: ${this.sessionManager ? this.sessionManager.size : 0}`);

        // Alerta se heap muito alto
        if (parseFloat(heapPercentage) >= RESILIENCE_CONFIG.HEAP_CRITICAL_THRESHOLD * 100) {
            logger.error(null, `Heap CRÍTICO: ${heapPercentage}%`);
            if (global.gc) {
                logger.info(null, 'Forçando garbage collection...');
                global.gc();
            }
        } else if (parseFloat(heapPercentage) >= RESILIENCE_CONFIG.HEAP_WARNING_THRESHOLD * 100) {
            logger.warn(null, `Heap ALTO: ${heapPercentage}%`);
        }
    }

    /**
     * Verifica todas as sessões ativas em memória
     */
    async _checkActiveSessions() {
        if (!this.sessionManager) return;

        for (const [instanceId, session] of this.sessionManager.entries()) {
            // Já reconectando neste ciclo? Skip
            if (this.reconnectingThisCycle.has(instanceId)) continue;
            if (session.isReconnecting || session.isShuttingDown) continue;

            try {
                await this._checkSession(instanceId, session);
            } catch (err) {
                logger.error(instanceId, `Erro ao verificar sessão: ${err.message}`);
            }
        }
    }

    /**
     * Verifica uma sessão individual — lógica de decisão sequencial
     * Retorna ao primeiro problema encontrado (sem cascata)
     */
    async _checkSession(instanceId, session) {
        const now = Date.now();

        // ─── 1. SESSÃO CONECTADA — verificar saúde ───
        if (session.status === CONNECTION_STATUS.CONNECTED) {

            // 1a. Browser morto?
            const browserOk = session.client && session.client.pupBrowser && session.client.pupBrowser.isConnected();
            if (!browserOk) {
                logger.error(instanceId, 'MONITOR: Browser morto');
                await this._triggerReconnect(instanceId, 'BROWSER_DEAD');
                return;
            }

            // 1b. Página fechada?
            const pageOk = session.client && session.client.pupPage && !session.client.pupPage.isClosed();
            if (!pageOk) {
                logger.error(instanceId, 'MONITOR: Página fechada');
                await this._triggerReconnect(instanceId, 'PAGE_CLOSED');
                return;
            }

            // 1c. Sem ping há muito tempo? (usa timestamps, não faz pupPage.evaluate)
            const timeSinceLastPing = now - (session.lastSuccessfulPing || session.lastActivity || now);
            if (timeSinceLastPing > RESILIENCE_CONFIG.PING_TIMEOUT_THRESHOLD) {
                logger.warn(instanceId, `MONITOR: Sem ping há ${Math.round(timeSinceLastPing / 1000)}s`);
                await this._triggerReconnect(instanceId, 'NO_PING');
                return;
            }

            // 1d. Muitos erros de contexto acumulados?
            if (session.contextErrors >= RESILIENCE_CONFIG.MAX_CONTEXT_ERRORS) {
                logger.warn(instanceId, `MONITOR: ${session.contextErrors} erros de contexto`);
                await this._triggerReconnect(instanceId, 'CONTEXT_ERRORS');
                return;
            }

            // 1e. Muitas falhas consecutivas?
            if (session.consecutiveFailures >= RESILIENCE_CONFIG.MAX_CONSECUTIVE_FAILURES) {
                logger.warn(instanceId, `MONITOR: ${session.consecutiveFailures} falhas consecutivas`);
                await this._triggerReconnect(instanceId, 'CONSECUTIVE_FAILURES');
                return;
            }

            // Tudo OK
            return;
        }

        // ─── 2. SESSÃO EM LOADING — verificar se travou ───
        if (session.status.startsWith('LOADING_') || session.status === CONNECTION_STATUS.INITIALIZING) {
            const loadingTime = now - (session.loadingStartTime || now);
            if (loadingTime > RESILIENCE_CONFIG.LOADING_TIMEOUT) {
                logger.warn(instanceId, `MONITOR: Travado em ${session.status} há ${Math.round(loadingTime / 1000)}s`);
                await this._triggerReconnect(instanceId, 'STUCK_LOADING');
                return;
            }
            // Ainda loading — dar mais tempo
            return;
        }

        // ─── 3. SESSÃO DESCONECTADA — tentar reconectar ───
        if (session.status === CONNECTION_STATUS.DISCONNECTED && !session.client) {
            logger.reconnect(instanceId, 'MONITOR: Sessão DISCONNECTED sem cliente — reconectando');
            await this._triggerReconnect(instanceId, 'DISCONNECTED');
            return;
        }

        // ─── 4. AUTH_FAILURE / INIT_ERROR — não forçar, esperar ação manual ou controlled reconnect ───
        // Esses estados são gerenciados pelos handlers de evento, não pelo monitor
    }

    /**
     * Verifica instâncias que deveriam estar ativas mas não estão
     */
    async _checkMissingInstances() {
        if (!this.pool || !this.startSessionFn) return;

        try {
            const [rows] = await this.pool.execute(
                'SELECT id, name FROM instances WHERE enabled = 1'
            );

            for (const row of rows) {
                if (this.reconnectingThisCycle.has(row.id)) continue;

                const session = this.sessionManager ? this.sessionManager.get(row.id) : null;

                if (!session) {
                    // Instância enabled sem sessão em memória
                    const cb = this.getCircuitBreaker(row.id);
                    if (!cb.canReconnect()) {
                        logger.warn(row.id, `MONITOR: Instância "${row.name}" sem sessão, mas circuit breaker OPEN`);
                        continue;
                    }

                    logger.reconnect(row.id, `MONITOR: Instância "${row.name}" enabled=1 sem sessão — iniciando`);
                    this.reconnectingThisCycle.add(row.id);

                    try {
                        await this.startSessionFn(row.id);
                        cb.recordSuccess();
                    } catch (err) {
                        cb.recordFailure();
                        logger.error(row.id, `Erro ao iniciar instância: ${err.message}`);
                    }

                    // Delay entre inicializaç��es
                    await new Promise(resolve => setTimeout(resolve, 5000));
                }
            }
        } catch (err) {
            logger.error(null, `Erro ao verificar instâncias: ${err.message}`);
        }
    }

    /**
     * Dispara reconexão com proteção de circuit breaker
     * Garante no máximo 1 reconexão por instância por ciclo
     */
    async _triggerReconnect(instanceId, reason) {
        if (this.reconnectingThisCycle.has(instanceId)) {
            return; // Já reconectando neste ciclo
        }

        const cb = this.getCircuitBreaker(instanceId);

        if (!cb.canReconnect()) {
            const timeLeft = cb.openedAt
                ? Math.round((RESILIENCE_CONFIG.CIRCUIT_OPEN_DURATION - (Date.now() - cb.openedAt)) / 1000)
                : '?';
            logger.warn(instanceId, `Circuit breaker OPEN — reconexão bloqueada (${reason}). Reabre em ${timeLeft}s`);
            return;
        }

        this.reconnectingThisCycle.add(instanceId);

        if (cb.state === CB_STATE.HALF_OPEN) {
            cb.incrementHalfOpenAttempt();
        }

        if (this.forceReconnectFn) {
            try {
                await this.forceReconnectFn(instanceId, reason);
            } catch (err) {
                cb.recordFailure();
                logger.error(instanceId, `Erro na reconexão (${reason}): ${err.message}`);
            }
        }
    }

    /**
     * Notifica sucesso de conexão (chamado externamente quando sessão conecta)
     */
    onConnected(instanceId) {
        const cb = this.getCircuitBreaker(instanceId);
        cb.recordSuccess();
    }

    /**
     * Notifica falha de reconexão (chamado externamente quando reconexão falha)
     */
    onReconnectFailed(instanceId) {
        const cb = this.getCircuitBreaker(instanceId);
        cb.recordFailure();
    }

    /**
     * Retorna relatório de saúde para API
     */
    getHealthReport() {
        const memUsage = process.memoryUsage();
        const circuitBreakers = {};

        for (const [id, cb] of this.circuitBreakers.entries()) {
            if (cb.state !== CB_STATE.CLOSED || cb.failures > 0) {
                circuitBreakers[id] = cb.toJSON();
            }
        }

        return {
            monitorActive: !!this.interval,
            intervalMs: RESILIENCE_CONFIG.MONITOR_INTERVAL,
            memory: {
                heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
                heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
                rssMB: Math.round(memUsage.rss / 1024 / 1024),
                heapPercentage: ((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(1)
            },
            circuitBreakers,
            sessions: this.sessionManager ? this.sessionManager.getHealthSummary() : null
        };
    }
}

// Singleton
const connectionMonitor = new ConnectionMonitor();

module.exports = { ConnectionMonitor, connectionMonitor, CircuitBreaker, CB_STATE };
