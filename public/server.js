const { Client, LocalAuth, RemoteAuth, MessageMedia } = require('./index');
const { MysqlStore } = require('./lib/MysqlStore');
const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
require('dotenv').config();

// ========================================
// MÓDULOS DE RESILIÊNCIA v4.0
// ========================================
const { logger } = require('./lib/logger');
const {
    CONNECTION_STATUS,
    RESILIENCE_CONFIG,
    PUPPETEER_CONFIG,
    WHATSAPP_CLIENT_CONFIG,
    calculateReconnectDelay,
    shouldReconnect,
    isImmediateReconnect
} = require('./lib/config');
const { sessionManager } = require('./lib/sessionManager');
const { shutdownHandler } = require('./lib/shutdownHandler');
const { messageQueue } = require('./lib/messageQueue');
const { connectionMonitor } = require('./lib/connectionMonitor');
const { startupCleanup, forceKillClientBrowser } = require('./lib/processCleanup');

// ========================================
// VERSÃO DO CÓDIGO
// ========================================
const CODE_VERSION = '4.0.0-stable';
const CODE_BUILD_DATE = new Date().toISOString().split('T')[0];

// ========================================
// BUFFER DE LOGS EM MEMÓRIA
// ========================================
const LOG_BUFFER_MAX = 500;
const logBuffer = [];

function addToLogBuffer(level, message) {
    const entry = {
        time: new Date().toISOString(),
        level,
        msg: typeof message === 'string' ? message : String(message)
    };
    logBuffer.push(entry);
    if (logBuffer.length > LOG_BUFFER_MAX) {
        logBuffer.shift();
    }
}

function safeStringify(obj) {
    try {
        const str = JSON.stringify(obj);
        return str && str.length > 2000 ? str.substring(0, 2000) + '...[truncated]' : str;
    } catch (e) {
        return '[Circular/Unstringifiable Object]';
    }
}

const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

console.log = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? safeStringify(a) : String(a)).join(' ');
    addToLogBuffer('INFO', msg);
    originalConsoleLog(...args);
};

console.error = (...args) => {
    const msg = args.map(a => {
        if (a instanceof Error) return `${a.message}\n${a.stack}`;
        if (typeof a === 'object') return safeStringify(a);
        return String(a);
    }).join(' ');
    addToLogBuffer('ERROR', msg);
    originalConsoleError(...args);
};

console.warn = (...args) => {
    const msg = args.map(a => typeof a === 'object' ? safeStringify(a) : String(a)).join(' ');
    addToLogBuffer('WARN', msg);
    originalConsoleWarn(...args);
};

console.log(`[STARTUP] Code version: ${CODE_VERSION} | Build: ${CODE_BUILD_DATE}`);

// ========================================
// LIMPEZA DE STARTUP
// ========================================
startupCleanup(RESILIENCE_CONFIG.SESSION_STORAGE_PATH);

// ========================================
// CONFIGURAÇÃO MULTER
// ========================================
const uploadDir = path.join(__dirname, 'tmp', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 16 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain',
            'audio/mpeg', 'audio/ogg', 'audio/wav',
            'video/mp4', 'video/mpeg'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo não suportado: ' + file.mimetype), false);
        }
    }
});

// ========================================
// EXPRESS APP
// ========================================
const app = express();
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Muitas requisições deste IP, tente novamente mais tarde.'
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: process.env.JWT_SECRET || 'segredo_padrao_super_seguro',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 3600000,
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

const protectedStaticPaths = new Set(['/dashboard.html', '/dashboard.js', '/dashboard.css', '/grupos.html']);
app.use((req, res, next) => {
    if (!protectedStaticPaths.has(req.path)) return next();
    if (req.session && req.session.user) return next();
    if (req.path.endsWith('.html')) return res.redirect('/login');
    return res.status(401).send('Unauthorized');
});
app.use(express.static('public'));

function requireAuth(req, res, next) {
    if (req.session && req.session.user) return next();
    res.redirect('/login');
}

// ========================================
// DATABASE
// ========================================
const DB_PASSWORD_ENV = process.env.DB_PASSWORD || process.env.DB_PASS;
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'usr_wbot1',
    password: DB_PASSWORD_ENV || '',
    database: process.env.DB_NAME || 'tabel_wbot1',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
};

let pool;
let mysqlStore = null;

const USE_REMOTE_AUTH = process.env.USE_REMOTE_AUTH ? process.env.USE_REMOTE_AUTH === 'true' : true;
const BACKUP_SYNC_INTERVAL = parseInt(process.env.BACKUP_SYNC_INTERVAL) || 120000;

// Referência direta ao Map interno para compatibilidade
const sessions = sessionManager.sessions;
const remoteSessionBackupTimers = new Map();
const controlledReconnectTimers = new Map();
const DELETE_SESSION_ON_AUTH_FAILURE = process.env.DELETE_SESSION_ON_AUTH_FAILURE === 'true';

function clearControlledReconnect(instanceId) {
    const timer = controlledReconnectTimers.get(instanceId);
    if (timer) {
        clearTimeout(timer);
        controlledReconnectTimers.delete(instanceId);
    }
}

function scheduleControlledReconnect(instanceId, delayMs, reason) {
    clearControlledReconnect(instanceId);
    logger.reconnect(instanceId, `Reconexão controlada em ${Math.round(delayMs / 1000)}s (${reason})`);
    const timer = setTimeout(async () => {
        controlledReconnectTimers.delete(instanceId);
        try {
            await forceReconnect(instanceId, reason);
        } catch (err) {
            logger.error(instanceId, `Erro na reconexão controlada (${reason}): ${err.message}`);
        }
    }, delayMs);
    controlledReconnectTimers.set(instanceId, timer);
}

// ========================================
// FORCE RECONNECT — com guard que dura até completar
// ========================================
const forceReconnectInProgress = new Set();

