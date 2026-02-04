/**
 * MessageQueue - Sistema de fila de mensagens pendentes
 * Armazena mensagens quando instância está desconectada e processa quando reconectar
 */

class MessageQueue {
    constructor() {
        // Fila por instância: Map<instanceId, Array<QueuedMessage>>
        this.queues = new Map();
        
        // Configurações
        this.maxQueueSize = 100;      // Máximo de mensagens por instância
        this.maxRetries = 3;          // Tentativas por mensagem
        this.retryDelay = 2000;       // Delay entre tentativas (ms)
        this.messageTimeout = 300000; // Mensagens expiram em 5 minutos
        
        // Callbacks
        this.onReconnectNeeded = null;
        this.onMessageSent = null;
        this.onMessageFailed = null;
        this.logger = console;
    }

    /**
     * Configura callbacks e dependências
     */
    configure(options) {
        if (options.onReconnectNeeded) this.onReconnectNeeded = options.onReconnectNeeded;
        if (options.onMessageSent) this.onMessageSent = options.onMessageSent;
        if (options.onMessageFailed) this.onMessageFailed = options.onMessageFailed;
        if (options.logger) this.logger = options.logger;
        if (options.maxQueueSize) this.maxQueueSize = options.maxQueueSize;
        if (options.messageTimeout) this.messageTimeout = options.messageTimeout;
    }

    /**
     * Adiciona mensagem à fila
     * @returns {Object} { queued: boolean, position: number, willReconnect: boolean }
     */
    enqueue(instanceId, message) {
        if (!this.queues.has(instanceId)) {
            this.queues.set(instanceId, []);
        }

        const queue = this.queues.get(instanceId);

        // Verificar limite
        if (queue.length >= this.maxQueueSize) {
            this.logger.warn && this.logger.warn(instanceId, `Fila cheia (${this.maxQueueSize}), removendo mensagem mais antiga`);
            queue.shift(); // Remove a mais antiga
        }

        const queuedMessage = {
            id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
            instanceId,
            type: message.type || 'text',
            to: message.to,
            content: message.content,
            mediaUrl: message.mediaUrl,
            filename: message.filename,
            caption: message.caption,
            buttons: message.buttons,
            createdAt: Date.now(),
            retries: 0,
            status: 'pending'
        };

        queue.push(queuedMessage);

        this.logger.info && this.logger.info(instanceId, `Mensagem enfileirada (posição ${queue.length}): ${message.to}`);

        // Solicitar reconexão
        let willReconnect = false;
        if (this.onReconnectNeeded) {
            willReconnect = true;
            this.onReconnectNeeded(instanceId);
        }

        return {
            queued: true,
            messageId: queuedMessage.id,
            position: queue.length,
            willReconnect
        };
    }

    /**
     * Processa a fila de uma instância (chamado quando reconectar)
     */
    async processQueue(instanceId, sendFunction) {
        const queue = this.queues.get(instanceId);
        if (!queue || queue.length === 0) {
            return { processed: 0, failed: 0 };
        }

        this.logger.info && this.logger.info(instanceId, `Processando ${queue.length} mensagens pendentes...`);

        let processed = 0;
        let failed = 0;

        // Processar em ordem (FIFO)
        while (queue.length > 0) {
            const message = queue[0];

            // Verificar se expirou
            if (Date.now() - message.createdAt > this.messageTimeout) {
                this.logger.warn && this.logger.warn(instanceId, `Mensagem ${message.id} expirada, removendo`);
                queue.shift();
                failed++;
                if (this.onMessageFailed) {
                    this.onMessageFailed(instanceId, message, 'EXPIRED');
                }
                continue;
            }

            try {
                // Tentar enviar
                await sendFunction(message);
                
                // Sucesso - remover da fila
                queue.shift();
                processed++;
                message.status = 'sent';
                
                this.logger.info && this.logger.info(instanceId, `Mensagem ${message.id} enviada com sucesso`);
                
                if (this.onMessageSent) {
                    this.onMessageSent(instanceId, message);
                }

                // Pequeno delay entre mensagens para não sobrecarregar
                await new Promise(resolve => setTimeout(resolve, 500));

            } catch (err) {
                message.retries++;
                message.lastError = err.message;

                if (message.retries >= this.maxRetries) {
                    // Falhou definitivamente
                    queue.shift();
                    failed++;
                    message.status = 'failed';
                    
                    this.logger.error && this.logger.error(instanceId, `Mensagem ${message.id} falhou após ${this.maxRetries} tentativas: ${err.message}`);
                    
                    if (this.onMessageFailed) {
                        this.onMessageFailed(instanceId, message, err.message);
                    }
                } else {
                    // Tentar novamente depois
                    this.logger.warn && this.logger.warn(instanceId, `Mensagem ${message.id} falhou, tentativa ${message.retries}/${this.maxRetries}`);
                    await new Promise(resolve => setTimeout(resolve, this.retryDelay));
                }
            }
        }

        this.logger.info && this.logger.info(instanceId, `Fila processada: ${processed} enviadas, ${failed} falharam`);

        return { processed, failed };
    }

    /**
     * Retorna o tamanho da fila de uma instância
     */
    getQueueSize(instanceId) {
        const queue = this.queues.get(instanceId);
        return queue ? queue.length : 0;
    }

    /**
     * Retorna todas as mensagens pendentes de uma instância
     */
    getQueue(instanceId) {
        return this.queues.get(instanceId) || [];
    }

    /**
     * Limpa a fila de uma instância
     */
    clearQueue(instanceId) {
        this.queues.delete(instanceId);
    }

    /**
     * Remove mensagens expiradas de todas as filas
     */
    cleanupExpired() {
        let removed = 0;
        for (const [instanceId, queue] of this.queues.entries()) {
            const before = queue.length;
            const now = Date.now();
            
            // Filtrar mensagens não expiradas
            const filtered = queue.filter(msg => now - msg.createdAt < this.messageTimeout);
            
            if (filtered.length !== before) {
                this.queues.set(instanceId, filtered);
                removed += before - filtered.length;
            }
        }
        return removed;
    }

    /**
     * Retorna estatísticas gerais
     */
    getStats() {
        let totalMessages = 0;
        const byInstance = {};

        for (const [instanceId, queue] of this.queues.entries()) {
            totalMessages += queue.length;
            byInstance[instanceId] = {
                pending: queue.length,
                oldest: queue.length > 0 ? new Date(queue[0].createdAt).toISOString() : null
            };
        }

        return {
            totalQueued: totalMessages,
            instances: this.queues.size,
            byInstance
        };
    }
}

// Singleton
const messageQueue = new MessageQueue();

module.exports = { messageQueue, MessageQueue };
