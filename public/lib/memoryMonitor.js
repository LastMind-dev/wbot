/**
 * Monitor de Memória e Detecção de Sessões Zumbis
 * Detecta e recupera instâncias degradadas
 */

const { logger } = require('./logger');
const { RESILIENCE_CONFIG } = require('./config');

class MemoryMonitor {
    constructor() {
        this.lastCheck = null;
        this.memoryHistory = [];
        this.maxHistoryLength = 10;
        this.sessionManager = null;
        this.forceReconnectFn = null;
    }

    /**
     * Inicializa o monitor com referências necessárias
     */
    init(sessionManager, forceReconnectFn) {
        this.sessionManager = sessionManager;
        this.forceReconnectFn = forceReconnectFn;
        logger.info(null, 'MemoryMonitor inicializado');
    }

    /**
     * Coleta estatísticas de memória atuais
     */
    getMemoryStats() {
        const memUsage = process.memoryUsage();
        
        return {
            timestamp: Date.now(),
            rss: memUsage.rss,
            heapTotal: memUsage.heapTotal,
            heapUsed: memUsage.heapUsed,
            external: memUsage.external,
            arrayBuffers: memUsage.arrayBuffers || 0,
            rssMB: Math.round(memUsage.rss / 1024 / 1024),
            heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
            heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
            externalMB: Math.round(memUsage.external / 1024 / 1024),
            heapPercentage: ((memUsage.heapUsed / memUsage.heapTotal) * 100).toFixed(1)
        };
    }

    /**
     * Verifica se há vazamento de memória
     */
    detectMemoryLeak() {
        if (this.memoryHistory.length < 5) return false;

        // Verificar tendência de crescimento nos últimos 5 checks
        const recentHistory = this.memoryHistory.slice(-5);
        let increasingCount = 0;

        for (let i = 1; i < recentHistory.length; i++) {
            if (recentHistory[i].heapUsed > recentHistory[i - 1].heapUsed) {
                increasingCount++;
            }
        }

        // Se 4 dos últimos 5 checks mostraram aumento, possível leak
        return increasingCount >= 4;
    }

    /**
     * Calcula taxa de crescimento de memória
     */
    getMemoryGrowthRate() {
        if (this.memoryHistory.length < 2) return 0;

        const oldest = this.memoryHistory[0];
        const newest = this.memoryHistory[this.memoryHistory.length - 1];
        
        const timeDiff = (newest.timestamp - oldest.timestamp) / 1000 / 60; // minutos
        const memDiff = newest.heapUsed - oldest.heapUsed;
        
        // MB por minuto
        return timeDiff > 0 ? (memDiff / 1024 / 1024) / timeDiff : 0;
    }

    /**
     * Executa verificação completa de memória
     */
    async check() {
        const stats = this.getMemoryStats();
        this.lastCheck = stats;
        
        // Adicionar ao histórico
        this.memoryHistory.push(stats);
        if (this.memoryHistory.length > this.maxHistoryLength) {
            this.memoryHistory.shift();
        }

        const heapPercentage = parseFloat(stats.heapPercentage);
        const totalSessions = this.sessionManager?.size || 0;
        const connectedSessions = this.sessionManager?.filterByStatus('CONNECTED')?.length || 0;

        // Log periódico
        logger.memory(null, `Heap: ${stats.heapUsedMB}MB/${stats.heapTotalMB}MB (${stats.heapPercentage}%) | RSS: ${stats.rssMB}MB | Sessions: ${connectedSessions}/${totalSessions}`);

        // Verificar thresholds
        const issues = [];

        // Heap crítico
        if (heapPercentage >= RESILIENCE_CONFIG.HEAP_CRITICAL_THRESHOLD * 100) {
            issues.push({
                type: 'CRITICAL',
                message: `Heap crítico: ${stats.heapPercentage}%`,
                action: 'FORCE_GC'
            });
        } 
        // Heap alto
        else if (heapPercentage >= RESILIENCE_CONFIG.HEAP_WARNING_THRESHOLD * 100) {
            issues.push({
                type: 'WARNING',
                message: `Heap alto: ${stats.heapPercentage}%`,
                action: 'SUGGEST_GC'
            });
        }

        // Detectar leak
        if (this.detectMemoryLeak()) {
            const growthRate = this.getMemoryGrowthRate().toFixed(2);
            issues.push({
                type: 'WARNING',
                message: `Possível memory leak detectado. Crescimento: ${growthRate}MB/min`,
                action: 'MONITOR'
            });
        }

        // Heap total muito alto
        if (stats.heapUsed > RESILIENCE_CONFIG.MAX_TOTAL_HEAP) {
            issues.push({
                type: 'CRITICAL',
                message: `Heap total excedeu limite: ${stats.heapUsedMB}MB`,
                action: 'RESTART_DEGRADED'
            });
        }

        // Executar ações para issues
        for (const issue of issues) {
            if (issue.type === 'CRITICAL') {
                logger.error(null, issue.message);
            } else {
                logger.warn(null, issue.message);
            }

            if (issue.action === 'FORCE_GC' && global.gc) {
                logger.info(null, 'Forçando garbage collection...');
                global.gc();
            }

            if (issue.action === 'RESTART_DEGRADED') {
                await this.restartDegradedInstances();
            }
        }

        return {
            stats,
            issues,
            hasProblems: issues.length > 0
        };
    }