async function forceReconnect(instanceId, reason) {
    // GUARD: Impedir reconexões concorrentes — NÃO libera até startSession completar
    if (forceReconnectInProgress.has(instanceId)) {
        logger.reconnect(instanceId, `forceReconnect já em andamento, ignorando (reason=${reason})`);
        return;
    }
    forceReconnectInProgress.add(instanceId);

    logger.reconnect(instanceId, `Forçando reconexão: ${reason}`);

    const session = sessionManager.get(instanceId);
    let attempts = 0;

    if (session) {
        attempts = session.reconnectAttempts || 0;
        session.prepareForReconnect();

        try {
            if (session.client) {
                session.client.removeAllListeners();

                const destroyed = await Promise.race([
                    session.client.destroy().then(() => true),
                    new Promise(resolve => setTimeout(() => resolve(false), RESILIENCE_CONFIG.DESTROY_TIMEOUT))
                ]);

                // Se destroy deu timeout, force kill do browser
                if (!destroyed) {
                    logger.warn(instanceId, 'destroy() timeout — force killing browser');
                    await forceKillClientBrowser(session.client);
                }
            }
        } catch (e) {
            const errMsg = e && e.message ? e.message : '';
            if (!errMsg.includes('context') && !errMsg.includes('destroyed')) {
                logger.error(instanceId, `Erro ao destruir cliente: ${errMsg}`);
            }
        }

        sessionManager.delete(instanceId);
    }

    await updateInstanceStatus(instanceId, 0, null, CONNECTION_STATUS.RECONNECTING, reason);

    const isImmediate = isImmediateReconnect(reason);
    const delay = calculateReconnectDelay(attempts, isImmediate);

    logger.reconnect(instanceId, `Reconectando em ${Math.round(delay / 1000)}s (tentativa ${attempts + 1})`);

    // O guard é mantido dentro do setTimeout e só liberado após startSession
    setTimeout(async () => {
        try {
            if (!sessionManager.has(instanceId)) {
                const newSession = await startSession(instanceId);
                if (newSession) {
                    newSession.incrementReconnectAttempts();

                    // Resetar contador após 30 min conectado
                    setTimeout(() => {
                        const s = sessionManager.get(instanceId);
                        if (s && s.status === CONNECTION_STATUS.CONNECTED) {
                            s.resetCounters();
                            connectionMonitor.onConnected(instanceId);
                            logger.session(instanceId, 'Contadores resetados (30min estável)');
                        }
                    }, RESILIENCE_CONFIG.RECONNECT_RESET_AFTER);
                } else {
                    connectionMonitor.onReconnectFailed(instanceId);
                }
            }
        } catch (err) {
            logger.error(instanceId, `Erro na reconexão: ${err.message}`);
            connectionMonitor.onReconnectFailed(instanceId);
        } finally {
            // GUARD liberado APENAS aqui, após startSession completar
            forceReconnectInProgress.delete(instanceId);
        }
    }, delay);
}

// ========================================
// UPDATE INSTANCE STATUS
// ========================================
async function updateInstanceStatus(instanceId, status, phoneNumber = null, connectionStatus = null, disconnectReason = null) {
    if (!pool) return;
    try {
        let query = 'UPDATE instances SET status = ?, last_connection = NOW()';
        const params = [status];

        if (phoneNumber) { query += ', phone_number = ?'; params.push(phoneNumber); }

        query += ', connection_status = ?';
        params.push(connectionStatus || (status === 1 ? CONNECTION_STATUS.CONNECTED : CONNECTION_STATUS.DISCONNECTED));

        if (disconnectReason) { query += ', last_disconnect_reason = ?'; params.push(disconnectReason); }

        query += ' WHERE id = ?';
        params.push(instanceId);

        await pool.execute(query, params);
    } catch (error) {
        logger.error(instanceId, `Erro ao atualizar status: ${error.message}`);
    }
}

// ========================================
// REMOTE SESSION BACKUP CHECK
// ========================================
function scheduleRemoteSessionBackupCheck(instanceId, delayMs = 45000, trigger = 'unknown') {
    if (!USE_REMOTE_AUTH || !mysqlStore) return;

    const existingTimer = remoteSessionBackupTimers.get(instanceId);
    if (existingTimer) clearTimeout(existingTimer);

    const timer = setTimeout(async () => {
        remoteSessionBackupTimers.delete(instanceId);
        try {
            const session = sessionManager.get(instanceId);
            if (!session || !session.client || !session.client.authStrategy) return;
            if (typeof session.client.authStrategy.storeRemoteSession !== 'function') return;

            const sessionName = `RemoteAuth-${instanceId}`;
            const exists = await mysqlStore.sessionExists({ session: sessionName });
            if (exists) return;

            const allowedStatuses = [CONNECTION_STATUS.CONNECTED, 'AUTHENTICATED'];
            if (!allowedStatuses.includes(session.status)) return;

            logger.warn(instanceId, `Sessão RemoteAuth não persistida após ${Math.round(delayMs / 1000)}s (${trigger}) — backup forçado`);
            await session.client.authStrategy.storeRemoteSession({ emit: true });
        } catch (err) {
            logger.error(instanceId, `Erro ao verificar backup RemoteAuth (${trigger}): ${err.message}`);
        }
    }, delayMs);

    remoteSessionBackupTimers.set(instanceId, timer);
}

// ========================================
// SESSION LOCKING (local + distributed)
// ========================================
const startSessionLocks = new Set();
const mysqlLockConnections = new Map();

async function acquireMySQLLock(instanceId, timeoutSec = 5) {
    if (!pool) return true;
    try {
        const connection = await pool.getConnection();
        const [rows] = await connection.execute(
            'SELECT GET_LOCK(CONCAT(\'wa:\', ?), ?) AS acquired', [instanceId, timeoutSec]
        );
        if (rows[0].acquired === 1) {
            mysqlLockConnections.set(instanceId, connection);
            return true;
        }
        connection.release();
        return true; // Fallback: lock local protege
    } catch (e) {
        return true;
    }
}

async function releaseMySQLLock(instanceId) {
    if (!pool) return;
    const connection = mysqlLockConnections.get(instanceId);
    if (!connection) return;
    try {
        await connection.execute('SELECT RELEASE_LOCK(CONCAT(\'wa:\', ?)) AS released', [instanceId]);
    } catch (e) { }
    finally {
        try { connection.release(); } catch (_) { }
        mysqlLockConnections.delete(instanceId);
    }
}

// ========================================
// START SESSION
// ========================================
async function startSession(instanceId) {
    if (startSessionLocks.has(instanceId)) {
        logger.session(instanceId, 'startSession já em andamento, ignorando');
        return sessionManager.get(instanceId) || null;
    }
    startSessionLocks.add(instanceId);

    const gotLock = await acquireMySQLLock(instanceId);
    if (!gotLock) {
        startSessionLocks.delete(instanceId);
        return sessionManager.get(instanceId) || null;
    }

    try {
        return await _startSessionInternal(instanceId);
    } finally {
        startSessionLocks.delete(instanceId);
        await releaseMySQLLock(instanceId);
    }
}

