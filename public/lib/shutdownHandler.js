/**
 * Handler de Shutdown Gracioso
 * Garante que todas as sessões sejam encerradas corretamente
 */

const { logger } = require('./logger');
const { RESILIENCE_CONFIG } = require('./config');

class ShutdownHandler {
    constructor() {
        this.isShuttingDown = false;
        this.shutdownCallbacks = [];
        this.intervals = [];
        this.sessionManager = null;
        this.pool = null;
    }

    /**
     * Inicializa o handler com referências necessárias
     */
    init(sessionManager, pool) {
        this.sessionManager = sessionManager;
        this.pool = pool;
        this._registerSignals();
        logger.info(null, 'ShutdownHandler inicializado');
    }

    /**
     * Registra um intervalo para ser limpo no shutdown
     */
    registerInterval(interval) {
        this.intervals.push(interval);
    }

    /**
     * Registra callback para ser executado no shutdown
     */
    onShutdown(callback) {
        this.shutdownCallbacks.push(callback);
    }

    /**
     * Registra handlers de sinais do sistema
     */
    _registerSignals() {
        // SIGINT (Ctrl+C)
        process.on('SIGINT', () => this._handleShutdown('SIGINT'));
        
        // SIGTERM (kill)
        process.on('SIGTERM', () => this._handleShutdown('SIGTERM'));

        // Windows: Ctrl+Break
        process.on('SIGBREAK', () => this._handleShutdown('SIGBREAK'));

        // Uncaught Exception
        process.on('uncaughtException', (err) => {
            logger.error(null, 'Uncaught Exception', { 
                message: err.message, 
                stack: err.stack?.split('\n').slice(0, 3).join(' | ')
            });
            // NÃO derrubar o processo, apenas logar
        });

        // Unhandled Promise Rejection
        process.on('unhandledRejection', (reason, promise) => {
            logger.error(null, 'Unhandled Rejection', { 
                reason: reason?.message || reason,
                promise: String(promise).substring(0, 100)
            });
            // NÃO derrubar o processo, apenas logar
        });

        // Aviso de memória baixa (se disponível)
        if (process.on) {
            process.on('warning', (warning) => {
                logger.warn(null, 'Process Warning', {
                    name: warning.name,
                    message: warning.message
                });
            });
        }
    }

    /**
     * Executa shutdown gracioso
     */
    async _handleShutdown(signal) {
        if (this.isShuttingDown) {
            logger.warn(null, `Shutdown já em andamento, ignorando ${signal}`);
            return;
        }

        this.isShuttingDown = true;
        logger.section(`SHUTDOWN GRACIOSO - ${signal}`);

        const startTime = Date.now();
        const timeout = RESILIENCE_CONFIG.GRACEFUL_SHUTDOWN_TIMEOUT;

        try {
            // 1. Parar todos os intervalos registrados
            logger.info(null, `Parando ${this.intervals.length} intervalos...`);
            for (const interval of this.intervals) {
                if (interval) clearInterval(interval);
            }

            // 2. Preparar sessões para shutdown
            if (this.sessionManager) {
                this.sessionManager.prepareForShutdown();
                logger.info(null, `Preparando ${this.sessionManager.size} sessões para shutdown...`);
            }

            // 3. Executar callbacks registrados
            for (const callback of this.shutdownCallbacks) {
                try {
                    await Promise.race([
                        callback(),
                        new Promise(resolve => setTimeout(resolve, 5000))
                    ]);
                } catch (e) {
                    logger.error(null, `Erro em callback de shutdown: ${e.message}`);
                }
            }

            // 4. Destruir todas as sessões de forma segura
            if (this.sessionManager) {
                const destroyPromises = [];
                
                for (const [instanceId, session] of this.sessionManager.entries()) {
                    if (session.client) {
                        const destroyPromise = (async () => {
                            try {
                                logger.info(instanceId, 'Destruindo cliente...');
                                
                                // Salvar estado no banco
                                if (this.pool) {
                                    await this.pool.execute(
                                        'UPDATE instances SET connection_status = ? WHERE id = ?',
                                        ['DISCONNECTED', instanceId]
                                    ).catch(() => {});
                                }

                                // Remover listeners
                                session.client.removeAllListeners();
                                
                                // Destruir com timeout
                                await Promise.race([
                                    session.client.destroy(),
                                    new Promise(resolve => setTimeout(resolve, RESILIENCE_CONFIG.DESTROY_TIMEOUT))
                                ]);
                                
                                logger.info(instanceId, 'Cliente destruído com sucesso');
                            } catch (e) {
                                // Ignorar erros de contexto destruído
                                if (!e.message?.includes('context') && !e.message?.includes('destroyed')) {
                                    logger.error(instanceId, `Erro ao destruir: ${e.message}`);
                                }
                            }
                        })();
                        
                        destroyPromises.push(destroyPromise);
                    }
                }

                // Aguardar todas as destruições com timeout global
                await Promise.race([
                    Promise.all(destroyPromises),
                    new Promise(resolve => setTimeout(resolve, timeout - 5000))
                ]);
            }

            // 5. Fechar pool do banco de dados
            if (this.pool) {
                try {
                    logger.info(null, 'Fechando conexão com banco de dados...');
                    await this.pool.end();
                } catch (e) {
                    logger.error(null, `Erro ao fechar pool: ${e.message}`);
                }
            }

            const elapsed = Date.now() - startTime;
            logger.info(null, `Shutdown completo em ${elapsed}ms`);
            
        } catch (e) {
            logger.error(null, `Erro durante shutdown: ${e.message}`);
        } finally {
            // Forçar saída após timeout
            setTimeout(() => {
                logger.warn(null, 'Forçando saída do processo...');
                process.exit(0);
            }, 1000);
        }
    }

    /**
     * Força shutdown imediato (emergência)
     */
    forceShutdown() {
        logger.error(null, 'SHUTDOWN FORÇADO INICIADO');
        process.exit(1);
    }
}

// Singleton
const shutdownHandler = new ShutdownHandler();

module.exports = { ShutdownHandler, shutdownHandler };