    /**
     * Detecta e lida com sessões zumbis
     */
    async detectZombies() {
        if (!this.sessionManager) return [];

        const zombies = this.sessionManager.getZombies();
        
        if (zombies.length > 0) {
            logger.warn(null, `Detectadas ${zombies.length} sessões zumbi`);
            
            for (const session of zombies) {
                logger.warn(session.instanceId, 'Sessão zumbi detectada - forçando reconexão');
                
                if (this.forceReconnectFn) {
                    await this.forceReconnectFn(session.instanceId, 'ZOMBIE_DETECTED');
                }
            }
        }

        return zombies;
    }

    /**
     * Detecta sessões travadas
     */
    async detectStuckSessions() {
        if (!this.sessionManager) return [];

        const stuck = this.sessionManager.getStuckSessions();
        
        if (stuck.length > 0) {
            logger.warn(null, `Detectadas ${stuck.length} sessões travadas`);
            
            for (const session of stuck) {
                logger.warn(session.instanceId, `Sessão travada em ${session.status} - forçando reconexão`);
                
                if (this.forceReconnectFn) {
                    await this.forceReconnectFn(session.instanceId, 'STUCK_IN_LOADING');
                }
            }
        }

        return stuck;
    }

    /**
     * Reinicia instâncias com memória degradada
     */
    async restartDegradedInstances() {
        if (!this.sessionManager || !this.forceReconnectFn) return;

        logger.warn(null, 'Iniciando restart de instâncias degradadas...');

        // Identificar instâncias mais antigas (provável leak)
        const sessions = this.sessionManager.toArray()
            .filter(s => s.status === 'CONNECTED')
            .sort((a, b) => a.createdAt - b.createdAt);

        // Reiniciar a instância mais antiga como tentativa de liberar memória
        if (sessions.length > 0) {
            const oldest = sessions[0];
            logger.warn(oldest.instanceId, 'Reiniciando instância mais antiga para liberar memória');
            await this.forceReconnectFn(oldest.instanceId, 'MEMORY_PRESSURE');
        }
    }

    /**
     * Verifica memória de instâncias individuais (via browser)
     */
    async checkInstanceMemory(session) {
        if (!session.client?.pupPage || session.client.pupPage.isClosed()) {
            return null;
        }

        try {
            const metrics = await Promise.race([
                session.client.pupPage.metrics(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
            ]);

            const heapUsedMB = Math.round(metrics.JSHeapUsedSize / 1024 / 1024);
            
            if (metrics.JSHeapUsedSize > RESILIENCE_CONFIG.MAX_HEAP_PER_INSTANCE) {
                logger.warn(session.instanceId, `Heap alto no browser: ${heapUsedMB}MB`);
                return { degraded: true, heapUsedMB };
            }

            return { degraded: false, heapUsedMB };
        } catch (e) {
            return null;
        }
    }

    /**
     * Retorna relatório completo de memória
     */
    getReport() {
        const stats = this.getMemoryStats();
        const hasLeak = this.detectMemoryLeak();
        const growthRate = this.getMemoryGrowthRate();
        
        return {
            current: stats,
            history: this.memoryHistory.map(h => ({
                timestamp: new Date(h.timestamp).toISOString(),
                heapUsedMB: h.heapUsedMB,
                heapPercentage: h.heapPercentage
            })),
            analysis: {
                possibleLeak: hasLeak,
                growthRateMBperMin: growthRate.toFixed(2),
                heapWarning: parseFloat(stats.heapPercentage) >= RESILIENCE_CONFIG.HEAP_WARNING_THRESHOLD * 100,
                heapCritical: parseFloat(stats.heapPercentage) >= RESILIENCE_CONFIG.HEAP_CRITICAL_THRESHOLD * 100
            },
            sessions: this.sessionManager ? {
                total: this.sessionManager.size,
                zombies: this.sessionManager.getZombies().length,
                stuck: this.sessionManager.getStuckSessions().length,
                inactive: this.sessionManager.getInactiveSessions().length
            } : null
        };
    }
}

// Singleton
const memoryMonitor = new MemoryMonitor();

module.exports = { MemoryMonitor, memoryMonitor };