async function _startSessionInternal(instanceId) {
    // Verificar sessão existente
    if (sessionManager.has(instanceId)) {
        const existingSession = sessionManager.get(instanceId);
        const restartableStatuses = [
            CONNECTION_STATUS.DISCONNECTED,
            CONNECTION_STATUS.AUTH_FAILURE,
            CONNECTION_STATUS.INIT_ERROR,
            CONNECTION_STATUS.SYNC_TIMEOUT
        ];

        if (existingSession.client && !restartableStatuses.includes(existingSession.status)) {
            return existingSession;
        }

        if (restartableStatuses.includes(existingSession.status)) {
            try {
                if (existingSession.client) {
                    existingSession.client.removeAllListeners();
                    const destroyed = await Promise.race([
                        existingSession.client.destroy().then(() => true),
                        new Promise(resolve => setTimeout(() => resolve(false), RESILIENCE_CONFIG.DESTROY_TIMEOUT))
                    ]);
                    if (!destroyed) await forceKillClientBrowser(existingSession.client);
                }
            } catch (e) { }
            sessionManager.delete(instanceId);
        }
    }

    logger.session(instanceId, 'Iniciando sessão...');
    await updateInstanceStatus(instanceId, 0, null, CONNECTION_STATUS.INITIALIZING);

    // ─── Auth Strategy ───
    let authStrategy;
    const dataPath = RESILIENCE_CONFIG.SESSION_STORAGE_PATH;

    if (USE_REMOTE_AUTH && mysqlStore) {
        try {
            const migrated = await mysqlStore.migrateFromLocalAuth(instanceId, dataPath);
            if (migrated) logger.session(instanceId, 'Sessão LocalAuth migrada para MySQL');
        } catch (e) { }

        authStrategy = new RemoteAuth({
            clientId: instanceId,
            dataPath: dataPath,
            store: mysqlStore,
            backupSyncIntervalMs: BACKUP_SYNC_INTERVAL
        });
        logger.session(instanceId, `Usando RemoteAuth (MySQL) — backup a cada ${BACKUP_SYNC_INTERVAL / 1000}s`);
    } else {
        authStrategy = new LocalAuth({ clientId: instanceId, dataPath: dataPath });
        logger.session(instanceId, 'Usando LocalAuth (arquivos locais)');
    }

    // ─── Client — usa PUPPETEER_CONFIG do config.js (single source of truth) ───
    const client = new Client({
        authStrategy: authStrategy,
        puppeteer: { ...PUPPETEER_CONFIG },
        ...WHATSAPP_CLIENT_CONFIG
    });

    // ─── Session State ───
    const sess = sessionManager.getOrCreate(instanceId);
    sess.client = client;
    sess.qr = null;
    sess.status = CONNECTION_STATUS.INITIALIZING;
    sess.loadingStartTime = Date.now();
    sess.lastActivity = Date.now();
    sess.lastPing = Date.now();
    sess.isReconnecting = false;

    // ─── Heartbeat simplificado — apenas 1, usa pupBrowser.isConnected() ───
    const startHeartbeat = () => {
        const currentSession = sessionManager.get(instanceId);
        if (!currentSession) return;
        currentSession.clearIntervals();

        currentSession.intervals.keepAlive = setInterval(async () => {
            const s = sessionManager.get(instanceId);
            if (!s || !s.client || s.status !== CONNECTION_STATUS.CONNECTED || s.isReconnecting) return;

            try {
                const browserOk = s.client.pupBrowser && s.client.pupBrowser.isConnected();
                if (!browserOk) {
                    logger.error(instanceId, 'HEARTBEAT: Browser morto');
                    await forceReconnect(instanceId, 'BROWSER_DEAD');
                    return;
                }

                const pageOk = s.client.pupPage && !s.client.pupPage.isClosed();
                if (!pageOk) {
                    logger.error(instanceId, 'HEARTBEAT: Página fechada');
                    await forceReconnect(instanceId, 'PAGE_CLOSED');
                    return;
                }

                // Probe leve: getState() com timeout
                const state = await Promise.race([
                    s.client.getState(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), RESILIENCE_CONFIG.STATE_CHECK_TIMEOUT))
                ]);

                s.recordPing();

                if (state === 'CONFLICT') {
                    logger.warn(instanceId, 'HEARTBEAT: Conflito — executando takeover');
                    await executeTakeover(s, instanceId);
                } else if (state !== 'CONNECTED') {
                    logger.warn(instanceId, `HEARTBEAT: Estado anômalo = ${state}`);
                    s.recordFailure(false);
                }
            } catch (err) {
                const sessNow = sessionManager.get(instanceId);
                if (!sessNow) return;

                const isContextError = err.message.includes('context') ||
                    err.message.includes('destroyed') ||
                    err.message.includes('navigation') ||
                    err.message.includes('Target closed');

                if (isContextError) {
                    sessNow.recordFailure(true);
                } else {
                    sessNow.recordFailure(false);
                }

                // NÃO reconecta aqui — o connectionMonitor decide centralmente
            }
        }, RESILIENCE_CONFIG.MONITOR_INTERVAL);
    };

    // ─── Puppeteer reactive listeners ───
    const setupBrowserListeners = () => {
        try {
            if (client.pupBrowser) {
                client.pupBrowser.on('disconnected', () => {
                    const s = sessionManager.get(instanceId);
                    if (s && s.status === CONNECTION_STATUS.CONNECTED && !s.isReconnecting) {
                        logger.error(instanceId, 'Browser DISCONNECTED event — forçando reconexão');
                        forceReconnect(instanceId, 'BROWSER_DISCONNECTED');
                    }
                });
            }
            if (client.pupPage) {
                client.pupPage.on('error', (err) => {
                    logger.error(instanceId, `Page ERROR event: ${err.message}`);
                    const s = sessionManager.get(instanceId);
                    if (s) s.recordFailure(true);
                });
            }
        } catch (e) { }
    };

    // ─── Takeover helper ───
    const executeTakeover = async (session, instId) => {
        try {
            if (session.client && session.client.pupPage) {
                await session.client.pupPage.evaluate(() => {
                    if (window.Store && window.Store.AppState) window.Store.AppState.takeover();
                });
            }
        } catch (e) { }
    };

    // ═══════════════════════════════════════
    // EVENT HANDLERS
    // ═══════════════════════════════════════

    client.on('loading_screen', (percent, message) => {
        const s = sessionManager.get(instanceId);
        if (s) {
            s.status = `LOADING_${percent}%`;
            s.lastActivity = Date.now();

            if (percent === 100) {
                s.loadingComplete = Date.now();
                setTimeout(async () => {
                    const cs = sessionManager.get(instanceId);
                    if (cs && cs.status.startsWith('LOADING_')) {
                        cs.status = CONNECTION_STATUS.SYNC_TIMEOUT;
                    }
                }, 60000);
            }
        }
    });

    client.on('change_state', async (state) => {
        const s = sessionManager.get(instanceId);
        if (!s) return;
        s.lastActivity = Date.now();
        s.lastState = state;

        if (state === 'CONNECTED') {
            const needsForce = s.status.startsWith('LOADING_') ||
                s.status === CONNECTION_STATUS.SYNC_TIMEOUT ||
                s.status === 'AUTHENTICATED' ||
                s.status === 'SYNC_FAILED';

            if (needsForce) {
                s.setStatus(CONNECTION_STATUS.CONNECTED);
                s.qr = null;
                s.reconnectAttempts = 0;
                connectionMonitor.onConnected(instanceId);

                try {
                    const info = s.client.info;
                    await updateInstanceStatus(instanceId, 1, info && info.wid ? info.wid.user : null);
                } catch (e) {
                    await updateInstanceStatus(instanceId, 1);
                }

                startHeartbeat();
                setupBrowserListeners();

                if (s.client && s.client.authStrategy) {
                    s.client.authStrategy.afterAuthReady().catch(() => { });
                }
            }
        } else if (state === 'CONFLICT') {
            setTimeout(() => executeTakeover(s, instanceId), 2000);
        } else if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
            s.status = CONNECTION_STATUS.QR_CODE;
        }
    });

    let authFailureCount = 0;
    const AUTH_FAILURE_DELETE_THRESHOLD = 3;

    client.on('qr', (qr) => {
        const s = sessionManager.get(instanceId);
        if (s) {
            s.qr = qr;
            s.status = CONNECTION_STATUS.QR_CODE;
            s.lastActivity = Date.now();
        }
    });

    client.on('ready', async () => {
        logger.session(instanceId, 'Cliente READY — conectado!');
        clearControlledReconnect(instanceId);
        authFailureCount = 0;

        const s = sessionManager.get(instanceId);
        if (s) {
            s.setStatus(CONNECTION_STATUS.CONNECTED);
            s.qr = null;
            s.reconnectAttempts = 0;
            connectionMonitor.onConnected(instanceId);
            startHeartbeat();
            setupBrowserListeners();
        }

        const info = client.info;
        await updateInstanceStatus(instanceId, 1, info.wid.user, CONNECTION_STATUS.CONNECTED);
        scheduleRemoteSessionBackupCheck(instanceId, 30000, 'ready');

        // Processar fila de mensagens pendentes
        const queueSize = messageQueue.getQueueSize(instanceId);
        if (queueSize > 0) {
            setTimeout(async () => {
                try {
                    const result = await messageQueue.processQueue(instanceId, async (msg) => {
                        const chatId = msg.to.includes('@') ? msg.to : `${msg.to}@c.us`;
                        if (msg.type === 'text') {
                            await client.sendMessage(chatId, msg.content);
                        } else if (msg.type === 'media') {
                            const media = await MessageMedia.fromUrl(msg.mediaUrl);
                            await client.sendMessage(chatId, media, { caption: msg.caption });
                        }
                    });
                    logger.info(instanceId, `Fila processada: ${result.processed} enviadas, ${result.failed} falharam`);
                } catch (err) {
                    logger.error(instanceId, `Erro ao processar fila: ${err.message}`);
                }
            }, 2000);
        }
    });

    client.on('authenticated', () => {
        clearControlledReconnect(instanceId);
        const s = sessionManager.get(instanceId);
        if (s) {
            s.status = 'AUTHENTICATED';
            s.authenticatedAt = Date.now();
            scheduleRemoteSessionBackupCheck(instanceId, 45000, 'authenticated');

            // Verificar se ready não dispara
            const checkAuth = async (attempt = 1) => {
                const cs = sessionManager.get(instanceId);
                if (!cs || cs.status !== 'AUTHENTICATED') return;

                try {
                    if (cs.client && cs.client.pupPage && !cs.client.pupPage.isClosed()) {
                        const state = await Promise.race([
                            cs.client.getState(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
                        ]);

                        if (state === 'CONNECTED') {
                            cs.setStatus(CONNECTION_STATUS.CONNECTED);
                            cs.qr = null;
                            connectionMonitor.onConnected(instanceId);

                            try {
                                const info = cs.client.info;
                                await updateInstanceStatus(instanceId, 1, info && info.wid ? info.wid.user : null);
                            } catch (e) {
                                await updateInstanceStatus(instanceId, 1);
                            }

                            startHeartbeat();
                            setupBrowserListeners();

                            if (cs.client && cs.client.authStrategy) {
                                cs.client.authStrategy.afterAuthReady().catch(() => { });
                            }
                            return;
                        }
                    }
                } catch (e) { }

                if (attempt < 10) {
                    setTimeout(() => checkAuth(attempt + 1), 15000);
                } else {
                    const cs2 = sessionManager.get(instanceId);
                    if (cs2 && cs2.status === 'AUTHENTICATED') {
                        cs2.status = CONNECTION_STATUS.SYNC_TIMEOUT;
                    }
                }
            };

            setTimeout(() => checkAuth(1), 10000);
        }
    });

    client.on('auth_failure', async (msg) => {
        authFailureCount++;
        logger.error(instanceId, `Auth failure (${authFailureCount}/${AUTH_FAILURE_DELETE_THRESHOLD}): ${msg}`);

        const s = sessionManager.get(instanceId);
        if (s) {
            s.status = CONNECTION_STATUS.AUTH_FAILURE;
            s.authFailureReason = msg;
        }

        if (authFailureCount >= AUTH_FAILURE_DELETE_THRESHOLD) {
            if (DELETE_SESSION_ON_AUTH_FAILURE && USE_REMOTE_AUTH && mysqlStore) {
                const sessionName = `RemoteAuth-${instanceId}`;
                try {
                    const exists = await mysqlStore.sessionExists({ session: sessionName });
                    if (exists) await mysqlStore.delete({ session: sessionName });
                } catch (e) { }

                const remoteSessionPath = path.join(__dirname, '.wwebjs_auth', `RemoteAuth-${instanceId}`);
                if (fs.existsSync(remoteSessionPath)) {
                    try { fs.rmSync(remoteSessionPath, { recursive: true, force: true }); } catch (e) { }
                }
                clearControlledReconnect(instanceId);
            } else {
                scheduleControlledReconnect(instanceId, 180000, 'AUTH_FAILURE_PERSISTENTE');
            }
            authFailureCount = 0;
        } else {
            scheduleControlledReconnect(instanceId, Math.min(300000, 45000 * authFailureCount), `AUTH_FAILURE_${authFailureCount}`);
        }
    });

    client.on('remote_session_saved', () => {
        const s = sessionManager.get(instanceId);
        if (s) s.lastSessionSave = Date.now();
    });

    client.on('call', async () => {
        const s = sessionManager.get(instanceId);
        if (s) s.lastActivity = Date.now();
    });

    client.on('disconnected', async (reason) => {
        logger.error(instanceId, `DISCONNECTED — Reason: ${reason}`);
        clearControlledReconnect(instanceId);
        await updateInstanceStatus(instanceId, 0, null, CONNECTION_STATUS.DISCONNECTED, reason);

        const s = sessionManager.get(instanceId);
        let reconnectAttempts = 0;

        if (s) {
            s.clearIntervals();
            reconnectAttempts = s.reconnectAttempts || 0;
            s.setStatus(CONNECTION_STATUS.DISCONNECTED);
            s.client = null;
            s.disconnectReason = reason;
            s.disconnectTime = Date.now();
        }
        sessionManager.delete(instanceId);

        if (!shouldReconnect(reason)) {
            logger.warn(instanceId, `Reconexão desabilitada para: ${reason}`);
            if (pool) await pool.execute('UPDATE instances SET enabled = 0 WHERE id = ?', [instanceId]).catch(() => { });
            return;
        }

        // Circuit breaker check
        const cb = connectionMonitor.getCircuitBreaker(instanceId);
        if (!cb.canReconnect()) {
            logger.warn(instanceId, 'Circuit breaker OPEN — não reconecta');
            return;
        }

        const isImmediate = isImmediateReconnect(reason);
        const delay = calculateReconnectDelay(reconnectAttempts, isImmediate);

        logger.reconnect(instanceId, `Reconexão automática em ${Math.round(delay / 1000)}s (tentativa ${reconnectAttempts + 1})`);

        setTimeout(async () => {
            try {
                if (pool) {
                    const [rows] = await pool.execute('SELECT enabled FROM instances WHERE id = ?', [instanceId]);
                    if (rows.length === 0 || rows[0].enabled !== 1) return;
                }

                if (!sessionManager.has(instanceId)) {
                    await updateInstanceStatus(instanceId, 0, null, CONNECTION_STATUS.RECONNECTING);
                    const newSession = await startSession(instanceId);
                    if (newSession) {
                        newSession.reconnectAttempts = reconnectAttempts + 1;
                    } else {
                        cb.recordFailure();
                    }
                }
            } catch (err) {
                logger.error(instanceId, `Erro na reconexão automática: ${err.message}`);
                cb.recordFailure();
            }
        }, delay);
    });

    // Mensagens recebidas — webhook genérico apenas
    client.on('message', async (msg) => {
        const s = sessionManager.get(instanceId);
        if (s) s.lastActivity = Date.now();

        // Forward para webhook genérico (se configurado)
        if (pool) {
            try {
                const [rows] = await pool.execute('SELECT webhook FROM instances WHERE id = ?', [instanceId]);
                if (rows.length > 0 && rows[0].webhook) {
                    const phone = msg.from.replace('@c.us', '');
                    const payload = {
                        telefone: phone,
                        message: msg.body,
                        instance_id: instanceId,
                        message_id: msg.id._serialized,
                        from: msg.from,
                        timestamp: msg.timestamp
                    };

                    axios.post(rows[0].webhook, payload).catch(err => {
                        logger.error(instanceId, `Webhook error: ${err.message}`);
                    });
                }
            } catch (e) { }
        }
    });

    // ─── Initialize ───
    try {
        const initPromise = client.initialize();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout: Inicialização demorou mais de 3 minutos')), RESILIENCE_CONFIG.INIT_TIMEOUT);
        });
        await Promise.race([initPromise, timeoutPromise]);
    } catch (err) {
        logger.error(instanceId, `Falha na inicialização: ${err.message}`);
        const s = sessionManager.get(instanceId);
        if (s) s.status = CONNECTION_STATUS.INIT_ERROR;
        try { await client.destroy(); } catch (e) { }
        sessionManager.delete(instanceId);
    }

    return sessionManager.get(instanceId);
}

