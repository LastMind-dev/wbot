/**
 * Sistema de Logs Estruturados para WhatsApp Bot
 * Categorias: INFO, WARN, ERROR, RECONNECT, SESSION, HEALTH, MEMORY
 */

const LOG_LEVELS = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
    SESSION: 1,
    RECONNECT: 1,
    HEALTH: 1,
    MEMORY: 1
};

const LOG_COLORS = {
    DEBUG: '\x1b[90m',    // Cinza
    INFO: '\x1b[36m',     // Ciano
    WARN: '\x1b[33m',     // Amarelo
    ERROR: '\x1b[31m',    // Vermelho
    SESSION: '\x1b[35m',  // Magenta
    RECONNECT: '\x1b[34m', // Azul
    HEALTH: '\x1b[32m',   // Verde
    MEMORY: '\x1b[95m',   // Magenta claro
    RESET: '\x1b[0m'
};

const LOG_ICONS = {
    DEBUG: '🔍',
    INFO: 'ℹ️',
    WARN: '⚠️',
    ERROR: '❌',
    SESSION: '📱',
    RECONNECT: '🔄',
    HEALTH: '🏥',
    MEMORY: '🧠'
};

class StructuredLogger {
    constructor(options = {}) {
        this.minLevel = options.minLevel || 'INFO';
        this.enableColors = options.enableColors !== false;
        this.enableTimestamp = options.enableTimestamp !== false;
        this.instancePrefix = options.instancePrefix || null;
    }

    _shouldLog(level) {
        const minLevelValue = LOG_LEVELS[this.minLevel] || 0;
        const currentLevelValue = LOG_LEVELS[level] || 1;
        return currentLevelValue >= minLevelValue;
    }

    _formatTimestamp() {
        const now = new Date();
        return now.toISOString().replace('T', ' ').substring(0, 19);
    }

    _formatMessage(level, category, instanceId, message, data = null) {
        const parts = [];
        
        if (this.enableTimestamp) {
            parts.push(`[${this._formatTimestamp()}]`);
        }

        const icon = LOG_ICONS[level] || LOG_ICONS[category] || '';
        const color = this.enableColors ? (LOG_COLORS[level] || LOG_COLORS[category] || '') : '';
        const reset = this.enableColors ? LOG_COLORS.RESET : '';

        parts.push(`${color}[${level}]${reset}`);
        
        if (category && category !== level) {
            parts.push(`[${category}]`);
        }

        if (instanceId) {
            parts.push(`[${instanceId}]`);
        }

        parts.push(`${icon} ${message}`);

        let output = parts.join(' ');

        if (data) {
            if (typeof data === 'object') {
                output += ` | ${JSON.stringify(data)}`;
            } else {
                output += ` | ${data}`;
            }
        }

        return output;
    }

    log(level, category, instanceId, message, data = null) {
        if (!this._shouldLog(level)) return;

        const formattedMessage = this._formatMessage(level, category, instanceId, message, data);
        
        if (level === 'ERROR') {
            console.error(formattedMessage);
        } else if (level === 'WARN') {
            console.warn(formattedMessage);
        } else {
            console.log(formattedMessage);
        }
    }

    // Métodos de conveniência
    debug(instanceId, message, data = null) {
        this.log('DEBUG', 'DEBUG', instanceId, message, data);
    }

    info(instanceId, message, data = null) {
        this.log('INFO', 'INFO', instanceId, message, data);
    }

    warn(instanceId, message, data = null) {
        this.log('WARN', 'WARN', instanceId, message, data);
    }

    error(instanceId, message, data = null) {
        this.log('ERROR', 'ERROR', instanceId, message, data);
    }

    session(instanceId, message, data = null) {
        this.log('INFO', 'SESSION', instanceId, message, data);
    }

    reconnect(instanceId, message, data = null) {
        this.log('INFO', 'RECONNECT', instanceId, message, data);
    }

    health(instanceId, message, data = null) {
        this.log('INFO', 'HEALTH', instanceId, message, data);
    }

    memory(instanceId, message, data = null) {
        this.log('INFO', 'MEMORY', instanceId, message, data);
    }

    // Log de startup do servidor
    startup(message) {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`🚀 ${message}`);
        console.log(`${'═'.repeat(60)}\n`);
    }

    // Log de seção
    section(title) {
        console.log(`\n${'─'.repeat(40)}`);
        console.log(`  ${title}`);
        console.log(`${'─'.repeat(40)}`);
    }

    // Log de configuração
    config(key, value) {
        console.log(`   • ${key}: ${value}`);
    }
}

// Instância singleton
const logger = new StructuredLogger({
    minLevel: process.env.LOG_LEVEL || 'INFO',
    enableColors: process.env.NODE_ENV !== 'production'
});

module.exports = { StructuredLogger, logger };