// ========================================
// STOP SESSION
// ========================================
async function stopSession(instanceId) {
    const session = sessionManager.get(instanceId);
    if (!session || !session.client) return false;

    try {
        session.clearIntervals();
        session.client.removeAllListeners();
        await Promise.race([
            session.client.destroy(),
            new Promise(resolve => setTimeout(resolve, RESILIENCE_CONFIG.DESTROY_TIMEOUT))
        ]);
        sessionManager.delete(instanceId);
        await updateInstanceStatus(instanceId, 0);
        return true;
    } catch (err) {
        logger.error(instanceId, `Erro ao parar sessão: ${err.message}`);
        sessionManager.delete(instanceId);
        return false;
    }
}

// ========================================
// INIT DATABASE
// ========================================
async function initDB() {
    try {
        pool = mysql.createPool(dbConfig);
        logger.info(null, 'Database pool created');

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS instances (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255),
                sistema_php_url VARCHAR(500),
                webhook VARCHAR(500),
                api_token VARCHAR(255),
                phone_number VARCHAR(50),
                status INT DEFAULT 0,
                enabled TINYINT(1) DEFAULT 1,
                connection_status VARCHAR(50) DEFAULT 'DISCONNECTED',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                last_connection TIMESTAMP NULL,
                last_disconnect_reason VARCHAR(255) NULL,
                reconnect_attempts INT DEFAULT 0
            )
        `);

        const columnsToAdd = [
            { name: 'enabled', definition: 'TINYINT(1) DEFAULT 1' },
            { name: 'connection_status', definition: "VARCHAR(50) DEFAULT 'DISCONNECTED'" },
            { name: 'last_disconnect_reason', definition: 'VARCHAR(255) NULL' },
            { name: 'reconnect_attempts', definition: 'INT DEFAULT 0' },
            { name: 'name', definition: 'VARCHAR(255) AFTER id' }
        ];
        for (const col of columnsToAdd) {
            try { await pool.execute(`ALTER TABLE instances ADD COLUMN ${col.name} ${col.definition}`); } catch (e) { }
        }

        await pool.execute(`UPDATE instances SET enabled = 1 WHERE status = 1 AND enabled IS NULL`).catch(() => { });

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', ['admin']);
        if (users.length === 0) {
            const randomPassword = crypto.randomBytes(8).toString('hex');
            const hash = await bcrypt.hash(randomPassword, 10);
            await pool.execute('INSERT INTO users (username, password) VALUES (?, ?)', ['admin', hash]);
            console.log('\n=== ADMIN CRIADO ===');
            console.log(`Usuario: admin | Senha: ${randomPassword}`);
            console.log('===================\n');
        }

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                instance_id VARCHAR(255),
                to_number VARCHAR(50),
                message TEXT,
                type VARCHAR(50),
                status VARCHAR(50),
                sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `).catch(() => { });

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS webhook_logs (
                id INT AUTO_INCREMENT PRIMARY KEY,
                instance_id VARCHAR(255),
                url VARCHAR(500),
                payload LONGTEXT,
                response LONGTEXT,
                status_code INT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `).catch(() => { });

        // RemoteAuth store
        if (USE_REMOTE_AUTH) {
            try {
                mysqlStore = new MysqlStore({
                    pool: pool,
                    tableInfo: { table: 'wwebjs_sessions', sessionColumn: 'session_name', dataColumn: 'data' }
                });
                await mysqlStore._ready;
                logger.info(null, 'MysqlStore inicializado');
            } catch (e) {
                logger.error(null, `Erro MysqlStore: ${e.message}`);
            }
        }

        // Reidratação de instâncias enabled=1
        const [rows] = await pool.execute('SELECT id, name FROM instances WHERE enabled = 1');
        logger.info(null, `Reidratação: ${rows.length} instâncias para auto-start`);

        for (const row of rows) {
            logger.session(row.id, `Restaurando "${row.name || row.id}"...`);
            await pool.execute('UPDATE instances SET connection_status = ? WHERE id = ?', [CONNECTION_STATUS.RECONNECTING, row.id]).catch(() => { });
            await new Promise(resolve => setTimeout(resolve, 2000));
            startSession(row.id);
        }

        // Inicializar handlers
        shutdownHandler.init(sessionManager, pool);
        connectionMonitor.init({
            sessionManager,
            pool,
            forceReconnectFn: forceReconnect,
            startSessionFn: startSession
        });

    } catch (err) {
        logger.error(null, `Database initialization error: ${err.message}`);
    }
}

// Groups table init
async function initGroupsTable() {
    if (!pool) return;
    try {
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS whatsapp_groups (
                id INT AUTO_INCREMENT PRIMARY KEY,
                instance_id VARCHAR(255) NOT NULL,
                group_id VARCHAR(255) NOT NULL,
                name VARCHAR(255) NOT NULL,
                description TEXT,
                created_by VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                UNIQUE KEY unique_group (instance_id, group_id)
            )
        `);
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS whatsapp_group_members (
                id INT AUTO_INCREMENT PRIMARY KEY,
                group_id INT NOT NULL,
                phone_number VARCHAR(50) NOT NULL,
                name VARCHAR(255),
                is_admin BOOLEAN DEFAULT FALSE,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (group_id) REFERENCES whatsapp_groups(id) ON DELETE CASCADE,
                UNIQUE KEY unique_member (group_id, phone_number)
            )
        `);
    } catch (e) { }
}

// ========================================
// ROUTES
// ========================================

// Todas as rotas de interface redirecionam para o Dashboard único
app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/admin', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', requireAuth, (req, res) => res.sendFile(__dirname + '/public/dashboard.html'));
app.get('/dashboard.html', requireAuth, (req, res) => res.redirect('/dashboard'));
app.get('/grupos', requireAuth, (req, res) => res.sendFile(__dirname + '/public/grupos.html'));
app.get('/grupos.html', requireAuth, (req, res) => res.redirect('/grupos'));

// Login
app.get('/login', (req, res) => {
    res.send(`<html><head><title>Login</title><style>body{font-family:'Segoe UI',sans-serif;background:#4c3b94;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.login-box{background:white;padding:40px;border-radius:10px;box-shadow:0 10px 25px rgba(0,0,0,.2);width:300px;text-align:center}input{width:100%;padding:12px;margin:10px 0;border:1px solid #ddd;border-radius:5px;box-sizing:border-box}button{width:100%;padding:12px;background:#6f42c1;color:white;border:none;border-radius:5px;cursor:pointer;font-weight:bold}button:hover{background:#5a32a3}</style></head><body><div class="login-box"><h2>Acesso Restrito</h2><form action="/login" method="POST"><input type="text" name="username" placeholder="Usuario" required><input type="password" name="password" placeholder="Senha" required><button type="submit">Entrar</button></form></div></body></html>`);
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    if (!pool) return res.send('Erro de conexão com banco');
    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);
        if (users.length > 0 && await bcrypt.compare(password, users[0].password)) {
            req.session.user = { id: users[0].id, username: users[0].username };
            return res.redirect('/dashboard');
        }
        res.send('<script>alert("Usuario ou senha invalidos"); window.location.href="/login";</script>');
    } catch (err) {
        res.send('Erro ao logar: ' + err.message);
    }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

// Admin legacy → redirect para dashboard
// (rota já definida acima como redirect)

// ========================================
// API ENDPOINTS
// ========================================

// Instance CRUD
app.post('/api/instance/create', async (req, res) => {
    const { name, sistema_php_url, webhook } = req.body;
    if (!name || !sistema_php_url) return res.status(400).json({ error: 'Nome e URL obrigatorios' });
    if (!pool) return res.status(500).json({ error: 'DB nao conectado' });

    try {
        const [existing] = await pool.execute('SELECT id FROM instances WHERE name = ? AND sistema_php_url = ?', [name, sistema_php_url]);
        if (existing.length > 0) return res.status(400).json({ error: 'Instancia ja existe' });

        const id = crypto.randomUUID();
        const token = crypto.randomBytes(32).toString('hex');
        await pool.execute('INSERT INTO instances (id, name, sistema_php_url, webhook, api_token, status) VALUES (?, ?, ?, ?, ?, 0)', [id, name, sistema_php_url, webhook || null, token]);
        startSession(id);
        res.json({ success: true, message: 'Instancia criada!', id, name });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/instance/:id', async (req, res) => {
    const { id } = req.params;
    if (!pool) return res.status(500).json({ error: 'DB nao conectado' });

    try {
        const session = sessionManager.get(id);
        if (session && session.client) {
            try { await session.client.destroy(); } catch (e) { }
            sessionManager.delete(id);
        }

        const [result] = await pool.execute('DELETE FROM instances WHERE id = ?', [id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Nao encontrada' });

        // Cleanup session dirs
        for (const dir of [`session-${id}`, `RemoteAuth-${id}`]) {
            const p = path.join(__dirname, '.wwebjs_auth', dir);
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }
        if (mysqlStore) {
            try { await mysqlStore.delete({ session: `RemoteAuth-${id}` }); } catch (e) { }
        }

        res.json({ success: true, message: 'Deletada' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Session control
app.post('/api/session/start', async (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });
    try { await startSession(instanceId); res.json({ success: true, message: 'Starting' }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/session/stop', async (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });
    const result = await stopSession(instanceId);
    res.json({ success: result, message: result ? 'Stopped' : 'Not found' });
});

app.post('/api/session/reset', async (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });

    try {
        const session = sessionManager.get(instanceId);
        if (session && session.client) {
            try { await session.client.destroy(); } catch (e) { }
        }
        sessionManager.delete(instanceId);

        for (const dir of [`session-${instanceId}`, `RemoteAuth-${instanceId}`]) {
            const p = path.join(__dirname, '.wwebjs_auth', dir);
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }
        if (mysqlStore) {
            try { await mysqlStore.delete({ session: `RemoteAuth-${instanceId}` }); } catch (e) { }
        }
        await updateInstanceStatus(instanceId, 0);
        res.json({ success: true, message: 'Resetada. Inicie para novo QR.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/session/full-reset', async (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });

    try {
        const session = sessionManager.get(instanceId);
        if (session && session.client) {
            try { await session.client.destroy(); } catch (e) { }
        }
        sessionManager.delete(instanceId);

        for (const dir of [`session-${instanceId}`, `RemoteAuth-${instanceId}`]) {
            const p = path.join(__dirname, '.wwebjs_auth', dir);
            if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
        }
        if (mysqlStore) {
            try { await mysqlStore.delete({ session: `RemoteAuth-${instanceId}` }); } catch (e) { }
        }

        const cachePath = path.join(__dirname, '.wwebjs_cache');
        if (fs.existsSync(cachePath)) fs.rmSync(cachePath, { recursive: true, force: true });

        await updateInstanceStatus(instanceId, 0);
        res.json({ success: true, message: 'Reset total completo.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/session/reconnect', async (req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });

    try {
        const session = sessionManager.get(instanceId);
        if (session && session.client) {
            try { await session.client.destroy(); } catch (e) { }
        }
        sessionManager.delete(instanceId);
        await new Promise(resolve => setTimeout(resolve, 2000));
        await startSession(instanceId);
        res.json({ success: true, message: 'Reconexao iniciada.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/session/status/:id', (req, res) => {
    const session = sessionManager.get(req.params.id);
    res.json({ status: session ? session.status : 'DISCONNECTED', hasQr: !!(session && session.qr) });
});

app.get('/api/session/qr/:id', async (req, res) => {
    const session = sessionManager.get(req.params.id);
    if (!session || !session.qr) return res.status(404).send('QR not available');
    try { res.type('png').send(await qrcode.toBuffer(session.qr)); }
    catch (err) { res.status(500).send('Error generating QR'); }
});

// Instance list & details
app.get('/api/instances', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'DB not connected' });
    try {
        const [dbInstances] = await pool.execute('SELECT id, name, sistema_php_url, webhook, api_token, phone_number, status as db_status, created_at, last_connection FROM instances ORDER BY created_at DESC');
        const instanceList = dbInstances.map(inst => {
            const session = sessionManager.get(inst.id);
            return {
                id: inst.id, name: inst.name || 'Sem nome',
                sistema_php_url: inst.sistema_php_url, webhook: inst.webhook,
                token: inst.api_token, phone_number: inst.phone_number,
                status: session ? session.status : 'DISCONNECTED',
                hasActiveSession: !!session,
                created_at: inst.created_at, last_connection: inst.last_connection
            };
        });
        res.json({ success: true, count: instanceList.length, instances: instanceList });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/instance/:id/details', async (req, res) => {
    const { id } = req.params;
    try {
        let dbData = null;
        if (pool) {
            const [rows] = await pool.execute('SELECT * FROM instances WHERE id = ?', [id]);
            if (rows.length > 0) dbData = rows[0];
        }
        const session = sessionManager.get(id);
        res.json({ success: true, database: dbData, memory: session ? session.toJSON() : null });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/instance/:id/enable', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'DB nao conectado' });
    try {
        await pool.execute('UPDATE instances SET enabled = 1 WHERE id = ?', [req.params.id]);
        if (!sessionManager.has(req.params.id)) startSession(req.params.id);
        res.json({ success: true, message: 'Habilitada' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/instance/:id/disable', async (req, res) => {
    if (!pool) return res.status(500).json({ error: 'DB nao conectado' });
    try {
        await pool.execute('UPDATE instances SET enabled = 0 WHERE id = ?', [req.params.id]);
        res.json({ success: true, message: 'Desabilitada' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// RemoteAuth sessions
app.get('/api/sessions/remote', async (req, res) => {
    if (!mysqlStore) return res.json({ enabled: false, sessions: [] });
    try {
        const sessions = await mysqlStore.listSessions();
        res.json({ enabled: true, authStrategy: 'RemoteAuth', backupInterval: `${BACKUP_SYNC_INTERVAL / 1000}s`, sessions });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/sessions/remote/:sessionName', async (req, res) => {
    if (!mysqlStore) return res.status(400).json({ error: 'RemoteAuth disabled' });
    try {
        await mysqlStore.delete({ session: req.params.sessionName });
        res.json({ success: true, message: 'Deletada' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========================================
// MESSAGING API
// ========================================

app.post('/api/send-text', async (req, res) => {
    const { instance, to, message, token } = req.body;
    if (!instance || !to || !message) return res.status(400).json({ error: 'Missing parameters' });

    const session = sessionManager.get(instance);

    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        const queueResult = messageQueue.enqueue(instance, { type: 'text', to, content: message });
        if (!session || session.status !== CONNECTION_STATUS.RECONNECTING) {
            forceReconnect(instance, 'MESSAGE_QUEUED').catch(() => { });
        }
        return res.status(202).json({ queued: true, messageId: queueResult.messageId, position: queueResult.position });
    }

    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const sentMsg = await session.client.sendMessage(chatId, message);

        if (pool) {
            await pool.execute('INSERT INTO messages (instance_id, to_number, message, type, status, sent_at) VALUES (?, ?, ?, \'text\', \'sent\', NOW())',
                [instance, to.replace(/\D/g, ''), message]).catch(() => { });
        }

        res.json({ message: { hash: sentMsg.id._serialized, id: sentMsg.id._serialized, sent: true } });
    } catch (error) {
        if (error.message.includes('not connected') || error.message.includes('disconnected')) {
            const qr = messageQueue.enqueue(instance, { type: 'text', to, content: message });
            forceReconnect(instance, 'SEND_FAILED').catch(() => { });
            return res.status(202).json({ queued: true, messageId: qr.messageId });
        }
        res.status(500).json({ error: error.message });
    }
});

// Alias
app.post('/api/agendar-text', async (req, res) => {
    const { instance, to, message } = req.body;
    if (!instance || !to || !message) return res.status(400).json({ error: 'Missing parameters' });

    const session = sessionManager.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instance not connected' });
    }

    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const sentMsg = await session.client.sendMessage(chatId, message);
        res.json({ message: { hash: sentMsg.id._serialized, id: sentMsg.id._serialized, sent: true } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/send-media', upload.single('file'), async (req, res) => {
    const { instance, to, caption, mediaUrl, mediaBase64, filename, mimetype } = req.body;
    if (!instance || !to) return res.status(400).json({ error: 'instance e to obrigatorios' });

    const session = sessionManager.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Nao conectada' });
    }

    try {
        let media;
        if (req.file) media = MessageMedia.fromFilePath(req.file.path);
        else if (mediaUrl) media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
        else if (mediaBase64 && mimetype) media = new MessageMedia(mimetype, mediaBase64, filename || 'arquivo');
        else return res.status(400).json({ error: 'Nenhuma midia fornecida' });

        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const sentMsg = await session.client.sendMessage(chatId, media, { caption: caption || '' });

        if (req.file) fs.unlink(req.file.path, () => { });
        if (pool) {
            await pool.execute('INSERT INTO messages (instance_id, to_number, message, type, status, sent_at) VALUES (?, ?, ?, \'media\', \'sent\', NOW())',
                [instance, to.replace(/\D/g, ''), caption || '[MEDIA]']).catch(() => { });
        }

        res.json({ success: true, messageId: sentMsg.id._serialized });
    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => { });
        res.status(500).json({ error: error.message });
    }
});

// ========================================
// GROUP API
// ========================================

app.post('/api/group/create', async (req, res) => {
    const { instance, name, participants, description } = req.body;
    if (!instance || !name) return res.status(400).json({ error: 'instance e name obrigatorios' });

    const session = sessionManager.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) return res.status(503).json({ error: 'Nao conectada' });

    try {
        const list = (participants || []).map(p => { const ph = p.replace(/\D/g, ''); return ph.includes('@') ? ph : `${ph}@c.us`; });
        const result = await session.client.createGroup(name, list);
        res.json({ success: true, group: { id: result.gid?._serialized || result.gid, name: result.title || name } });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/group/list/:instance', async (req, res) => {
    const session = sessionManager.get(req.params.instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) return res.status(503).json({ error: 'Nao conectada' });

    try {
        const chats = await session.client.getChats();
        const groups = chats.filter(c => c.isGroup).map(g => ({
            id: g.id._serialized, name: g.name,
            participantsCount: g.participants ? g.participants.length : 0
        }));
        res.json({ success: true, count: groups.length, groups });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/group/info/:instance/:groupId', async (req, res) => {
    const session = sessionManager.get(req.params.instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) return res.status(503).json({ error: 'Nao conectada' });

    try {
        const chatId = req.params.groupId.includes('@') ? req.params.groupId : `${req.params.groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);
        if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Grupo nao encontrado' });

        res.json({
            success: true,
            group: {
                id: chat.id._serialized, name: chat.name, description: chat.description,
                participants: chat.participants ? chat.participants.map(p => ({ id: p.id._serialized, isAdmin: p.isAdmin })) : []
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/group/add-participants', async (req, res) => {
    const { instance, groupId, participants } = req.body;
    if (!instance || !groupId || !participants) return res.status(400).json({ error: 'Parametros obrigatorios' });

    const session = sessionManager.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) return res.status(503).json({ error: 'Nao conectada' });

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);
        if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Grupo nao encontrado' });

        const ids = participants.map(p => { const ph = String(p).replace(/\D/g, ''); return ph.includes('@') ? ph : `${ph}@c.us`; });
        const result = await chat.addParticipants(ids);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/group/remove-participants', async (req, res) => {
    const { instance, groupId, participants } = req.body;
    if (!instance || !groupId || !participants) return res.status(400).json({ error: 'Parametros obrigatorios' });

    const session = sessionManager.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) return res.status(503).json({ error: 'Nao conectada' });

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);
        if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Grupo nao encontrado' });

        const ids = participants.map(p => { const ph = p.replace(/\D/g, ''); return ph.includes('@') ? ph : `${ph}@c.us`; });
        const result = await chat.removeParticipants(ids);
        res.json({ success: true, result });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/group/send-message', async (req, res) => {
    const { instance, groupId, message } = req.body;
    if (!instance || !groupId || !message) return res.status(400).json({ error: 'Parametros obrigatorios' });

    const session = sessionManager.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) return res.status(503).json({ error: 'Nao conectada' });

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const sentMsg = await session.client.sendMessage(chatId, message);
        res.json({ success: true, messageId: sentMsg.id._serialized });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/group/send-media', upload.single('file'), async (req, res) => {
    const { instance, groupId, caption, mediaUrl, mediaBase64, filename, mimetype } = req.body;
    if (!instance || !groupId) return res.status(400).json({ error: 'instance e groupId obrigatorios' });

    const session = sessionManager.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) return res.status(503).json({ error: 'Nao conectada' });

    try {
        let media;
        if (req.file) media = MessageMedia.fromFilePath(req.file.path);
        else if (mediaUrl) media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
        else if (mediaBase64 && mimetype) media = new MessageMedia(mimetype, mediaBase64, filename || 'arquivo');
        else return res.status(400).json({ error: 'Nenhuma midia' });

        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const sentMsg = await session.client.sendMessage(chatId, media, { caption: caption || '' });
        if (req.file) fs.unlink(req.file.path, () => { });
        res.json({ success: true, messageId: sentMsg.id._serialized });
    } catch (error) {
        if (req.file) fs.unlink(req.file.path, () => { });
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/group/invite-link/:instance/:groupId', async (req, res) => {
    const session = sessionManager.get(req.params.instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) return res.status(503).json({ error: 'Nao conectada' });

    try {
        const chatId = req.params.groupId.includes('@') ? req.params.groupId : `${req.params.groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);
        if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Grupo nao encontrado' });
        const code = await chat.getInviteCode();
        res.json({ success: true, inviteCode: code, inviteLink: `https://chat.whatsapp.com/${code}` });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/group/update', async (req, res) => {
    const { instance, groupId, name, description } = req.body;
    if (!instance || !groupId) return res.status(400).json({ error: 'Parametros obrigatorios' });

    const session = sessionManager.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) return res.status(503).json({ error: 'Nao conectada' });

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);
        if (!chat || !chat.isGroup) return res.status(404).json({ error: 'Grupo nao encontrado' });

        if (name) await chat.setSubject(name);
        if (description !== undefined) await chat.setDescription(description);
        res.json({ success: true, message: 'Atualizado' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ========================================
// HEALTH & MONITORING API
// ========================================

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const parts = [];
    if (d > 0) parts.push(`${d}d`);
    if (h > 0) parts.push(`${h}h`);
    if (m > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}

app.get('/api/health', (req, res) => {
    const mem = process.memoryUsage();
    const report = connectionMonitor.getHealthReport();

    res.json({
        status: 'online',
        version: CODE_VERSION,
        uptime: formatUptime(process.uptime()),
        sessions: report.sessions,
        memory: report.memory,
        circuitBreakers: report.circuitBreakers,
        monitorActive: report.monitorActive
    });
});

app.post('/api/health/check', async (req, res) => {
    try {
        await connectionMonitor.runCycle();
        res.json({ success: true, message: 'Cycle executed' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/memory/report', (req, res) => {
    res.json({ success: true, report: connectionMonitor.getHealthReport() });
});

app.get('/api/logs', (req, res) => {
    let logs = [...logBuffer];
    if (req.query.level) logs = logs.filter(l => l.level === req.query.level.toUpperCase());
    if (req.query.search) { const s = req.query.search.toLowerCase(); logs = logs.filter(l => l.msg.toLowerCase().includes(s)); }
    const limit = parseInt(req.query.limit) || 100;
    res.json({ total: logBuffer.length, filtered: logs.slice(-limit).length, codeVersion: CODE_VERSION, uptime: Math.round(process.uptime()) + 's', logs: logs.slice(-limit) });
});

app.get('/api/debug', async (req, res) => {
    const diag = {
        codeVersion: CODE_VERSION,
        nodeVersion: process.version,
        uptime: formatUptime(process.uptime()),
        memory: connectionMonitor.getHealthReport().memory,
        config: { USE_REMOTE_AUTH, BACKUP_SYNC_INTERVAL, mysqlStoreReady: !!mysqlStore, dbConnected: !!pool },
        sessions: {},
        circuitBreakers: {}
    };

    for (const [id, session] of sessionManager.entries()) {
        diag.sessions[id] = session.toJSON();
    }
    for (const [id, cb] of connectionMonitor.circuitBreakers.entries()) {
        diag.circuitBreakers[id] = cb.toJSON();
    }

    res.json(diag);
});

app.get('/api/queue/status', (req, res) => res.json({ success: true, ...messageQueue.getStats() }));
app.get('/api/queue/:instanceId', (req, res) => {
    const q = messageQueue.getQueue(req.params.instanceId);
    res.json({ success: true, instanceId: req.params.instanceId, pending: q.length, messages: q });
});
app.delete('/api/queue/:instanceId', (req, res) => {
    messageQueue.clearQueue(req.params.instanceId);
    res.json({ success: true, message: 'Fila limpa' });
});

// ========================================
// STARTUP
// ========================================
const PORT = process.env.PORT || 3000;

(async () => {
    await initDB();
    await initGroupsTable();

    // Iniciar monitor unificado após 30s
    setTimeout(() => {
        const monitorInterval = connectionMonitor.start();
        shutdownHandler.registerInterval(monitorInterval);
    }, RESILIENCE_CONFIG.MONITOR_STARTUP_DELAY);

    app.listen(PORT, () => {
        logger.startup(`WhatsApp Server v${CODE_VERSION}`);
        console.log(`Server running on port ${PORT}`);

        logger.section('CONFIGURACAO');
        logger.config('Monitor Unificado', `${RESILIENCE_CONFIG.MONITOR_INTERVAL / 1000}s`);
        logger.config('Circuit Breaker', `max ${RESILIENCE_CONFIG.MAX_RECONNECT_ATTEMPTS} falhas, pausa ${RESILIENCE_CONFIG.CIRCUIT_OPEN_DURATION / 1000}s`);
        logger.config('Auth Strategy', USE_REMOTE_AUTH ? `RemoteAuth (backup ${BACKUP_SYNC_INTERVAL / 1000}s)` : 'LocalAuth');
        logger.config('Session Storage', RESILIENCE_CONFIG.SESSION_STORAGE_PATH);

        logger.section('MELHORIAS v4.0');
        console.log('   - Monitor unificado (substituiu 6 monitors sobrepostos)');
        console.log('   - Circuit breaker real (pausa apos N falhas)');
        console.log('   - Race condition corrigida no forceReconnect');
        console.log('   - Cleanup de Chrome orfaos e SingletonLock');
        console.log('   - Puppeteer args limpos (sem flags invalidas)');
        console.log('   - UserAgent nativo do Chrome (sem deteccao)');
        console.log('   - Listeners reativos do Puppeteer');
        console.log('   - Codigo legado de pacientes removido');
    });
})();
