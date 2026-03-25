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
// MÓDULOS DE RESILIÊNCIA
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
const { memoryMonitor } = require('./lib/memoryMonitor');
const { messageQueue } = require('./lib/messageQueue');

// ========================================
// VERSÃO DO CÓDIGO (para verificar deploy)
// ========================================
const CODE_VERSION = '3.7.0-stability';
const CODE_BUILD_DATE = '2026-02-10T22:15:00';

// ========================================
// BUFFER DE LOGS EM MEMÓRIA (acessível via /api/logs)
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

// Interceptar console.log/error/warn para capturar no buffer
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);

// Stringify seguro: evita explosão com objetos circulares
function safeStringify(obj) {
    try {
        const str = JSON.stringify(obj);
        return str && str.length > 2000 ? str.substring(0, 2000) + '...[truncated]' : str;
    } catch (e) {
        return '[Circular/Unstringifiable Object]';
    }
}

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
// TRATAMENTO DE ERROS GLOBAIS
// ========================================
process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught Exception:', err);
    // Não derrubar o processo, apenas logar
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
    // Não derrubar o processo, apenas logar
});

// ========================================
// CONFIGURAÇÃO MULTER PARA UPLOAD DE ARQUIVOS
// ========================================
const uploadDir = path.join(__dirname, 'tmp', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({
    storage: storage,
    limits: { fileSize: 16 * 1024 * 1024 }, // 16MB (limite WhatsApp)
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            // Imagens
            'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
            // Documentos
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'text/plain',
            // Áudio
            'audio/mpeg', 'audio/ogg', 'audio/wav',
            // Vídeo
            'video/mp4', 'video/mpeg'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Tipo de arquivo não suportado: ' + file.mimetype), false);
        }
    }
});

const app = express();

// Trust proxy - NECESSÁRIO quando atrás de reverse proxy (Plesk/Passenger/Nginx)
// Sem isso, express-rate-limit não funciona corretamente e gera erros X-Forwarded-For
app.set('trust proxy', 1);

// 1. Security Headers (Helmet)
// Desativando CSP por enquanto para permitir scripts/estilos inline existentes
app.use(helmet({
    contentSecurityPolicy: false,
}));

// 2. CORS (Permitir acesso de outros domínios se necessário, ajuste a origin conforme produção)
app.use(cors());

// 3. Rate Limiting (Proteção contra Bruteforce/DDoS)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    max: 100, // limite de 100 requisições por IP
    message: 'Muitas requisições deste IP, tente novamente mais tarde.'
});
app.use(limiter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Configuração de Sessão (Segurança)
app.use(session({
    secret: process.env.JWT_SECRET || 'segredo_padrao_super_seguro',
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 3600000, // 1 hora
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production'
    }
}));

// Proteger páginas/assets administrativos servidos de forma estática
const protectedStaticPaths = new Set([
    '/dashboard.html',
    '/dashboard.js',
    '/dashboard.css',
    '/grupos.html'
]);

app.use((req, res, next) => {
    if (!protectedStaticPaths.has(req.path)) {
        return next();
    }

    if (req.session && req.session.user) {
        return next();
    }

    if (req.path.endsWith('.html')) {
        return res.redirect('/login');
    }

    return res.status(401).send('Unauthorized');
});

app.use(express.static('public'));

// Rota raiz para verificar se a API está online
app.get('/', (req, res) => {
    res.send(`
        <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
            <h1>🤖 WhatsApp Bot API Online</h1>
            <p>Status: <strong>Operacional</strong></p>
            <p>Instâncias Ativas: ${sessions.size}</p>
            <br>
            <a href="/dashboard" style="background: #4c3b94; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Dashboard Principal</a>
            <a href="/admin" style="background: #25D366; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-left: 10px;">Gerenciar Instâncias</a>
            <a href="/grupos" style="background: #6f42c1; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; margin-left: 10px;">Gerenciar Grupos</a>
        </div>
    `);
});

// Dashboard Principal (Nova Interface UIkit)
app.get('/dashboard', requireAuth, (req, res) => {
    res.sendFile(__dirname + '/public/dashboard.html');
});

app.get('/dashboard.html', requireAuth, (req, res) => {
    res.redirect('/dashboard');
});

app.get('/grupos', requireAuth, (req, res) => {
    res.sendFile(__dirname + '/public/grupos.html');
});

app.get('/grupos.html', requireAuth, (req, res) => {
    res.redirect('/grupos');
});

// Criar Nova Instância (API)
app.post('/api/instance/create', async(req, res) => {
    const { name, sistema_php_url, webhook } = req.body;

    console.log('[CREATE INSTANCE] Dados recebidos:', { name, sistema_php_url, webhook });

    if (!name || !sistema_php_url) return res.status(400).json({ error: 'Nome e URL do Sistema são obrigatórios' });

    if (!pool) return res.status(500).json({ error: 'Banco de dados não conectado' });

    try {
        // Verificar se já existe instância com mesmo nome E mesma URL
        const [existing] = await pool.execute(
            'SELECT id FROM instances WHERE name = ? AND sistema_php_url = ?', [name, sistema_php_url]
        );

        if (existing.length > 0) {
            return res.status(400).json({ error: 'Já existe uma instância com este nome e URL do Sistema PHP.' });
        }

        const id = crypto.randomUUID();
        const token = crypto.randomBytes(32).toString('hex');

        console.log('[CREATE INSTANCE] Inserindo no banco:', { id, name, sistema_php_url });

        await pool.execute(
            'INSERT INTO instances (id, name, sistema_php_url, webhook, api_token, status) VALUES (?, ?, ?, ?, ?, 0)', [id, name, sistema_php_url, webhook || null, token]
        );

        // Verificar se foi salvo corretamente
        const [verify] = await pool.execute('SELECT id, name FROM instances WHERE id = ?', [id]);
        console.log('[CREATE INSTANCE] Verificação após INSERT:', verify[0]);

        // Auto-start
        startSession(id);

        res.json({ success: true, message: 'Instância criada com sucesso!', id, name });
    } catch (err) {
        console.error('[CREATE INSTANCE] ERRO:', err);
        res.status(500).json({ error: 'Erro ao criar instância: ' + err.message });
    }
});

// Deletar Instância (API)
app.delete('/api/instance/:id', async(req, res) => {
    const { id } = req.params;

    if (!pool) return res.status(500).json({ error: 'Banco de dados não conectado' });

    try {
        // Parar sessão se estiver ativa
        const session = sessions.get(id);
        if (session && session.client) {
            try {
                await session.client.destroy();
            } catch (e) {
                console.error(`Erro ao destruir cliente ${id}:`, e.message);
            }
            sessions.delete(id);
        }

        // Deletar do banco de dados
        const [result] = await pool.execute('DELETE FROM instances WHERE id = ?', [id]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Instância não encontrada' });
        }

        // Tentar deletar pasta de sessão (LocalAuth)
        const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${id}`);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[${id}] Pasta de sessão LocalAuth deletada`);
        }

        // Tentar deletar pasta de sessão (RemoteAuth)
        const remoteSessionPath = path.join(__dirname, '.wwebjs_auth', `RemoteAuth-${id}`);
        if (fs.existsSync(remoteSessionPath)) {
            fs.rmSync(remoteSessionPath, { recursive: true, force: true });
            console.log(`[${id}] Pasta de sessão RemoteAuth deletada`);
        }

        // Deletar sessão do banco de dados (RemoteAuth)
        if (mysqlStore) {
            try {
                await mysqlStore.delete({ session: `RemoteAuth-${id}` });
                console.log(`[${id}] Sessão RemoteAuth deletada do banco de dados`);
            } catch (storeErr) {
                console.log(`[${id}] Nenhuma sessão RemoteAuth no banco ou erro: ${storeErr.message}`);
            }
        }

        res.json({ success: true, message: 'Instância deletada com sucesso!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Erro ao deletar instância: ' + err.message });
    }
});

// --- ROTAS DE LOGIN ---

app.get('/login', (req, res) => {
    res.send(`
        <html>
        <head>
            <title>Login - WhatsApp Manager</title>
            <style>
                body { font-family: 'Segoe UI', sans-serif; background: #4c3b94; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
                .login-box { background: white; padding: 40px; border-radius: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.2); width: 300px; text-align: center; }
                input { width: 100%; padding: 12px; margin: 10px 0; border: 1px solid #ddd; border-radius: 5px; box-sizing: border-box; }
                button { width: 100%; padding: 12px; background: #6f42c1; color: white; border: none; border-radius: 5px; cursor: pointer; font-weight: bold; }
                button:hover { background: #5a32a3; }
                .error { color: red; font-size: 0.9em; display: none; }
            </style>
        </head>
        <body>
            <div class="login-box">
                <h2>🤖 Acesso Restrito</h2>
                <form action="/login" method="POST">
                    <input type="text" name="username" placeholder="Usuário" required>
                    <input type="password" name="password" placeholder="Senha" required>
                    <button type="submit">Entrar</button>
                </form>
            </div>
        </body>
        </html>
    `);
});

app.post('/login', async(req, res) => {
    const { username, password } = req.body;

    if (!pool) return res.send('Erro de conexão com banco');

    try {
        const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', [username]);

        if (users.length > 0) {
            const user = users[0];
            const validPassword = await bcrypt.compare(password, user.password);

            if (validPassword) {
                req.session.user = { id: user.id, username: user.username };
                return res.redirect('/admin');
            }
        }
        res.send('<script>alert("Usuário ou senha inválidos"); window.location.href="/login";</script>');
    } catch (err) {
        res.send('Erro ao logar: ' + err.message);
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// Dashboard Administrativo
app.get('/admin', requireAuth, async(req, res) => {
    if (!pool) return res.send('Erro: Banco de dados não conectado.');

    try {
        const [instances] = await pool.execute('SELECT * FROM instances ORDER BY created_at DESC');

        let html = `
            <html>
            <head>
                <title>Gerenciador de Instâncias WhatsApp</title>
                <meta charset="UTF-8">
                <style>
                    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background: #4c3b94; margin: 0; padding: 20px; color: #333; }
                    .container { max-width: 1000px; margin: 0 auto; }
                    h1 { color: white; text-align: center; margin-bottom: 30px; }
                    .card { background: white; padding: 25px; border-radius: 10px; box-shadow: 0 4px 15px rgba(0,0,0,0.2); margin-bottom: 20px; }
                    
                    /* Formulário */
                    .form-group { margin-bottom: 15px; }
                    .form-group label { display: block; margin-bottom: 5px; font-weight: bold; color: #555; }
                    .form-control { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 5px; font-size: 14px; box-sizing: border-box; }
                    .btn-create { background: #6f42c1; color: white; width: 100%; padding: 12px; font-size: 16px; font-weight: bold; border: none; border-radius: 5px; cursor: pointer; transition: background 0.3s; }
                    .btn-create:hover { background: #5a32a3; }

                    /* Lista */
                    .instance-item { border-bottom: 1px solid #eee; padding: 15px 0; display: flex; justify-content: space-between; align-items: center; }
                    .instance-info strong { font-size: 1.1em; color: #333; }
                    .instance-info small { color: #777; display: block; margin-top: 4px; }
                    .btn { padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer; text-decoration: none; color: white; margin-left: 5px; font-size: 13px; }
                    .btn-start { background: #25D366; }
                    .btn-stop { background: #dc3545; }
                    .btn-qr { background: #0dcaf0; color: #000; }
                    
                    .status-badge { padding: 5px 10px; border-radius: 15px; font-size: 0.8em; font-weight: bold; text-transform: uppercase; }
                    .status-connected { background: #d1e7dd; color: #0f5132; }
                    .status-disconnected { background: #f8d7da; color: #842029; }
                    .status-qr { background: #cff4fc; color: #055160; }

                    .modal-overlay { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); justify-content: center; align-items: center; }
                    .modal { background: white; padding: 20px; border-radius: 8px; width: 300px; text-align: center; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🤖 Dashboard WhatsApp</h1>
                    
                    <!-- Formulário de Criação -->
                    <div class="card">
                        <h2 style="margin-top: 0; color: #4c3b94;">+ Nova Instância WhatsApp</h2>
                        <form id="createForm">
                            <div class="form-group">
                                <label>Nome da Instância *</label>
                                <input type="text" name="name" class="form-control" placeholder="Ex: Atendimento Principal" required>
                            </div>
                            <div class="form-group">
                                <label>URL do Sistema PHP *</label>
                                <input type="url" name="sistema_php_url" class="form-control" placeholder="https://seu-sistema.com/api/retorno.php" value="${process.env.SISTEMA_PHP_URL || ''}" required>
                            </div>
                            <div class="form-group">
                                <label>Webhook (Opcional)</label>
                                <input type="url" name="webhook" class="form-control" placeholder="https://seu-sistema.com/webhook">
                            </div>
                            <button type="submit" class="btn-create">Criar e Conectar</button>
                        </form>
                    </div>

                    <!-- Lista de Instâncias -->
                    <div class="card">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                            <h2 style="margin: 0;">Minhas Instâncias</h2>
                            <button onclick="location.reload()" class="btn" style="background: #6c757d;">Atualizar</button>
                        </div>
        `;

        if (instances.length === 0) {
            html += '<p style="text-align: center; color: #777;">Nenhuma instância encontrada.</p>';
        } else {
            instances.forEach(inst => {
                const session = sessions.get(inst.id);
                const status = session ? session.status : 'DISCONNECTED';
                let statusClass = 'status-disconnected';
                if (status === 'CONNECTED') statusClass = 'status-connected';
                if (status === 'QR_CODE') statusClass = 'status-qr';
                if (status.startsWith('LOADING_')) statusClass = 'status-qr';
                if (status === 'INITIALIZING') statusClass = 'status-qr';

                let actions = '';
                // Botão de deletar sempre visível
                const deleteBtn = `<button onclick="deleteInstance('${inst.id}', '${inst.name}')" class="btn" style="background: #721c24; color: #fff; font-size: 11px;" title="Deletar instância">🗑️</button>`;

                if (status === 'DISCONNECTED' || status === 'AUTH_FAILURE' || status === 'INIT_ERROR') {
                    actions = `<button onclick="controlSession('${inst.id}', 'start')" class="btn btn-start">Iniciar</button>`;
                    actions += `<button onclick="resetSession('${inst.id}')" class="btn" style="background: #ffc107; color: #000;">Reset</button>`;
                    actions += `<button onclick="fullResetSession('${inst.id}')" class="btn" style="background: #dc3545; color: #fff; font-size: 11px;">Reset Total</button>`;
                } else if (status === 'INITIALIZING' || status.startsWith('LOADING_') || status === 'SYNC_TIMEOUT') {
                    actions = `<button onclick="controlSession('${inst.id}', 'stop')" class="btn btn-stop">Parar</button>`;
                    actions += `<button onclick="reconnectSession('${inst.id}')" class="btn" style="background: #17a2b8; color: #fff;">Reconectar</button>`;
                    actions += `<button onclick="resetSession('${inst.id}')" class="btn" style="background: #ffc107; color: #000;">Reset</button>`;
                } else if (status === 'CONNECTED') {
                    actions = `<button onclick="controlSession('${inst.id}', 'stop')" class="btn btn-stop">Parar</button>`;
                    actions += `<button onclick="reconnectSession('${inst.id}')" class="btn" style="background: #17a2b8; color: #fff;">Reconectar</button>`;
                } else {
                    actions = `<button onclick="controlSession('${inst.id}', 'stop')" class="btn btn-stop">Parar</button>`;
                    if (status === 'QR_CODE') {
                        actions += `<button onclick="showQr('${inst.id}')" class="btn btn-qr">Ver QR Code</button>`;
                    }
                    actions += `<button onclick="reconnectSession('${inst.id}')" class="btn" style="background: #17a2b8; color: #fff;">Reconectar</button>`;
                    actions += `<button onclick="resetSession('${inst.id}')" class="btn" style="background: #ffc107; color: #000;">Reset</button>`;
                }
                actions += deleteBtn;

                html += `
                    <div class="instance-item" data-id="${inst.id}">
                        <div class="instance-info">
                            <strong>${inst.name}</strong> <span class="status-badge ${statusClass}">${status}</span>
                            <small>ID: ${inst.id}</small>
                            <small>Tel: ${inst.phone_number || '---'}</small>
                            <small>PHP: ${inst.sistema_php_url}</small>
                        </div>
                        <div class="actions-div">${actions}</div>
                    </div>
                `;
            });
        }

        html += `
                    </div>
                </div>

                <div id="qrModal" class="modal-overlay">
                    <div class="modal">
                        <h3>Escaneie o QR Code</h3>
                        <div id="qrContent"></div>
                        <br>
                        <button onclick="closeQr()" class="btn" style="background: #ccc; color: #333;">Fechar</button>
                    </div>
                </div>

                <script>
                    // Criar Instância
                    document.getElementById('createForm').onsubmit = async (e) => {
                        e.preventDefault();
                        const formData = new FormData(e.target);
                        const data = Object.fromEntries(formData);
                        
                        const btn = e.target.querySelector('button');
                        const originalText = btn.innerText;
                        btn.innerText = 'Criando...';
                        btn.disabled = true;

                        try {
                            const res = await fetch('/api/instance/create', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(data)
                            });
                            const result = await res.json();
                            if (result.success) {
                                alert('Instância criada! Iniciando conexão...');
                                location.reload();
                            } else {
                                alert('Erro: ' + result.error);
                            }
                        } catch (err) {
                            alert('Erro de conexão');
                        } finally {
                            btn.innerText = originalText;
                            btn.disabled = false;
                        }
                    };

                    async function controlSession(id, action) {
                        const res = await fetch('/api/session/' + action, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ instanceId: id })
                        });
                        const data = await res.json();
                        // alert(data.message);
                        location.reload();
                    }

                    function showQr(id) {
                        document.getElementById('qrContent').innerHTML = '<img src="/api/session/qr/' + id + '" style="width:100%">';
                        document.getElementById('qrModal').style.display = 'flex';
                        // Refresh QR automatically every 10s? Maybe later.
                    }
                    
                    function closeQr() {
                        document.getElementById('qrModal').style.display = 'none';
                        location.reload();
                    }

                    async function resetSession(id) {
                        if (!confirm('Tem certeza que deseja resetar esta sessão? Isso irá apagar os dados de autenticação e você precisará escanear o QR Code novamente.')) {
                            return;
                        }
                        
                        try {
                            const res = await fetch('/api/session/reset', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ instanceId: id })
                            });
                            const data = await res.json();
                            alert(data.message || data.error);
                            location.reload();
                        } catch (err) {
                            alert('Erro ao resetar sessão: ' + err.message);
                        }
                    }

                    async function fullResetSession(id) {
                        if (!confirm('ATENÇÃO: Reset completo irá apagar a sessão E o cache do WhatsApp Web. Use apenas se o reset normal não funcionar. Continuar?')) {
                            return;
                        }
                        
                        try {
                            const res = await fetch('/api/session/full-reset', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ instanceId: id })
                            });
                            const data = await res.json();
                            alert(data.message || data.error);
                            location.reload();
                        } catch (err) {
                            alert('Erro ao resetar sessão: ' + err.message);
                        }
                    }

                    async function reconnectSession(id) {
                        if (!confirm('Deseja forçar reconexão desta instância?')) {
                            return;
                        }
                        
                        try {
                            const res = await fetch('/api/session/reconnect', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ instanceId: id })
                            });
                            const data = await res.json();
                            alert(data.message || data.error);
                            setTimeout(() => location.reload(), 3000);
                        } catch (err) {
                            alert('Erro ao reconectar: ' + err.message);
                        }
                    }

                    async function deleteInstance(id, name) {
                        if (!confirm('⚠️ ATENÇÃO: Você está prestes a DELETAR permanentemente a instância "' + name + '".\\n\\nIsso irá:\\n- Parar a sessão\\n- Apagar todos os dados de autenticação\\n- Remover do banco de dados\\n\\nEsta ação NÃO pode ser desfeita!\\n\\nDeseja continuar?')) {
                            return;
                        }
                        
                        try {
                            const res = await fetch('/api/instance/' + id, {
                                method: 'DELETE'
                            });
                            const data = await res.json();
                            if (data.success) {
                                alert('✅ Instância deletada com sucesso!');
                                location.reload();
                            } else {
                                alert('Erro: ' + data.error);
                            }
                        } catch (err) {
                            alert('Erro ao deletar instância: ' + err.message);
                        }
                    }
                </script>
            </body>
            </html>
        `;

        res.send(html);
    } catch (err) {
        res.send('Erro ao buscar instâncias: ' + err.message);
    }
});

// Database Connection
// Suporta DB_PASSWORD ou DB_PASS (usado no .env.dev)
const DB_PASSWORD_ENV = process.env.DB_PASSWORD || process.env.DB_PASS;
if (!DB_PASSWORD_ENV) {
    console.error('⚠️ AVISO: DB_PASSWORD não definida nas variáveis de ambiente. Configure o .env para produção.');
}
const dbConfig = {
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'usr_wbot1',
    password: DB_PASSWORD_ENV || '',
    database: process.env.DB_NAME || 'tabel_wbot1',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    // Fix para MySQL 8.4+ que não tem mysql_native_password por padrão
    authPlugins: undefined,
    connectAttributes: undefined
};

console.log('--- DEBUG DB CONFIG ---');
console.log('Host:', dbConfig.host);
console.log('User:', dbConfig.user);
console.log('Database:', dbConfig.database);
// Log mascarado da senha para segurança
console.log('Password Length:', dbConfig.password ? dbConfig.password.length : 0);
console.log('-----------------------');

let pool;
let mysqlStore = null;

// ========================================
// CONFIGURAÇÃO DE AUTENTICAÇÃO
// ========================================
// USE_REMOTE_AUTH: true = salva sessão no MySQL (mais confiável)
//                  false = salva sessão em arquivos locais (padrão antigo)
const USE_REMOTE_AUTH = process.env.USE_REMOTE_AUTH ?
    process.env.USE_REMOTE_AUTH === 'true' :
    true; // Default true, mas pode desligar com USE_REMOTE_AUTH=false
const BACKUP_SYNC_INTERVAL = parseInt(process.env.BACKUP_SYNC_INTERVAL) || 120000; // 2 minutos

// Store active sessions - Usando sessionManager para gerenciamento resiliente
// Mantendo 'sessions' como alias para compatibilidade
const sessions = sessionManager.sessions;
const remoteSessionBackupTimers = new Map();
const DELETE_SESSION_ON_AUTH_FAILURE = process.env.DELETE_SESSION_ON_AUTH_FAILURE === 'true';

// Middleware de Autenticação
function requireAuth(req, res, next) {
    if (req.session && req.session.user) {
        return next();
    }
    res.redirect('/login');
}

async function initDB() {
    try {
        pool = mysql.createPool(dbConfig);
        logger.info(null, 'Database pool created');

        // Nota: mysql2/promise pools gerenciam reconexão automaticamente
        // Erros de conexão são tratados nas operações individuais com try/catch

        // 0. Criar tabela de instâncias se não existir (com novas colunas de resiliência)
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

        // Adicionar novas colunas se não existirem (migração)
        const columnsToAdd = [
            { name: 'enabled', definition: 'TINYINT(1) DEFAULT 1' },
            { name: 'connection_status', definition: "VARCHAR(50) DEFAULT 'DISCONNECTED'" },
            { name: 'last_disconnect_reason', definition: 'VARCHAR(255) NULL' },
            { name: 'reconnect_attempts', definition: 'INT DEFAULT 0' }
        ];

        for (const col of columnsToAdd) {
            try {
                await pool.execute(`ALTER TABLE instances ADD COLUMN ${col.name} ${col.definition}`);
                logger.info(null, `Coluna "${col.name}" adicionada à tabela instances`);
            } catch (e) {
                // Coluna já existe, ignorar
            }
        }

        // Migrar dados antigos: se status=1 e enabled não definido, setar enabled=1
        await pool.execute(`UPDATE instances SET enabled = 1 WHERE status = 1 AND enabled IS NULL`).catch(() => {});

        // Garantir que a coluna name existe (para tabelas antigas)
        try {
            await pool.execute(`ALTER TABLE instances ADD COLUMN name VARCHAR(255) AFTER id`);
            console.log('Column "name" added to instances table');
        } catch (e) {
            // Coluna já existe, ignorar erro
            console.log('Column "name" already exists or error:', e.code || e.message);
        }

        // Verificar estrutura da tabela
        const [columns] = await pool.execute('SHOW COLUMNS FROM instances');
        console.log('[DB] Colunas da tabela instances:', columns.map(c => c.Field).join(', '));

        // 1. Criar tabela de usuários se não existir
        await pool.execute(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) NOT NULL UNIQUE,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // 2. Verificar se existe usuário admin
        const [users] = await pool.execute('SELECT * FROM users WHERE username = ?', ['admin']);
        if (users.length === 0) {
            // Gerar senha aleatória segura em vez de 'admin'
            const randomPassword = crypto.randomBytes(8).toString('hex');
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash(randomPassword, salt);

            await pool.execute('INSERT INTO users (username, password) VALUES (?, ?)', ['admin', hash]);

            console.log('\n=============================================================');
            console.log('⚠️  USUÁRIO ADMIN CRIADO COM SUCESSO');
            console.log(`👤 Usuário: admin`);
            console.log(`🔑 Senha Gerada: ${randomPassword}`);
            console.log('⚠️  GUARDE ESTA SENHA! ELA NÃO SERÁ EXIBIDA NOVAMENTE.');
            console.log('=============================================================\n');
        }

        // ═══════════════════════════════════════════════════════════════
        // INICIALIZAR MYSQL STORE PARA REMOTEAUTH
        // ═══════════════════════════════════════════════════════════════
        if (USE_REMOTE_AUTH) {
            try {
                mysqlStore = new MysqlStore({
                    pool: pool,
                    tableInfo: {
                        table: 'wwebjs_sessions',
                        sessionColumn: 'session_name',
                        dataColumn: 'data'
                    }
                });

                // Aguardar criação da tabela antes de usar
                await mysqlStore._ready;
                logger.info(null, '✅ MysqlStore inicializado - sessões serão salvas no banco de dados');

                // Listar sessões existentes no banco
                const existingSessions = await mysqlStore.listSessions();
                if (existingSessions.length > 0) {
                    logger.info(null, `📦 ${existingSessions.length} sessão(ões) encontrada(s) no banco de dados`);
                    existingSessions.forEach(s => {
                        logger.info(null, `   - ${s.session}: ${s.sizeMB} MB (atualizada: ${s.updatedAt})`);
                    });
                }
            } catch (storeErr) {
                logger.error(null, `❌ Erro ao inicializar MysqlStore: ${storeErr.message}`);
                logger.warn(null, '⚠️ Usando LocalAuth como fallback');
            }
        } else {
            logger.info(null, '📁 Usando LocalAuth - sessões serão salvas em arquivos locais');
        }

        // ═══════════════════════════════════════════════════════════════
        // REIDRATAÇÃO AUTOMÁTICA: Restaurar instâncias com enabled=1
        // Baseado em 'enabled' (intenção) e não 'connection_status' (estado momentâneo)
        // ═══════════════════════════════════════════════════════════════
        const [rows] = await pool.execute('SELECT id, name FROM instances WHERE enabled = 1');
        logger.info(null, `Reidratação: ${rows.length} instâncias marcadas para auto-start`);

        for (const row of rows) {
            logger.session(row.id, `Restaurando instância "${row.name || row.id}"...`);

            // Atualizar status para RECONNECTING antes de iniciar
            await pool.execute(
                'UPDATE instances SET connection_status = ? WHERE id = ?', [CONNECTION_STATUS.RECONNECTING, row.id]
            ).catch(() => {});

            // Delay entre inicializações para não sobrecarregar
            await new Promise(resolve => setTimeout(resolve, 2000));
            startSession(row.id);
        }

        // Inicializar handlers de shutdown e monitoramento
        shutdownHandler.init(sessionManager, pool);
        memoryMonitor.init(sessionManager, forceReconnect);

    } catch (err) {
        logger.error(null, 'Database initialization error', { error: err.message });
    }
}

/**
 * Atualiza o status da instância no banco de dados
 * @param {string} instanceId - ID da instância
 * @param {number} status - Status numérico (0=desconectado, 1=conectado) - compatibilidade
 * @param {string} phoneNumber - Número de telefone (opcional)
 * @param {string} connectionStatus - Status detalhado de conexão (opcional)
 * @param {string} disconnectReason - Razão da desconexão (opcional)
 */
/**
 * Força reconexão de uma instância com cleanup completo
 * @param {string} instanceId - ID da instância
 * @param {string} reason - Razão da reconexão
 */
const forceReconnectInProgress = new Set();

async function forceReconnect(instanceId, reason) {
    // GUARD: Impedir múltiplas reconexões simultâneas para a mesma instância
    if (forceReconnectInProgress.has(instanceId)) {
        logger.reconnect(instanceId, `forceReconnect já em andamento, ignorando (reason=${reason})`);
        return;
    }
    forceReconnectInProgress.add(instanceId);

    logger.reconnect(instanceId, `Forçando reconexão: ${reason}`);

    const session = sessionManager.get(instanceId);

    if (session) {
        session.prepareForReconnect();

        try {
            if (session.client) {
                session.client.removeAllListeners();
                await Promise.race([
                    session.client.destroy(),
                    new Promise(resolve => setTimeout(resolve, RESILIENCE_CONFIG.DESTROY_TIMEOUT))
                ]);
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

    // Calcular delay com backoff
    const attempts = (session && session.reconnectAttempts) ? session.reconnectAttempts : 0;
    const isImmediate = isImmediateReconnect(reason);
    const delay = calculateReconnectDelay(attempts, isImmediate);

    logger.reconnect(instanceId, `Reconectando em ${Math.round(delay/1000)}s (tentativa ${attempts + 1})`);

    // Liberar guard imediatamente - o delay + startSessionLocks protegem contra concorrência
    forceReconnectInProgress.delete(instanceId);

    setTimeout(async() => {
        if (!sessionManager.has(instanceId)) {
            try {
                const newSession = await startSession(instanceId);
                if (newSession) {
                    newSession.incrementReconnectAttempts();

                    // Resetar contador após 30 min conectado
                    setTimeout(() => {
                        const s = sessionManager.get(instanceId);
                        if (s && s.status === CONNECTION_STATUS.CONNECTED) {
                            s.resetCounters();
                            logger.session(instanceId, 'Contador de reconexões resetado');
                        }
                    }, RESILIENCE_CONFIG.RECONNECT_RESET_AFTER);
                }
            } catch (err) {
                logger.error(instanceId, `Erro na reconexão: ${err.message}`);
            }
        }
    }, delay);
}

/**
 * Atualiza o status da instância no banco de dados
 * @param {string} instanceId - ID da instância
 * @param {number} status - Status numérico (0=desconectado, 1=conectado) - compatibilidade
 * @param {string} phoneNumber - Número de telefone (opcional)
 * @param {string} connectionStatus - Status detalhado de conexão (opcional)
 * @param {string} disconnectReason - Razão da desconexão (opcional)
 */
async function updateInstanceStatus(instanceId, status, phoneNumber = null, connectionStatus = null, disconnectReason = null) {
    if (!pool) return;
    try {
        let query = 'UPDATE instances SET status = ?, last_connection = NOW()';
        const params = [status];

        if (phoneNumber) {
            query += ', phone_number = ?';
            params.push(phoneNumber);
        }

        // Atualizar connection_status detalhado
        if (connectionStatus) {
            query += ', connection_status = ?';
            params.push(connectionStatus);
        } else {
            // Mapear status numérico para connection_status
            query += ', connection_status = ?';
            params.push(status === 1 ? CONNECTION_STATUS.CONNECTED : CONNECTION_STATUS.DISCONNECTED);
        }

        // Registrar razão de desconexão
        if (disconnectReason) {
            query += ', last_disconnect_reason = ?';
            params.push(disconnectReason);
        }

        query += ' WHERE id = ?';
        params.push(instanceId);

        await pool.execute(query, params);
        logger.session(instanceId, `Status atualizado: ${connectionStatus || (status === 1 ? 'CONNECTED' : 'DISCONNECTED')}`);
    } catch (error) {
        logger.error(instanceId, `Erro ao atualizar status: ${error.message}`);
    }
}

function scheduleRemoteSessionBackupCheck(instanceId, delayMs = 45000, trigger = 'unknown') {
    if (!USE_REMOTE_AUTH || !mysqlStore) return;

    const existingTimer = remoteSessionBackupTimers.get(instanceId);
    if (existingTimer) {
        clearTimeout(existingTimer);
    }

    const timer = setTimeout(async() => {
        remoteSessionBackupTimers.delete(instanceId);

        try {
            const session = sessionManager.get(instanceId);
            if (!session || !session.client || !session.client.authStrategy) return;

            const authStrategy = session.client.authStrategy;
            if (typeof authStrategy.storeRemoteSession !== 'function') return;

            const sessionName = `RemoteAuth-${instanceId}`;
            const exists = await mysqlStore.sessionExists({ session: sessionName });

            if (exists) {
                logger.session(instanceId, `Sessão RemoteAuth confirmada no MySQL (${trigger})`);
                return;
            }

            const allowedStatuses = [CONNECTION_STATUS.CONNECTED, 'AUTHENTICATED'];
            if (!allowedStatuses.includes(session.status)) {
                logger.warn(instanceId, `Backup forçado ignorado: status atual ${session.status} (${trigger})`);
                return;
            }

            logger.warn(instanceId, `Sessão RemoteAuth ainda não persistida após ${Math.round(delayMs / 1000)}s (${trigger}) - executando backup forçado`);
            await authStrategy.storeRemoteSession({ emit: true });

            const existsAfter = await mysqlStore.sessionExists({ session: sessionName });
            if (existsAfter) {
                logger.session(instanceId, `Backup RemoteAuth persistido com sucesso (${trigger})`);
            } else {
                logger.warn(instanceId, `Backup RemoteAuth forçado não apareceu no MySQL (${trigger})`);
            }
        } catch (err) {
            logger.error(instanceId, `Erro ao verificar backup RemoteAuth (${trigger}): ${err.message}`);
        }
    }, delayMs);

    remoteSessionBackupTimers.set(instanceId, timer);
}

// Lock para evitar startSession() concorrente na mesma instância
// Sem isso, recovery check + forceReconnect podem criar 2 browsers → CONFLICT → QR_CODE
const startSessionLocks = new Set();

// Lock distribuído via MySQL - impede 2 processos (PM2 cluster, restart overlap)
// de iniciarem a mesma instância simultaneamente
// IMPORTANTE: GET_LOCK/RELEASE_LOCK são per-connection no MySQL.
// Precisamos usar a MESMA conexão para acquire e release.
const mysqlLockConnections = new Map(); // instanceId -> connection

async function acquireMySQLLock(instanceId, timeoutSec = 5) {
    if (!pool) return true; // Sem banco, usar apenas lock local
    try {
        // Obter uma conexão dedicada do pool para manter o lock
        const connection = await pool.getConnection();
        const [rows] = await connection.execute(
            'SELECT GET_LOCK(CONCAT(\'wa:\', ?), ?) AS acquired', [instanceId, timeoutSec]
        );
        if (rows[0].acquired === 1) {
            mysqlLockConnections.set(instanceId, connection);
            return true;
        }
        // Não conseguiu o lock - liberar conexão de volta ao pool
        connection.release();
        logger.warn(instanceId, `MySQL lock não adquirido após ${timeoutSec}s - outro processo pode estar iniciando`);
        // FALLBACK: O lock local (startSessionLocks) já protege contra concorrência
        // no mesmo processo. Prosseguir mesmo sem o lock MySQL para não travar reconexão.
        return true;
    } catch (e) {
        logger.error(instanceId, `Erro ao adquirir lock MySQL: ${e.message}`);
        return true; // Falha no lock não deve impedir start (fallback)
    }
}

async function releaseMySQLLock(instanceId) {
    if (!pool) return;
    const connection = mysqlLockConnections.get(instanceId);
    if (!connection) return;
    try {
        await connection.execute(
            'SELECT RELEASE_LOCK(CONCAT(\'wa:\', ?)) AS released', [instanceId]
        );
    } catch (e) {
        logger.error(instanceId, `Erro ao liberar lock MySQL: ${e.message}`);
    } finally {
        try { connection.release(); } catch (_) {}
        mysqlLockConnections.delete(instanceId);
    }
}

async function startSession(instanceId) {
    // LOCK LOCAL: Impedir chamadas concorrentes no mesmo processo
    if (startSessionLocks.has(instanceId)) {
        logger.session(instanceId, 'startSession já em andamento (lock ativo), ignorando chamada duplicada');
        return sessionManager.get(instanceId) || null;
    }
    startSessionLocks.add(instanceId);

    // LOCK DISTRIBUÍDO: Impedir chamadas concorrentes entre processos (PM2, restart)
    const gotLock = await acquireMySQLLock(instanceId);
    if (!gotLock) {
        logger.warn(instanceId, 'Outro processo já está iniciando esta instância (MySQL lock). Ignorando.');
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
    // Verificar se já existe sessão ativa
    if (sessionManager.has(instanceId)) {
        const existingSession = sessionManager.get(instanceId);
        if (existingSession.client && existingSession.status !== CONNECTION_STATUS.DISCONNECTED) {
            logger.session(instanceId, 'Sessão já ativa, ignorando');
            return existingSession;
        }
    }

    logger.session(instanceId, 'Iniciando sessão...');

    // Atualizar status no banco
    await updateInstanceStatus(instanceId, 0, null, CONNECTION_STATUS.INITIALIZING);

    // ═══════════════════════════════════════════════════════════════
    // SELEÇÃO DE ESTRATÉGIA DE AUTENTICAÇÃO
    // RemoteAuth (MySQL) = mais confiável, sobrevive a reinicializações
    // LocalAuth (Arquivos) = fallback se MySQL não estiver disponível
    // ═══════════════════════════════════════════════════════════════
    let authStrategy;
    const dataPath = RESILIENCE_CONFIG.SESSION_STORAGE_PATH || path.join(__dirname, '.wwebjs_auth');

    if (USE_REMOTE_AUTH && mysqlStore) {
        // Tentar migrar sessão LocalAuth existente para MySQL (uma única vez)
        try {
            const migrated = await mysqlStore.migrateFromLocalAuth(instanceId, dataPath);
            if (migrated) {
                logger.session(instanceId, '🔄 Sessão LocalAuth migrada para MySQL com sucesso!');
            }
        } catch (migErr) {
            logger.error(instanceId, `Erro na migração LocalAuth→RemoteAuth: ${migErr.message}`);
        }

        // Usar RemoteAuth com MySQL
        const sessionName = `RemoteAuth-${instanceId}`;
        const sessionExistsInDB = await mysqlStore.sessionExists({ session: sessionName });

        if (sessionExistsInDB) {
            logger.session(instanceId, '🔄 Sessão encontrada no banco de dados, restaurando...');
        } else {
            logger.session(instanceId, '📱 Nova sessão RemoteAuth - será necessário QR Code (apenas 1 vez)');
        }

        authStrategy = new RemoteAuth({
            clientId: instanceId,
            dataPath: dataPath,
            store: mysqlStore,
            backupSyncIntervalMs: BACKUP_SYNC_INTERVAL
        });
        logger.session(instanceId, `✅ Usando RemoteAuth (MySQL) - backup a cada ${BACKUP_SYNC_INTERVAL/1000}s`);
    } else {
        // Fallback para LocalAuth
        const sessionPath = path.join(dataPath, `session-${instanceId}`);
        const hasExistingSession = fs.existsSync(sessionPath);

        if (hasExistingSession) {
            logger.session(instanceId, '📁 Sessão local encontrada, restaurando...');
        } else {
            logger.session(instanceId, '📱 Nova sessão LocalAuth, será necessário QR Code');
        }

        authStrategy = new LocalAuth({
            clientId: instanceId,
            dataPath: dataPath
        });
        logger.session(instanceId, '📁 Usando LocalAuth (arquivos locais)');
    }

    const client = new Client({
        authStrategy: authStrategy,
        puppeteer: {
            ...PUPPETEER_CONFIG,
            // CONFIGURAÇÕES ULTRA-OTIMIZADAS PARA ESTABILIDADE
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
                // NOVAS FLAGS CRÍTICAS PARA ESTABILIDADE
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
                // MANTER CONEXÃO WEBSOCKET ATIVA
                '--disable-web-security',
                '--allow-running-insecure-content',
                // OTIMIZAÇÕES DE MEMÓRIA
                '--js-flags="--max-old-space-size=512"',
                '--memory-pressure-off',
                '--max_old_space_size=512'
            ],
            // Timeout maior para páginas lentas
            timeout: 60000,
            // Manter browser aberto em caso de erro
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false
        },
        // IMPORTANTE: Tomar controle quando houver conflito
        takeoverOnConflict: true,
        takeoverTimeoutMs: 10000, // 10 segundos para takeover
        // Timeout para autenticação (0 = infinito)
        authTimeoutMs: 0,
        // Máximo de tentativas de QR (0 = infinito)
        qrMaxRetries: 0,
        // User-Agent mais recente e estável
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        // Configurações adicionais para estabilidade
        restartOnAuthFail: true,
        // NOVAS CONFIGURAÇÕES PARA ESTABILIDADE
        bypassCSP: true
    });

    // Initialize session state usando SessionManager
    const session = sessionManager.getOrCreate(instanceId);
    session.client = client;
    session.qr = null;
    session.status = CONNECTION_STATUS.INITIALIZING;
    session.loadingStartTime = Date.now();
    session.lastActivity = Date.now();
    session.lastPing = Date.now();
    session.isReconnecting = false;

    // ========================================
    // SISTEMA DE KEEP-ALIVE ULTRA-ROBUSTO
    // ========================================
    const startKeepAlive = () => {
        const currentSession = sessionManager.get(instanceId);
        if (!currentSession) return;

        // Limpar todos os intervalos anteriores
        currentSession.clearIntervals();

        logger.session(instanceId, 'Iniciando sistema ULTRA-ROBUSTO de manutenção de conexão');

        // ========================================
        // 1. HEARTBEAT COM PROTEÇÃO DE CONTEXTO
        // ========================================
        currentSession.intervals.keepAlive = setInterval(async() => {
            const sess = sessionManager.get(instanceId);
            if (!sess || !sess.client || sess.status !== CONNECTION_STATUS.CONNECTED) return;
            if (sess.isReconnecting) return;

            try {
                // Verificar browser e página
                const browserOk = sess.client.pupBrowser && sess.client.pupBrowser.isConnected();
                const pageOk = sess.client.pupPage && !sess.client.pupPage.isClosed();

                if (!browserOk) {
                    console.log(`[${instanceId}] 🔴 HEARTBEAT: Browser morto!`);
                    await forceReconnect(instanceId, 'BROWSER_DEAD');
                    return;
                }

                if (!pageOk) {
                    console.log(`[${instanceId}] 🔴 HEARTBEAT: Página fechada!`);
                    await forceReconnect(instanceId, 'PAGE_CLOSED');
                    return;
                }

                // Ping com timeout e proteção contra erros de contexto
                const state = await Promise.race([
                    sess.client.getState(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), RESILIENCE_CONFIG.STATE_CHECK_TIMEOUT))
                ]);

                sess.lastActivity = Date.now();
                sess.lastPing = Date.now();
                sess.consecutiveFailures = 0;
                sess.lastSuccessfulPing = Date.now();
                sess.contextErrors = 0; // Reset erros de contexto

                if (state === 'CONFLICT') {
                    console.log(`[${instanceId}] ⚠️ HEARTBEAT: Conflito - executando takeover...`);
                    await executeTakeover(sess, instanceId);
                } else if (state !== 'CONNECTED') {
                    console.log(`[${instanceId}] ⚠️ HEARTBEAT: Estado anômalo = ${state}`);
                    sess.consecutiveFailures++;
                }
            } catch (err) {
                const sessNow = sessionManager.get(instanceId);
                if (!sessNow) return;

                // PROTEÇÃO: Detectar erros de contexto destruído
                const isContextError = err.message.includes('context') ||
                    err.message.includes('destroyed') ||
                    err.message.includes('navigation') ||
                    err.message.includes('Target closed');

                if (isContextError) {
                    sessNow.contextErrors = (sessNow.contextErrors || 0) + 1;
                    console.log(`[${instanceId}] ⚠️ HEARTBEAT: Erro de contexto (${sessNow.contextErrors}/${RESILIENCE_CONFIG.MAX_CONTEXT_ERRORS})`);

                    if (sessNow.contextErrors >= RESILIENCE_CONFIG.MAX_CONTEXT_ERRORS) {
                        console.log(`[${instanceId}] 🔴 Muitos erros de contexto - RECONECTANDO!`);
                        await forceReconnect(instanceId, 'CONTEXT_ERRORS');
                    }
                    return; // Não contar como falha consecutiva normal
                }

                console.error(`[${instanceId}] 🔴 HEARTBEAT Falhou:`, err.message);
                sessNow.consecutiveFailures = (sessNow.consecutiveFailures || 0) + 1;

                if (sessNow.consecutiveFailures >= RESILIENCE_CONFIG.MAX_CONSECUTIVE_FAILURES) {
                    console.log(`[${instanceId}] 🔴 ${sessNow.consecutiveFailures} falhas consecutivas - RECONECTANDO!`);
                    await forceReconnect(instanceId, 'CONSECUTIVE_HEARTBEAT_FAILURES');
                }
            }
        }, RESILIENCE_CONFIG.HEARTBEAT_INTERVAL);

        // ========================================
        // 2. VERIFICADOR DE WEBSOCKET - DESABILITADO
        // Redundante com heartbeat e causa instabilidade por excesso de pupPage.evaluate()
        // O heartbeat já verifica getState() que detecta problemas de conexão
        // ========================================

        // ========================================
        // 3. WATCHDOG DE INATIVIDADE (simplificado - sem pupPage.evaluate!)
        // Apenas verifica timestamps, o heartbeat já faz getState()
        // ========================================
        currentSession.intervals.watchdog = setInterval(async() => {
            const sess = sessionManager.get(instanceId);
            if (!sess || sess.status !== CONNECTION_STATUS.CONNECTED || sess.isReconnecting) return;

            const now = Date.now();
            const timeSinceLastPing = now - (sess.lastSuccessfulPing || now);

            // Só reconectar se sem ping por MUITO tempo (o heartbeat já tenta a cada 3min)
            if (timeSinceLastPing > RESILIENCE_CONFIG.PING_TIMEOUT_THRESHOLD) {
                console.log(`[${instanceId}] 🔴 WATCHDOG: Sem ping há ${Math.round(timeSinceLastPing/1000)}s - reconectando`);
                await forceReconnect(instanceId, 'WATCHDOG_NO_PING');
            }
        }, RESILIENCE_CONFIG.HEARTBEAT_INTERVAL * 2); // Roda a cada 2x o heartbeat

        console.log(`[${instanceId}] ✅ Sistema de manutenção de conexão ATIVO`);
    };

    // ========================================
    // FUNÇÕES AUXILIARES DE CONEXÃO
    // ========================================
    const executeTakeover = async(session, instId) => {
        try {
            if (session.client && session.client.pupPage) {
                await session.client.pupPage.evaluate(() => {
                    if (window.Store && window.Store.AppState) {
                        window.Store.AppState.takeover();
                    }
                });
                console.log(`[${instId}] ✅ Takeover executado com sucesso`);
            }
        } catch (e) {
            console.error(`[${instId}] ❌ Erro no takeover:`, e.message);
        }
    };

    // Evento de loading - importante para debug
    client.on('loading_screen', (percent, message) => {
        console.log(`[${instanceId}] Loading: ${percent}% - ${message}`);
        const session = sessionManager.get(instanceId);
        if (session) {
            session.status = `LOADING_${percent}%`;
            session.lastActivity = Date.now();

            // Se chegou a 100%, iniciar timeout de 60s para ready
            if (percent === 100) {
                session.loadingComplete = Date.now();
                console.log(`[${instanceId}] Loading complete, waiting for ready event...`);

                // Timeout de 60s após loading 100%
                setTimeout(async() => {
                    const currentSession = sessionManager.get(instanceId);
                    if (currentSession && currentSession.status.startsWith('LOADING_')) {
                        console.error(`[${instanceId}] TIMEOUT: Ready event not received after loading 100%`);
                        console.log(`[${instanceId}] Sessão pode estar corrompida. Tente usar o botão Reset.`);
                        currentSession.status = 'SYNC_TIMEOUT';
                    }
                }, 60000);
            }
        }
    });

    // Evento de mudança de estado - APRIMORADO
    client.on('change_state', async(state) => {
        console.log(`[${instanceId}] State changed to: ${state}`);
        const session = sessionManager.get(instanceId);
        if (session) {
            session.lastActivity = Date.now();
            session.lastState = state;

            if (state === 'CONNECTED') {
                // Às vezes o ready não dispara mas o state muda para CONNECTED
                const needsForceConnect = session.status.startsWith('LOADING_') ||
                    session.status === CONNECTION_STATUS.SYNC_TIMEOUT ||
                    session.status === 'AUTHENTICATED' ||
                    session.status === 'SYNC_FAILED';

                if (needsForceConnect) {
                    console.log(`[${instanceId}] State CONNECTED detected (was ${session.status}), forcing ready status`);
                    session.status = CONNECTION_STATUS.CONNECTED;
                    session.qr = null;
                    session.reconnectAttempts = 0; // Reset contador

                    // Tentar obter número do telefone
                    try {
                        const info = session.client.info;
                        if (info && info.wid) {
                            const phoneNumber = info.wid.user;
                            updateInstanceStatus(instanceId, 1, phoneNumber);
                        } else {
                            updateInstanceStatus(instanceId, 1);
                        }
                    } catch (e) {
                        updateInstanceStatus(instanceId, 1);
                    }

                    startKeepAlive();

                    // Trigger session save (ready event missed, so afterAuthReady wasn't called by Client.js)
                    if (session.client && session.client.authStrategy) {
                        console.log(`[${instanceId}] Triggering afterAuthReady from force-connect (change_state)`);
                        session.client.authStrategy.afterAuthReady().catch(err => {
                            console.error(`[${instanceId}] afterAuthReady error (force-connect):`, err.message);
                        });
                    }
                }
            } else if (state === 'CONFLICT') {
                console.log(`[${instanceId}] ⚠️ CONFLICT detectado - tentando takeover...`);
                // O takeover será tratado automaticamente pelo wwebjs se takeoverOnConflict estiver true
                // Mas vamos forçar manualmente também
                setTimeout(async() => {
                    try {
                        if (session.client && session.client.pupPage) {
                            await session.client.pupPage.evaluate(() => window.Store.AppState.takeover());
                            console.log(`[${instanceId}] Takeover executado`);
                        }
                    } catch (e) {
                        console.error(`[${instanceId}] Erro no takeover manual:`, e.message);
                    }
                }, 2000);
            } else if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
                console.log(`[${instanceId}] ⚠️ Sessão desemparelhada - necessário novo QR Code`);
                session.status = CONNECTION_STATUS.QR_CODE;
            } else if (state === 'OPENING') {
                console.log(`[${instanceId}] 🔄 Abrindo conexão...`);
            } else if (state === 'PAIRING') {
                console.log(`[${instanceId}] 📱 Aguardando pareamento...`);
            } else if (state === 'TIMEOUT') {
                console.log(`[${instanceId}] ⏰ Timeout de conexão detectado`);
            }
        }
    });

    // Contador de auth failures consecutivos por instância
    // Declarado antes dos handlers para ser acessível em ready e auth_failure
    let authFailureCount = 0;
    const AUTH_FAILURE_DELETE_THRESHOLD = 3;

    client.on('qr', (qr) => {
        console.log(`QR Code received for ${instanceId}`);
        const session = sessionManager.get(instanceId);
        if (session) {
            session.qr = qr;
            session.status = CONNECTION_STATUS.QR_CODE;
            session.lastActivity = Date.now();
        }
    });

    client.on('ready', async() => {
        logger.session(instanceId, 'Cliente READY - conectado!');
        authFailureCount = 0; // Reset auth failures on successful connection
        const session = sessionManager.get(instanceId);
        if (session) {
            session.setStatus(CONNECTION_STATUS.CONNECTED);
            session.qr = null;
            session.lastActivity = Date.now();
            session.reconnectAttempts = 0; // Reset contador de reconexões

            // Iniciar Keep-Alive
            startKeepAlive();
        }

        const info = client.info;
        const phoneNumber = info.wid.user;

        await updateInstanceStatus(instanceId, 1, phoneNumber, CONNECTION_STATUS.CONNECTED);

        // Verificação defensiva: se o save automático não acontecer, forçar um backup
        scheduleRemoteSessionBackupCheck(instanceId, 30000, 'ready');

        // ═══════════════════════════════════════════════════════════════════
        // PROCESSAR FILA DE MENSAGENS PENDENTES
        // ═══════════════════════════════════════════════════════════════════
        const queueSize = messageQueue.getQueueSize(instanceId);
        if (queueSize > 0) {
            logger.info(instanceId, `Processando ${queueSize} mensagens pendentes na fila...`);

            // Aguardar 2s para garantir que a conexão está estável
            setTimeout(async() => {
                try {
                    const result = await messageQueue.processQueue(instanceId, async(msg) => {
                        const chatId = msg.to.includes('@') ? msg.to : `${msg.to}@c.us`;

                        if (msg.type === 'text') {
                            await client.sendMessage(chatId, msg.content);
                        } else if (msg.type === 'media') {
                            const media = await MessageMedia.fromUrl(msg.mediaUrl);
                            await client.sendMessage(chatId, media, { caption: msg.caption });
                        }

                        // Salvar no banco
                        if (pool) {
                            const phoneNumber = msg.to.replace(/\D/g, '');
                            await pool.execute(
                                `INSERT INTO messages (instance_id, to_number, message, type, status, sent_at) 
                                 VALUES (?, ?, ?, ?, 'sent', NOW())`, [instanceId, phoneNumber, msg.content || msg.caption || '', msg.type]
                            ).catch(() => {});
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
        console.log(`Client ${instanceId} authenticated`);
        const session = sessionManager.get(instanceId);
        if (session) {
            session.status = 'AUTHENTICATED';
            session.authenticatedAt = Date.now();

            // Failsafe: algumas contas autenticam mas demoram para disparar ready.
            // Se o backup ainda não existir, tentamos persistir manualmente depois.
            scheduleRemoteSessionBackupCheck(instanceId, 45000, 'authenticated');

            // Verificação MUITO agressiva - primeira em 10s, depois a cada 15s
            const checkAuthenticatedState = async(attempt = 1) => {
                const currentSession = sessionManager.get(instanceId);
                if (!currentSession || currentSession.status !== 'AUTHENTICATED') {
                    return; // Já mudou de estado, parar verificação
                }

                console.log(`[${instanceId}] ⏳ Verificação ${attempt}/10 - Status ainda AUTHENTICATED...`);

                try {
                    if (currentSession.client && currentSession.client.pupPage && !currentSession.client.pupPage.isClosed()) {
                        // Primeiro, tentar forçar a sincronização manualmente
                        if (attempt === 2 || attempt === 5) {
                            console.log(`[${instanceId}] 🔄 Tentando forçar sincronização...`);
                            try {
                                await currentSession.client.pupPage.evaluate(() => {
                                    // Forçar verificação de hasSynced
                                    if (window.AuthStore && window.AuthStore.AppState) {
                                        const hasSynced = window.AuthStore.AppState.hasSynced;
                                        console.log('hasSynced:', hasSynced);
                                        if (hasSynced && window.onAppStateHasSyncedEvent) {
                                            window.onAppStateHasSyncedEvent();
                                        }
                                    }
                                });
                            } catch (forceErr) {
                                console.log(`[${instanceId}] Erro ao forçar sync:`, forceErr.message);
                            }
                        }

                        const state = await Promise.race([
                            currentSession.client.getState(),
                            new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
                        ]);

                        console.log(`[${instanceId}] Current state: ${state}`);

                        if (state === 'CONNECTED') {
                            console.log(`[${instanceId}] ✅ Forcing CONNECTED status (ready event missed)`);
                            currentSession.status = CONNECTION_STATUS.CONNECTED;
                            currentSession.qr = null;

                            // Tentar injetar Store se necessário
                            try {
                                const hasStore = await currentSession.client.pupPage.evaluate(() => {
                                    return typeof window.Store !== 'undefined';
                                });
                                if (!hasStore) {
                                    console.log(`[${instanceId}] 🔧 Store não encontrado, aguardando...`);
                                }
                            } catch (e) {}

                            try {
                                // Tentar obter info do cliente
                                const info = currentSession.client.info;
                                if (info && info.wid) {
                                    const phoneNumber = info.wid.user;
                                    await updateInstanceStatus(instanceId, 1, phoneNumber);
                                } else {
                                    await updateInstanceStatus(instanceId, 1);
                                }
                            } catch (infoErr) {
                                console.error(`[${instanceId}] Error getting client info:`, infoErr.message);
                                await updateInstanceStatus(instanceId, 1);
                            }

                            startKeepAlive();

                            // Trigger session save (ready event missed, so afterAuthReady wasn't called by Client.js)
                            if (currentSession.client && currentSession.client.authStrategy) {
                                console.log(`[${instanceId}] Triggering afterAuthReady from force-connect (watchdog)`);
                                currentSession.client.authStrategy.afterAuthReady().catch(err => {
                                    console.error(`[${instanceId}] afterAuthReady error (watchdog):`, err.message);
                                });
                            }
                            return;
                        } else if (state === 'OPENING' || state === 'PAIRING') {
                            console.log(`[${instanceId}] Still syncing (${state}), will check again...`);
                        } else {
                            console.log(`[${instanceId}] State: ${state}`);
                        }
                    }
                } catch (err) {
                    console.error(`[${instanceId}] Error checking state:`, err.message);
                }

                // Tentar novamente até 10 vezes (15s * 10 = 2.5 minutos máximo)
                if (attempt < 10) {
                    setTimeout(() => checkAuthenticatedState(attempt + 1), 15000);
                } else {
                    console.log(`[${instanceId}] ⚠️ Máximo de tentativas. Status: SYNC_TIMEOUT`);
                    const sess = sessionManager.get(instanceId);
                    if (sess && sess.status === 'AUTHENTICATED') {
                        sess.status = CONNECTION_STATUS.SYNC_TIMEOUT;
                    }
                }
            };

            // Primeira verificação após 10 segundos (mais rápido!)
            setTimeout(() => checkAuthenticatedState(1), 10000);
        }
    });

    client.on('auth_failure', async(msg) => {
        authFailureCount++;
        console.error(`[${instanceId}] ❌ Auth failure (${authFailureCount}/${AUTH_FAILURE_DELETE_THRESHOLD}):`, msg);
        const session = sessionManager.get(instanceId);
        if (session) {
            session.status = CONNECTION_STATUS.AUTH_FAILURE;
            session.authFailureReason = msg;
        }

        // Por padrão, NUNCA apagamos automaticamente a sessão persistida em auth_failure.
        // Em produção isso costuma ser pior que o problema original, porque força novo QR.
        if (authFailureCount >= AUTH_FAILURE_DELETE_THRESHOLD) {
            if (DELETE_SESSION_ON_AUTH_FAILURE) {
                console.log(`[${instanceId}] 🗑️ ${authFailureCount} auth failures consecutivos - deletando sessão persistida por configuração`);

                if (USE_REMOTE_AUTH && mysqlStore) {
                    const sessionName = `RemoteAuth-${instanceId}`;
                    try {
                        const exists = await mysqlStore.sessionExists({ session: sessionName });
                        if (exists) {
                            await mysqlStore.delete({ session: sessionName });
                            console.log(`[${instanceId}] 🗑️ Sessão RemoteAuth deletada do MySQL (auth_failure persistente)`);
                        }
                    } catch (delErr) {
                        console.error(`[${instanceId}] Erro ao deletar sessão após auth_failure:`, delErr.message);
                    }
                }

                const remoteSessionPath = path.join(__dirname, '.wwebjs_auth', `RemoteAuth-${instanceId}`);
                if (fs.existsSync(remoteSessionPath)) {
                    try {
                        fs.rmSync(remoteSessionPath, { recursive: true, force: true });
                        console.log(`[${instanceId}] 🗑️ Pasta RemoteAuth local removida após auth_failure persistente`);
                    } catch (e) {}
                }
            } else {
                console.log(`[${instanceId}] ⚠️ Auth failure persistente detectado - preservando sessão para retry automático (DELETE_SESSION_ON_AUTH_FAILURE=false)`);
                if (session) {
                    session.needsReconnect = true;
                }
            }

            authFailureCount = 0;
        } else {
            console.log(`[${instanceId}] ⏳ Auth failure temporário - mantendo sessão para retry (${authFailureCount}/${AUTH_FAILURE_DELETE_THRESHOLD})`);
        }
    });

    // Handler para quando a sessão remota é salva (importante para persistência)
    client.on('remote_session_saved', () => {
        console.log(`[${instanceId}] 💾 Sessão remota salva`);
        const session = sessionManager.get(instanceId);
        if (session) {
            session.lastSessionSave = Date.now();
        }
    });

    // Handler para chamadas recebidas (mantém a conexão ativa)
    client.on('call', async(call) => {
        console.log(`[${instanceId}] 📞 Chamada recebida de ${call.from}`);
        const session = sessionManager.get(instanceId);
        if (session) {
            session.lastActivity = Date.now();
        }
    });

    client.on('disconnected', async(reason) => {
        logger.error(instanceId, `DISCONNECTED - Reason: ${reason}`);
        await updateInstanceStatus(instanceId, 0, null, CONNECTION_STATUS.DISCONNECTED, reason);

        // Clean up session
        const session = sessionManager.get(instanceId);
        let reconnectAttempts = 0;

        if (session) {
            // IMPORTANTE: Limpar TODOS os intervalos usando o método do SessionState
            session.clearIntervals();

            reconnectAttempts = session.reconnectAttempts || 0;
            session.setStatus(CONNECTION_STATUS.DISCONNECTED);
            session.client = null;
            session.disconnectReason = reason;
            session.disconnectTime = Date.now();

            // NÃO chamar client.destroy() aqui - o Client.js da biblioteca já chama
            // this.destroy() automaticamente após emitir o evento DISCONNECTED.
            // Chamar destroy() duas vezes causa race conditions e pode interferir
            // com o salvamento da sessão RemoteAuth no disconnect().
        }
        sessionManager.delete(instanceId);

        // ═══════════════════════════════════════════════════════════════════
        // RECONEXÃO AUTOMÁTICA - ULTRA-AGRESSIVA para instâncias enabled=1
        // ═══════════════════════════════════════════════════════════════════

        // Verificar se deve reconectar baseado na razão
        if (!shouldReconnect(reason)) {
            logger.warn(instanceId, `Reconexão desabilitada para: ${reason}`);
            // Marcar como enabled=0 para não tentar reconectar
            if (pool) {
                await pool.execute('UPDATE instances SET enabled = 0 WHERE id = ?', [instanceId]).catch(() => {});
            }
            return;
        }

        // SEMPRE tentar reconectar, resetar contador se atingir máximo
        if (reconnectAttempts >= RESILIENCE_CONFIG.MAX_RECONNECT_ATTEMPTS) {
            logger.warn(instanceId, 'Máximo atingido, resetando contador e continuando...');
            reconnectAttempts = 0;
        }

        // Calcular delay com backoff
        const isImmediate = isImmediateReconnect(reason);
        const delay = calculateReconnectDelay(reconnectAttempts, isImmediate);

        logger.reconnect(instanceId, `Reconexão automática em ${Math.round(delay/1000)}s (tentativa ${reconnectAttempts + 1})`);

        const attemptReconnect = async(attempt) => {
            try {
                if (!pool) {
                    // Sem banco, tentar reconectar mesmo assim
                    if (!sessionManager.has(instanceId)) {
                        const newSession = await startSession(instanceId);
                        if (newSession) newSession.reconnectAttempts = attempt;
                    }
                    return;
                }

                // Verificar se a instância está enabled=1 (DEVE reconectar)
                const [rows] = await pool.execute(
                    'SELECT id, enabled FROM instances WHERE id = ?', [instanceId]
                );

                if (rows.length > 0 && rows[0].enabled === 1 && !sessionManager.has(instanceId)) {
                    logger.reconnect(instanceId, `Iniciando reconexão automática (enabled=1, tentativa ${attempt})...`);

                    // Atualizar status para RECONNECTING
                    await updateInstanceStatus(instanceId, 0, null, CONNECTION_STATUS.RECONNECTING);

                    const newSession = await startSession(instanceId);
                    if (newSession) {
                        newSession.reconnectAttempts = attempt;
                    } else {
                        // startSession retornou null - agendar retry
                        logger.warn(instanceId, `Reconexão retornou null na tentativa ${attempt}. Retry em 30s...`);
                        setTimeout(() => attemptReconnect(attempt + 1), 30000);
                    }
                }
            } catch (err) {
                logger.error(instanceId, `Erro na reconexão automática (tentativa ${attempt}): ${err.message}`);
                // Agendar retry após erro
                if (attempt < RESILIENCE_CONFIG.MAX_RECONNECT_ATTEMPTS) {
                    const retryDelay = calculateReconnectDelay(attempt, false);
                    logger.reconnect(instanceId, `Retry após erro em ${Math.round(retryDelay/1000)}s...`);
                    setTimeout(() => attemptReconnect(attempt + 1), retryDelay);
                }
            }
        };

        setTimeout(() => attemptReconnect(reconnectAttempts + 1), delay);
    });

    client.on('message', async msg => {
        // Atualizar última atividade
        const session = sessionManager.get(instanceId);
        if (session) {
            session.lastActivity = Date.now();
        }

        console.log(`[${instanceId}] Message from ${msg.from}: ${msg.body}`);
        handleIncomingMessage(instanceId, msg);
    });

    try {
        console.log(`[${instanceId}] Calling client.initialize()...`);

        // Timeout de 2 minutos para inicialização
        const initPromise = client.initialize();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Timeout: Inicialização demorou mais de 2 minutos')), 120000);
        });

        await Promise.race([initPromise, timeoutPromise]);
        console.log(`[${instanceId}] client.initialize() completed`);
    } catch (err) {
        console.error(`Failed to initialize client ${instanceId}:`, err);
        const session = sessionManager.get(instanceId);
        if (session) {
            session.status = CONNECTION_STATUS.INIT_ERROR;
        }
        // Tentar destruir o cliente se existir
        try {
            await client.destroy();
        } catch (destroyErr) {
            console.error(`Error destroying failed client ${instanceId}:`, destroyErr);
        }
        sessionManager.delete(instanceId);
    }

    return sessionManager.get(instanceId);
}

async function stopSession(instanceId) {
    const session = sessionManager.get(instanceId);
    if (!session || !session.client) {
        return false;
    }

    try {
        await session.client.destroy();
        sessionManager.delete(instanceId);
        await updateInstanceStatus(instanceId, 0);
        console.log(`Session ${instanceId} stopped`);
        return true;
    } catch (err) {
        console.error(`Error stopping session ${instanceId}:`, err);
        return false;
    }
}

async function handleIncomingMessage(instanceId, msg) {
    if (!pool) return;

    const phone = msg.from.replace('@c.us', '');
    const messageBody = msg.body.trim();

    console.log(`[Incoming] From: ${phone}, Message: "${messageBody}"`);

    try {
        // Verificar se é uma resposta de confirmação (1 ou 2)
        if (messageBody === '1' || messageBody === '2') {
            console.log(`[Incoming] Detected confirmation response: ${messageBody}`);

            // Buscar agendamento pendente para este telefone
            const [agendamentos] = await pool.execute(
                `SELECT id, error_message FROM agendamentos 
                 WHERE instance_id = ? AND to_number = ? AND status = 'pending' 
                 ORDER BY created_at DESC LIMIT 1`, [instanceId, phone]
            );

            if (agendamentos.length > 0) {
                const agendamento = agendamentos[0];
                let extraData = {};

                try {
                    extraData = JSON.parse(agendamento.error_message || '{}');
                } catch (e) {
                    console.error('[Incoming] Error parsing extra data:', e);
                }

                const session = sessions.get(instanceId);
                const chatId = msg.from;

                // Processar resposta
                if (messageBody === '1') {
                    // Confirmado
                    await pool.execute(
                        `UPDATE agendamentos SET status = 'sent' WHERE id = ?`, [agendamento.id]
                    );

                    // Salvar na tabela confirmacoes_processadas
                    await pool.execute(
                        `INSERT INTO confirmacoes_processadas (telefone, agendamento_id, resposta, instance_id) 
                         VALUES (?, ?, '1', ?)`, [phone, extraData.id_consulta || agendamento.id, instanceId]
                    );

                    // Enviar mensagem de confirmação
                    if (session && session.client && extraData.msg_confirma) {
                        await session.client.sendMessage(chatId, extraData.msg_confirma);
                        console.log(`[Incoming] Sent confirmation message to ${phone}`);
                    }

                    console.log(`[Incoming] Agendamento ${agendamento.id} CONFIRMADO`);

                } else if (messageBody === '2') {
                    // Cancelado/Reagendar
                    await pool.execute(
                        `UPDATE agendamentos SET status = 'cancelled' WHERE id = ?`, [agendamento.id]
                    );

                    // Salvar na tabela confirmacoes_processadas
                    await pool.execute(
                        `INSERT INTO confirmacoes_processadas (telefone, agendamento_id, resposta, instance_id) 
                         VALUES (?, ?, '2', ?)`, [phone, extraData.id_consulta || agendamento.id, instanceId]
                    );

                    // Enviar mensagem de reagendamento
                    if (session && session.client && extraData.msg_reagendar) {
                        await session.client.sendMessage(chatId, extraData.msg_reagendar);
                        console.log(`[Incoming] Sent cancellation message to ${phone}`);
                    }

                    console.log(`[Incoming] Agendamento ${agendamento.id} CANCELADO`);
                }

                // Enviar para o webhook do sistema PHP (retorno.php)
                if (extraData.url_recebe) {
                    const payload = {
                        telefone: phone,
                        status: messageBody,
                        id: extraData.id_consulta,
                        instance_id: instanceId
                    };

                    console.log(`[Incoming] Sending to webhook: ${extraData.url_recebe}`);

                    try {
                        const webhookResponse = await axios.post(extraData.url_recebe, payload);
                        console.log(`[Incoming] Webhook response:`, webhookResponse.data);

                        // Salvar log do webhook
                        await pool.execute(
                            `INSERT INTO webhook_logs (instance_id, url, payload, response, status_code) 
                             VALUES (?, ?, ?, ?, ?)`, [instanceId, extraData.url_recebe, JSON.stringify(payload), JSON.stringify(webhookResponse.data), webhookResponse.status]
                        );
                    } catch (webhookErr) {
                        console.error(`[Incoming] Webhook error:`, webhookErr.message);

                        // Salvar log do erro
                        await pool.execute(
                            `INSERT INTO webhook_logs (instance_id, url, payload, response, status_code) 
                             VALUES (?, ?, ?, ?, ?)`, [instanceId, extraData.url_recebe, JSON.stringify(payload), webhookErr.message, 0]
                        );
                    }
                }

                return; // Já processou a confirmação, não precisa continuar
            } else {
                console.log(`[Incoming] No pending agendamento found for ${phone}`);

                // Enviar mensagem de erro se configurada
                const session = sessions.get(instanceId);
                if (session && session.client) {
                    // Buscar último agendamento para pegar msg_erro
                    const [lastAgendamento] = await pool.execute(
                        `SELECT error_message FROM agendamentos 
                         WHERE instance_id = ? AND to_number = ? 
                         ORDER BY created_at DESC LIMIT 1`, [instanceId, phone]
                    );

                    if (lastAgendamento.length > 0) {
                        try {
                            const extraData = JSON.parse(lastAgendamento[0].error_message || '{}');
                            if (extraData.msg_erro) {
                                await session.client.sendMessage(msg.from, extraData.msg_erro);
                            }
                        } catch (e) {}
                    }
                }
            }
        }

        // Para outras mensagens (não são 1 ou 2), enviar para o webhook genérico
        const [rows] = await pool.execute(
            'SELECT webhook FROM instances WHERE id = ?', [instanceId]
        );

        if (rows.length > 0 && rows[0].webhook) {
            const webhookUrl = rows[0].webhook;

            const payload = {
                telefone: phone,
                status: messageBody,
                message: messageBody,
                instance_id: instanceId,
                message_id: msg.id._serialized
            };

            console.log(`[Incoming] Sending to generic webhook: ${webhookUrl}`);

            await axios.post(webhookUrl, payload)
                .then(res => console.log(`[Incoming] Webhook response:`, res.data))
                .catch(err => console.error(`[Incoming] Webhook error:`, err.message));
        }
    } catch (error) {
        console.error(`[Incoming] Error processing message:`, error);
    }
}

// --- API Endpoints ---

// Start a session
app.post('/api/session/start', async(req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });

    try {
        await startSession(instanceId);
        res.json({ success: true, message: 'Session starting' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Stop a session
app.post('/api/session/stop', async(req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });

    const result = await stopSession(instanceId);
    res.json({ success: result, message: result ? 'Session stopped' : 'Session not found or already stopped' });
});

// Reset/Limpar sessão corrompida
app.post('/api/session/reset', async(req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });

    console.log(`[RESET] Iniciando reset da sessão ${instanceId}`);

    try {
        // 1. Parar sessão se existir
        const session = sessions.get(instanceId);
        if (session && session.client) {
            try {
                await session.client.destroy();
            } catch (e) {
                console.log(`[RESET] Erro ao destruir cliente: ${e.message}`);
            }
        }
        sessions.delete(instanceId);

        // 2. Remover pasta de sessão (LocalAuth)
        const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${instanceId}`);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[RESET] Pasta de sessão LocalAuth removida: ${sessionPath}`);
        }

        // 2b. Remover pasta de sessão (RemoteAuth)
        const remoteSessionPath = path.join(__dirname, '.wwebjs_auth', `RemoteAuth-${instanceId}`);
        if (fs.existsSync(remoteSessionPath)) {
            fs.rmSync(remoteSessionPath, { recursive: true, force: true });
            console.log(`[RESET] Pasta de sessão RemoteAuth removida: ${remoteSessionPath}`);
        }

        // 2c. Deletar sessão RemoteAuth do MySQL
        if (mysqlStore) {
            try {
                await mysqlStore.delete({ session: `RemoteAuth-${instanceId}` });
                console.log(`[RESET] Sessão RemoteAuth deletada do MySQL`);
            } catch (storeErr) {
                console.log(`[RESET] Nenhuma sessão RemoteAuth no MySQL ou erro: ${storeErr.message}`);
            }
        }

        // 3. Atualizar status no banco
        await updateInstanceStatus(instanceId, 0);

        res.json({
            success: true,
            message: 'Sessão resetada com sucesso. Inicie novamente para gerar novo QR Code.'
        });
    } catch (err) {
        console.error(`[RESET] Erro ao resetar sessão ${instanceId}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Reset completo - limpa sessão E cache
app.post('/api/session/full-reset', async(req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });

    console.log(`[FULL-RESET] Iniciando reset completo da sessão ${instanceId}`);

    try {
        // 1. Parar sessão se existir
        const session = sessions.get(instanceId);
        if (session && session.client) {
            try {
                await session.client.destroy();
            } catch (e) {
                console.log(`[FULL-RESET] Erro ao destruir cliente: ${e.message}`);
            }
        }
        sessions.delete(instanceId);

        // 2. Remover pasta de sessão (LocalAuth)
        const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${instanceId}`);
        if (fs.existsSync(sessionPath)) {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[FULL-RESET] Pasta de sessão LocalAuth removida: ${sessionPath}`);
        }

        // 2b. Remover pasta de sessão (RemoteAuth)
        const remoteSessionPath = path.join(__dirname, '.wwebjs_auth', `RemoteAuth-${instanceId}`);
        if (fs.existsSync(remoteSessionPath)) {
            fs.rmSync(remoteSessionPath, { recursive: true, force: true });
            console.log(`[FULL-RESET] Pasta de sessão RemoteAuth removida: ${remoteSessionPath}`);
        }

        // 2c. Deletar sessão RemoteAuth do MySQL
        if (mysqlStore) {
            try {
                await mysqlStore.delete({ session: `RemoteAuth-${instanceId}` });
                console.log(`[FULL-RESET] Sessão RemoteAuth deletada do MySQL`);
            } catch (storeErr) {
                console.log(`[FULL-RESET] Nenhuma sessão RemoteAuth no MySQL ou erro: ${storeErr.message}`);
            }
        }

        // 3. Limpar cache do WhatsApp Web
        const cachePath = path.join(__dirname, '.wwebjs_cache');
        if (fs.existsSync(cachePath)) {
            fs.rmSync(cachePath, { recursive: true, force: true });
            console.log(`[FULL-RESET] Cache do WhatsApp Web removido: ${cachePath}`);
        }

        // 4. Atualizar status no banco
        await updateInstanceStatus(instanceId, 0);

        res.json({
            success: true,
            message: 'Reset completo realizado. Cache e sessão removidos. Inicie novamente.'
        });
    } catch (err) {
        console.error(`[FULL-RESET] Erro ao resetar sessão ${instanceId}:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Get Session Status
app.get('/api/session/status/:id', (req, res) => {
    const instanceId = req.params.id;
    const session = sessions.get(instanceId);

    if (!session) {
        return res.json({ status: 'DISCONNECTED' });
    }

    res.json({
        status: session.status,
        hasQr: !!session.qr
    });
});

// API para listar todas as instâncias do banco de dados com status em tempo real
app.get('/api/instances', async(req, res) => {
    if (!pool) {
        return res.status(500).json({ error: 'Database not connected' });
    }

    try {
        const [dbInstances] = await pool.execute(
            'SELECT id, name, sistema_php_url, webhook, api_token, phone_number, status as db_status, created_at, last_connection FROM instances ORDER BY created_at DESC'
        );

        console.log('[API /api/instances] Raw DB result:', JSON.stringify(dbInstances, null, 2));

        const instanceList = dbInstances.map(inst => {
            const session = sessions.get(inst.id);
            const mapped = {
                id: inst.id,
                name: inst.name || 'Sem nome',
                sistema_php_url: inst.sistema_php_url,
                webhook: inst.webhook,
                token: inst.api_token,
                phone_number: inst.phone_number,
                status: session ? session.status : 'DISCONNECTED',
                db_status: inst.db_status,
                hasActiveSession: !!session,
                created_at: inst.created_at,
                last_connection: inst.last_connection
            };
            console.log('[API /api/instances] Mapped instance:', inst.id, '-> name:', mapped.name, ', phone:', mapped.phone_number, ', url:', mapped.sistema_php_url);
            return mapped;
        });

        res.json({
            success: true,
            count: instanceList.length,
            instances: instanceList
        });
    } catch (err) {
        console.error('[API instances] Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════
// API PARA GERENCIAR SESSÕES REMOTEAUTH (MYSQL)
// ═══════════════════════════════════════════════════════════════
app.get('/api/sessions/remote', async(req, res) => {
    try {
        if (!mysqlStore) {
            return res.json({
                enabled: false,
                message: 'RemoteAuth não está habilitado. USE_REMOTE_AUTH=false ou MysqlStore não inicializado.',
                sessions: []
            });
        }

        const sessions = await mysqlStore.listSessions();
        res.json({
            enabled: true,
            authStrategy: 'RemoteAuth (MySQL)',
            backupInterval: `${BACKUP_SYNC_INTERVAL / 1000}s`,
            totalSessions: sessions.length,
            sessions: sessions
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Deletar uma sessão RemoteAuth específica do banco
app.delete('/api/sessions/remote/:sessionName', async(req, res) => {
    try {
        if (!mysqlStore) {
            return res.status(400).json({ error: 'RemoteAuth não está habilitado' });
        }

        const { sessionName } = req.params;
        await mysqlStore.delete({ session: sessionName });

        res.json({
            success: true,
            message: `Sessão "${sessionName}" deletada do banco de dados`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Limpar sessões antigas do banco
app.post('/api/sessions/remote/cleanup', async(req, res) => {
    try {
        if (!mysqlStore) {
            return res.status(400).json({ error: 'RemoteAuth não está habilitado' });
        }

        const { days = 30 } = req.body;
        const deleted = await mysqlStore.cleanOldSessions(days);

        res.json({
            success: true,
            message: `${deleted} sessão(ões) mais antiga(s) que ${days} dias foram removidas`
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// System Health Check - APRIMORADO
app.get('/api/health', (req, res) => {
    const memoryUsage = process.memoryUsage();
    const now = Date.now();

    const activeSessions = Array.from(sessions.entries()).map(([id, session]) => ({
        id,
        status: session.status,
        hasClient: !!session.client,
        hasBrowser: session.client && session.client.pupBrowser ? session.client.pupBrowser.isConnected() : false,
        hasPage: session.client && session.client.pupPage ? !session.client.pupPage.isClosed() : false,
        lastActivity: session.lastActivity ? Math.round((now - session.lastActivity) / 1000) + 's ago' : 'N/A',
        lastPing: session.lastPing ? Math.round((now - session.lastPing) / 1000) + 's ago' : 'N/A',
        consecutiveFailures: session.consecutiveFailures || 0,
        reconnectAttempts: session.reconnectAttempts || 0,
        keepAliveActive: !!session.keepAliveInterval,
        monitorActive: !!session.connectionMonitorInterval
    }));

    res.json({
        status: 'online',
        uptime: Math.round(process.uptime()) + 's',
        uptimeFormatted: formatUptime(process.uptime()),
        timestamp: new Date().toISOString(),
        sessions: {
            total: sessions.size,
            connected: activeSessions.filter(s => s.status === CONNECTION_STATUS.CONNECTED).length,
            initializing: activeSessions.filter(s => s.status === CONNECTION_STATUS.INITIALIZING || s.status.startsWith('LOADING_')).length,
            disconnected: activeSessions.filter(s => s.status === CONNECTION_STATUS.DISCONNECTED).length,
            qrCode: activeSessions.filter(s => s.status === CONNECTION_STATUS.QR_CODE).length,
            list: activeSessions
        },
        memory: {
            rss: Math.round(memoryUsage.rss / 1024 / 1024) + ' MB',
            heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + ' MB',
            heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + ' MB',
            external: Math.round(memoryUsage.external / 1024 / 1024) + ' MB'
        },
        healthCheck: {
            enabled: !!healthCheckInterval,
            interval: '45s',
            deepCheckInterval: '5min'
        }
    });
});

// Função auxiliar para formatar uptime
function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    parts.push(`${secs}s`);

    return parts.join(' ');
}

// Forçar reconexão de uma instância
app.post('/api/session/reconnect', async(req, res) => {
    const { instanceId } = req.body;
    if (!instanceId) return res.status(400).json({ error: 'Missing instanceId' });

    console.log(`[Reconnect] Forçando reconexão de ${instanceId}`);

    try {
        // Parar sessão atual se existir
        const session = sessions.get(instanceId);
        if (session && session.client) {
            try {
                await session.client.destroy();
            } catch (e) {
                console.log(`[Reconnect] Erro ao destruir cliente: ${e.message}`);
            }
        }
        sessions.delete(instanceId);

        // Aguardar um pouco antes de reconectar
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Iniciar nova sessão
        await startSession(instanceId);

        res.json({
            success: true,
            message: 'Reconexão iniciada. Aguarde alguns segundos.'
        });
    } catch (err) {
        console.error(`[Reconnect] Erro:`, err);
        res.status(500).json({ error: err.message });
    }
});

// Forçar health check manual
app.post('/api/health/check', async(req, res) => {
    logger.health(null, 'Verificação manual solicitada');

    try {
        await healthCheck();
        await checkMissingInstances();

        res.json({
            success: true,
            message: 'Health check executado',
            sessions: sessionManager.size
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================================
// API: Controle de enabled (auto-start)
// ========================================
app.post('/api/instance/:id/enable', async(req, res) => {
    const { id } = req.params;

    if (!pool) return res.status(500).json({ error: 'Banco de dados não conectado' });

    try {
        await pool.execute('UPDATE instances SET enabled = 1 WHERE id = ?', [id]);
        logger.session(id, 'Instância marcada como enabled=1 (auto-start)');

        // Iniciar sessão se não estiver ativa
        if (!sessionManager.has(id)) {
            startSession(id);
        }

        res.json({ success: true, message: 'Instância habilitada para auto-start' });
    } catch (err) {
        logger.error(id, `Erro ao habilitar: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/instance/:id/disable', async(req, res) => {
    const { id } = req.params;

    if (!pool) return res.status(500).json({ error: 'Banco de dados não conectado' });

    try {
        await pool.execute('UPDATE instances SET enabled = 0 WHERE id = ?', [id]);
        logger.session(id, 'Instância marcada como enabled=0 (sem auto-start)');

        res.json({ success: true, message: 'Instância desabilitada de auto-start (não será reconectada automaticamente)' });
    } catch (err) {
        logger.error(id, `Erro ao desabilitar: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// ========================================
// API: Relatório de Memória
// ========================================
app.get('/api/memory/report', async(req, res) => {
    try {
        const report = memoryMonitor.getReport();
        res.json({
            success: true,
            report
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================================
// API: DIAGNÓSTICO E LOGS (acessível pelo navegador)
// ========================================

// Ver últimos logs em memória
app.get('/api/logs', (req, res) => {
    const level = req.query.level; // filtrar por level: INFO, ERROR, WARN
    const search = req.query.search; // buscar texto
    const limit = parseInt(req.query.limit) || 100;

    let logs = [...logBuffer];

    if (level) {
        logs = logs.filter(l => l.level === level.toUpperCase());
    }
    if (search) {
        const s = search.toLowerCase();
        logs = logs.filter(l => l.msg.toLowerCase().includes(s));
    }

    // Retornar os mais recentes
    logs = logs.slice(-limit);

    res.json({
        total: logBuffer.length,
        filtered: logs.length,
        codeVersion: CODE_VERSION,
        buildDate: CODE_BUILD_DATE,
        uptime: Math.round(process.uptime()) + 's',
        logs
    });
});

// Diagnóstico completo do sistema
app.get('/api/debug', async(req, res) => {
    const diagnostics = {
        codeVersion: CODE_VERSION,
        buildDate: CODE_BUILD_DATE,
        nodeVersion: process.version,
        uptime: Math.round(process.uptime()) + 's',
        uptimeMinutes: Math.round(process.uptime() / 60),
        memory: {
            heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
            heapTotalMB: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
            rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024)
        },
        config: {
            USE_REMOTE_AUTH,
            BACKUP_SYNC_INTERVAL,
            mysqlStoreReady: !!mysqlStore,
            dbConnected: !!pool
        },
        sessions: {},
        database: {},
        remoteAuthSessions: [],
        recentErrors: []
    };

    // 1. Sessões em memória
    try {
        for (const [id, session] of sessionManager.entries()) {
            diagnostics.sessions[id] = {
                status: session.status,
                hasClient: !!session.client,
                hasBrowser: !!(session.client && session.client.pupBrowser && session.client.pupBrowser.isConnected()),
                hasPage: !!(session.client && session.client.pupPage && !session.client.pupPage.isClosed()),
                qr: session.qr ? 'present' : null,
                reconnectAttempts: session.reconnectAttempts || 0,
                consecutiveFailures: session.consecutiveFailures || 0,
                lastActivity: session.lastActivity ? new Date(session.lastActivity).toISOString() : null,
                lastPing: session.lastSuccessfulPing ? new Date(session.lastSuccessfulPing).toISOString() : null,
                lastSessionSave: session.lastSessionSave ? new Date(session.lastSessionSave).toISOString() : null,
                disconnectReason: session.disconnectReason || null,
                isReconnecting: session.isReconnecting || false
            };
        }
    } catch (e) {
        diagnostics.sessions._error = e.message;
    }

    // 2. Instâncias no banco de dados
    if (pool) {
        try {
            const [rows] = await pool.execute(
                'SELECT id, name, status, enabled, connection_status, phone_number, last_connection, last_disconnect_reason FROM instances'
            );
            diagnostics.database.instances = rows.map(r => ({
                id: r.id,
                name: r.name,
                status: r.status,
                enabled: r.enabled,
                connectionStatus: r.connection_status,
                phone: r.phone_number,
                lastConnection: r.last_connection,
                disconnectReason: r.last_disconnect_reason
            }));
        } catch (e) {
            diagnostics.database.instances_error = e.message;
        }

        // 3. Sessões RemoteAuth no MySQL
        try {
            const [sessions] = await pool.execute(
                `SELECT session_name, LENGTH(data) as data_size, created_at, updated_at FROM wwebjs_sessions`
            );
            diagnostics.remoteAuthSessions = sessions.map(s => ({
                session: s.session_name,
                sizeMB: (s.data_size / 1024 / 1024).toFixed(2),
                created: s.created_at,
                updated: s.updated_at
            }));
        } catch (e) {
            diagnostics.remoteAuthSessions_error = e.message;
        }

        // 4. Verificar schema da tabela instances
        try {
            const [columns] = await pool.execute('SHOW COLUMNS FROM instances');
            diagnostics.database.schema = columns.map(c => c.Field);
        } catch (e) {
            diagnostics.database.schema_error = e.message;
        }
    } else {
        diagnostics.database.error = 'Pool não inicializado';
    }

    // 5. Erros recentes
    diagnostics.recentErrors = logBuffer
        .filter(l => l.level === 'ERROR')
        .slice(-20);

    res.json(diagnostics);
});

// ========================================
// API: Fila de Mensagens Pendentes
// ========================================
app.get('/api/queue/status', async(req, res) => {
    try {
        const stats = messageQueue.getStats();
        res.json({
            success: true,
            ...stats
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/queue/:instanceId', async(req, res) => {
    const { instanceId } = req.params;
    try {
        const queue = messageQueue.getQueue(instanceId);
        res.json({
            success: true,
            instanceId,
            pending: queue.length,
            messages: queue
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/queue/:instanceId', async(req, res) => {
    const { instanceId } = req.params;
    try {
        messageQueue.clearQueue(instanceId);
        logger.info(instanceId, 'Fila de mensagens limpa manualmente');
        res.json({
            success: true,
            message: 'Fila limpa'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ========================================
// API: Status detalhado de uma instância
// ========================================
app.get('/api/instance/:id/details', async(req, res) => {
    const { id } = req.params;

    try {
        // Buscar do banco
        let dbData = null;
        if (pool) {
            const [rows] = await pool.execute(
                'SELECT id, name, enabled, connection_status, phone_number, last_connection, last_disconnect_reason, reconnect_attempts FROM instances WHERE id = ?', [id]
            );
            if (rows.length > 0) dbData = rows[0];
        }

        // Buscar da memória
        const session = sessionManager.get(id);

        res.json({
            success: true,
            database: dbData,
            memory: session ? session.toJSON() : null,
            inSync: dbData && session ? (dbData.connection_status === session.status) : null
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Get QR Code Image
app.get('/api/session/qr/:id', async(req, res) => {
    const instanceId = req.params.id;
    const session = sessions.get(instanceId);

    if (!session || !session.qr) {
        return res.status(404).send('QR Code not available (Session not started or already connected)');
    }

    try {
        const qrImage = await qrcode.toBuffer(session.qr);
        res.type('png').send(qrImage);
    } catch (err) {
        res.status(500).send('Error generating QR image');
    }
});

// Send Message API (Updated for Multi-tenant)
app.post('/api/agendar-text', async(req, res) => {
    // Debug: Log completo do que está chegando
    console.log('[API] === REQUEST DEBUG ===');
    console.log('[API] Headers:', JSON.stringify(req.headers));
    console.log('[API] Body:', JSON.stringify(req.body));
    console.log('[API] ======================');

    const { instance, to, message, token } = req.body;

    console.log(`[API] Request received for instance: ${instance}, to: ${to}`);

    if (!instance || !to || !message) {
        console.log('[API] Missing parameters');
        return res.status(400).json({ error: 'Missing parameters' });
    }

    // Validate Token (Optional but recommended)
    if (pool) {
        try {
            const [rows] = await pool.execute('SELECT api_token FROM instances WHERE id = ?', [instance]);

            if (rows.length === 0) {
                console.log(`[API] Instance ${instance} not found in DB`);
                return res.status(404).json({ error: 'Instance not found' });
            }

            if (token && rows[0].api_token !== token) {
                console.warn(`[API] Invalid token for instance ${instance}`);
                return res.status(403).json({ error: 'Invalid token' });
            }
        } catch (err) {
            console.error('[API] Database error validating token:', err);
            // Continue execution? Maybe return 500
        }
    }

    const session = sessions.get(instance);
    if (!session) {
        console.log(`[API] Session not found in memory for ${instance}`);
        return res.status(503).json({ error: 'Instance not active/loaded' });
    }

    if (session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        console.log(`[API] Session ${instance} not connected. Status: ${session.status}`);
        return res.status(503).json({ error: 'Instance not connected' });
    }

    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        console.log(`[API] Sending message to ${chatId}...`);

        const sentMsg = await session.client.sendMessage(chatId, message);

        console.log(`[API] Message sent successfully. ID: ${sentMsg.id._serialized}`);

        res.json({
            message: {
                hash: sentMsg.id._serialized,
                id: sentMsg.id._serialized,
                sent: true
            }
        });
    } catch (error) {
        console.error(`[API] Error sending message from ${instance}:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Alias para /api/agendar-text (compatibilidade com texto.php)
app.post('/api/send-text', async(req, res) => {
    const { instance, to, message, token } = req.body;

    logger.info(instance, `[API send-text] Request to: ${to}`);

    if (!instance || !to || !message) {
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const session = sessionManager.get(instance);

    // ═══════════════════════════════════════════════════════════════════
    // SE DESCONECTADO: Enfileirar mensagem e forçar reconexão
    // ═══════════════════════════════════════════════════════════════════
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        logger.warn(instance, `Instância desconectada - enfileirando mensagem para ${to}`);

        const queueResult = messageQueue.enqueue(instance, {
            type: 'text',
            to: to,
            content: message
        });

        // Forçar reconexão se não estiver já reconectando
        if (!session || session.status !== CONNECTION_STATUS.RECONNECTING) {
            forceReconnect(instance, 'MESSAGE_QUEUED').catch(() => {});
        }

        return res.status(202).json({
            queued: true,
            messageId: queueResult.messageId,
            position: queueResult.position,
            message: 'Mensagem enfileirada. Instância será reconectada e mensagem enviada automaticamente.',
            estimatedDelay: '30-60 segundos'
        });
    }

    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const phoneNumber = to.replace(/\D/g, '');

        const sentMsg = await session.client.sendMessage(chatId, message);
        logger.info(instance, `Mensagem enviada: ${sentMsg.id._serialized}`);

        // Salvar na tabela messages
        if (pool) {
            try {
                await pool.execute(
                    `INSERT INTO messages (instance_id, to_number, message, type, status, sent_at) 
                     VALUES (?, ?, ?, 'text', 'sent', NOW())`, [instance, phoneNumber, message]
                );
            } catch (dbErr) {
                logger.error(instance, `Erro ao salvar mensagem no DB: ${dbErr.message}`);
            }
        }

        res.json({
            message: {
                hash: sentMsg.id._serialized,
                id: sentMsg.id._serialized,
                sent: true
            }
        });
    } catch (error) {
        logger.error(instance, `Erro ao enviar mensagem: ${error.message}`);

        // Se falhou por desconexão, enfileirar
        if (error.message.includes('not connected') || error.message.includes('disconnected')) {
            const queueResult = messageQueue.enqueue(instance, {
                type: 'text',
                to: to,
                content: message
            });

            forceReconnect(instance, 'SEND_FAILED').catch(() => {});

            return res.status(202).json({
                queued: true,
                messageId: queueResult.messageId,
                message: 'Erro ao enviar. Mensagem enfileirada para reenvio automático.'
            });
        }

        res.status(500).json({ error: error.message });
    }
});

// ========================================
// ENVIAR MÍDIA/ARQUIVO PARA CONTATO
// ========================================
app.post('/api/send-media', upload.single('file'), async(req, res) => {
    const { instance, to, caption, token, mediaUrl, mediaBase64, filename, mimetype } = req.body;

    console.log(`[API send-media] Request for instance: ${instance}, to: ${to}`);

    if (!instance || !to) {
        return res.status(400).json({ error: 'instance e to são obrigatórios' });
    }

    // Validar instância
    const session = sessions.get(instance);
    if (!session) {
        console.log(`[API send-media] Session not found for ${instance}`);
        return res.status(503).json({ error: 'Instance not active/loaded' });
    }

    if (session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        console.log(`[API send-media] Session ${instance} not connected. Status: ${session.status}`);
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        let media;

        // Prioridade: arquivo upload > URL > Base64
        if (req.file) {
            // Upload de arquivo
            media = MessageMedia.fromFilePath(req.file.path);
            console.log(`[API send-media] File uploaded: ${req.file.originalname}`);
        } else if (mediaUrl) {
            // URL remota
            media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
            console.log(`[API send-media] Media from URL: ${mediaUrl}`);
        } else if (mediaBase64) {
            // Base64 direto
            if (!mimetype) {
                return res.status(400).json({ error: 'mimetype é obrigatório quando usar mediaBase64' });
            }
            media = new MessageMedia(mimetype, mediaBase64, filename || 'arquivo');
            console.log(`[API send-media] Media from Base64`);
        } else {
            return res.status(400).json({ error: 'Nenhuma mídia fornecida (file, mediaUrl ou mediaBase64)' });
        }

        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const sentMsg = await session.client.sendMessage(chatId, media, {
            caption: caption || ''
        });

        console.log(`[API send-media] Media sent. ID: ${sentMsg.id._serialized}`);

        // Limpar arquivo temporário
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('[API send-media] Error deleting temp file:', err);
            });
        }

        // Salvar no banco
        if (pool) {
            try {
                const phoneNumber = to.replace(/\D/g, '');
                await pool.execute(
                    `INSERT INTO messages (instance_id, to_number, message, type, status, sent_at) 
                     VALUES (?, ?, ?, 'media', 'sent', NOW())`, [instance, phoneNumber, caption || '[MEDIA]']
                );
            } catch (dbErr) {
                console.error('[API send-media] Error saving to DB:', dbErr);
            }
        }

        res.json({
            success: true,
            message: 'Mídia enviada com sucesso',
            messageId: sentMsg.id._serialized
        });
    } catch (error) {
        console.error(`[API send-media] Error:`, error);
        // Limpar arquivo temporário em caso de erro
        if (req.file) {
            fs.unlink(req.file.path, () => {});
        }
        res.status(500).json({ error: error.message });
    }
});

// Rota para agendamento programado com confirmação (compatibilidade com confirmacao.php)
app.post('/api/agendar-program', async(req, res) => {
    const { instance, to, message, msg_erro, msg_confirma, msg_reagendar, id_consulta, url_recebe, data, aviso } = req.body;

    console.log(`[API agendar-program] Request received for instance: ${instance}, to: ${to}, id_consulta: ${id_consulta}`);

    if (!instance || !to || !message) {
        console.log('[API agendar-program] Missing parameters');
        return res.status(400).json({ error: 'Missing parameters' });
    }

    const session = sessions.get(instance);
    if (!session) {
        console.log(`[API agendar-program] Session not found for ${instance}`);
        return res.status(503).json({ error: 'Instance not active/loaded' });
    }

    if (session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        console.log(`[API agendar-program] Session ${instance} not connected. Status: ${session.status}`);
        return res.status(503).json({ error: 'Instance not connected' });
    }

    try {
        const chatId = to.includes('@') ? to : `${to}@c.us`;
        const phoneNumber = to.replace(/\D/g, ''); // Limpar telefone

        // Enviar a mensagem principal
        const sentMsg = await session.client.sendMessage(chatId, message);
        console.log(`[API agendar-program] Message sent. ID: ${sentMsg.id._serialized}`);

        // Salvar na tabela messages (existente)
        if (pool) {
            try {
                await pool.execute(
                    `INSERT INTO messages (instance_id, to_number, message, type, status, sent_at) 
                     VALUES (?, ?, ?, 'text', 'sent', NOW())`, [instance, phoneNumber, message]
                );
                console.log(`[API agendar-program] Message saved to DB`);
            } catch (dbErr) {
                console.error('[API agendar-program] Error saving message:', dbErr);
            }
        }

        // Salvar agendamento para confirmação na tabela agendamentos (existente)
        if (pool && id_consulta) {
            try {
                // Usar a tabela agendamentos existente para guardar info de confirmação
                // Vamos usar o campo error_message para guardar os dados extras (JSON)
                const extraData = JSON.stringify({
                    id_consulta,
                    url_recebe: url_recebe || '',
                    msg_erro: msg_erro || '',
                    msg_confirma: msg_confirma || '',
                    msg_reagendar: msg_reagendar || '',
                    message_id: sentMsg.id._serialized
                });

                await pool.execute(
                    `INSERT INTO agendamentos (instance_id, to_number, message, scheduled_at, status, error_message) 
                     VALUES (?, ?, ?, NOW(), 'pending', ?)`, [instance, phoneNumber, message, extraData]
                );
                console.log(`[API agendar-program] Agendamento saved for id_consulta: ${id_consulta}`);
            } catch (dbErr) {
                console.error('[API agendar-program] Error saving agendamento:', dbErr);
            }
        }

        res.json({
            erro: false,
            message: 'Mensagem enviada com sucesso',
            id: sentMsg.id._serialized,
            hash: sentMsg.id._serialized
        });
    } catch (error) {
        console.error(`[API agendar-program] Error sending message:`, error);
        res.status(500).json({ erro: true, error: error.message });
    }
});

// ========================================
// API DE GRUPOS - Para integração com PHP
// ========================================

// Criar tabela de grupos locais no banco
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

        console.log('✅ Tabelas de grupos criadas/verificadas');
    } catch (err) {
        console.error('Erro ao criar tabelas de grupos:', err);
    }
}

// 1. CRIAR GRUPO NO WHATSAPP
app.post('/api/group/create', async(req, res) => {
    const { instance, name, participants, description } = req.body;

    console.log(`[API Group] Creating group "${name}" for instance ${instance}`);

    if (!instance || !name) {
        return res.status(400).json({ error: 'instance e name são obrigatórios' });
    }

    const session = sessions.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        // Formatar participantes (adicionar @c.us se necessário)
        let participantList = [];
        if (participants && Array.isArray(participants)) {
            participantList = participants.map(p => {
                const phone = p.replace(/\D/g, '');
                return phone.includes('@') ? phone : `${phone}@c.us`;
            });
        }

        // Criar grupo no WhatsApp
        const result = await session.client.createGroup(name, participantList);

        console.log(`[API Group] Group created:`, result);

        // Salvar no banco local
        if (pool && result.gid) {
            const groupId = result.gid._serialized || result.gid;

            await pool.execute(
                `INSERT INTO whatsapp_groups (instance_id, group_id, name, description, created_by) 
                 VALUES (?, ?, ?, ?, ?)
                 ON DUPLICATE KEY UPDATE name = ?, description = ?`, [instance, groupId, name, description || '', session.client.info.wid.user, name, description || '']
            );

            // Salvar membros
            const [groupRow] = await pool.execute(
                'SELECT id FROM whatsapp_groups WHERE instance_id = ? AND group_id = ?', [instance, groupId]
            );

            if (groupRow.length > 0 && result.participants) {
                const localGroupId = groupRow[0].id;
                for (const [participantId, data] of Object.entries(result.participants)) {
                    const phone = participantId.replace('@c.us', '');
                    await pool.execute(
                        `INSERT INTO whatsapp_group_members (group_id, phone_number, is_admin) 
                         VALUES (?, ?, FALSE)
                         ON DUPLICATE KEY UPDATE phone_number = ?`, [localGroupId, phone, phone]
                    );
                }
            }
        }

        res.json({
            success: true,
            message: 'Grupo criado com sucesso',
            group: {
                id: result.gid && result.gid._serialized ? result.gid._serialized : result.gid,
                name: result.title || name,
                participants: result.participants
            }
        });
    } catch (error) {
        console.error(`[API Group] Error creating group:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 2. LISTAR GRUPOS DO WHATSAPP
app.get('/api/group/list/:instance', async(req, res) => {
    const { instance } = req.params;

    console.log(`[API Group] Listing groups for instance ${instance}`);

    const session = sessions.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        if (typeof session.client.getChats !== 'function') {
            return res.status(503).json({ error: 'Cliente ainda inicializando. Aguarde alguns segundos e tente novamente.' });
        }
        const chats = await session.client.getChats();
        const groups = chats.filter(chat => chat.isGroup);

        const groupList = groups.map(g => ({
            id: g.id._serialized,
            name: g.name,
            participantsCount: g.participants ? g.participants.length : 0,
            isReadOnly: g.isReadOnly,
            timestamp: g.timestamp
        }));

        res.json({
            success: true,
            count: groupList.length,
            groups: groupList
        });
    } catch (error) {
        console.error(`[API Group] Error listing groups:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 3. OBTER DETALHES DE UM GRUPO
app.get('/api/group/info/:instance/:groupId', async(req, res) => {
    const { instance, groupId } = req.params;

    console.log(`[API Group] Getting info for group ${groupId}`);

    const session = sessions.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);

        if (!chat || !chat.isGroup) {
            return res.status(404).json({ error: 'Grupo não encontrado' });
        }

        res.json({
            success: true,
            group: {
                id: chat.id._serialized,
                name: chat.name,
                description: chat.description,
                owner: chat.owner && chat.owner.id ? chat.owner.id._serialized : null,
                participants: chat.participants ? chat.participants.map(p => ({
                    id: p.id._serialized,
                    isAdmin: p.isAdmin,
                    isSuperAdmin: p.isSuperAdmin
                })) : [],
                createdAt: chat.createdAt,
                isReadOnly: chat.isReadOnly
            }
        });
    } catch (error) {
        console.error(`[API Group] Error getting group info:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 4. ADICIONAR PARTICIPANTES AO GRUPO
app.post('/api/group/add-participants', async(req, res) => {
    const { instance, groupId, participants } = req.body;

    console.log(`[API Group] Adding participants to group ${groupId}`);
    console.log(`[API Group] Participants:`, participants);

    if (!instance || !groupId || !participants || !Array.isArray(participants)) {
        return res.status(400).json({ error: 'instance, groupId e participants (array) são obrigatórios' });
    }

    const session = sessions.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        console.log(`[API Group] Fetching chat: ${chatId}`);

        const chat = await session.client.getChatById(chatId);

        if (!chat || !chat.isGroup) {
            return res.status(404).json({ error: 'Grupo não encontrado' });
        }

        console.log(`[API Group] Group found: ${chat.name}`);

        // Formatar números - garantir formato correto @c.us
        const participantIds = participants.map(p => {
            // Remover caracteres não numéricos
            const phone = String(p).replace(/\D/g, '');
            // Garantir que não tenha @ duplicado
            if (phone.includes('@')) {
                return phone;
            }
            return `${phone}@c.us`;
        });

        console.log(`[API Group] Formatted participant IDs:`, participantIds);

        const result = await chat.addParticipants(participantIds);

        console.log(`[API Group] Add participants result:`, JSON.stringify(result, null, 2));

        // Verificar se o resultado é uma string de erro
        if (typeof result === 'string' && result.includes('Error')) {
            return res.status(400).json({
                success: false,
                message: result,
                result: null
            });
        }

        res.json({
            success: true,
            message: 'Participantes processados',
            result: result
        });
    } catch (error) {
        console.error(`[API Group] Error adding participants:`, error);
        console.error(`[API Group] Error stack:`, error.stack);

        // Verificar se é o erro de LID
        if (error.message && error.message.includes('Lid is missing')) {
            return res.status(500).json({
                error: 'Erro de sincronização do WhatsApp. Tente reconectar a instância ou aguarde alguns minutos.',
                details: error.message,
                suggestion: 'Este erro pode ocorrer quando o WhatsApp Web precisa sincronizar dados. Tente: 1) Aguardar alguns minutos, 2) Reiniciar a instância, 3) Verificar se o número está correto.'
            });
        }

        res.status(500).json({ error: error.message });
    }
});

// 5. REMOVER PARTICIPANTES DO GRUPO
app.post('/api/group/remove-participants', async(req, res) => {
    const { instance, groupId, participants } = req.body;

    console.log(`[API Group] Removing participants from group ${groupId}`);

    if (!instance || !groupId || !participants || !Array.isArray(participants)) {
        return res.status(400).json({ error: 'instance, groupId e participants (array) são obrigatórios' });
    }

    const session = sessions.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);

        if (!chat || !chat.isGroup) {
            return res.status(404).json({ error: 'Grupo não encontrado' });
        }

        const participantIds = participants.map(p => {
            const phone = p.replace(/\D/g, '');
            return phone.includes('@') ? phone : `${phone}@c.us`;
        });

        const result = await chat.removeParticipants(participantIds);

        res.json({
            success: true,
            message: 'Participantes removidos',
            result: result
        });
    } catch (error) {
        console.error(`[API Group] Error removing participants:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 6. ENVIAR MENSAGEM PARA GRUPO
app.post('/api/group/send-message', async(req, res) => {
    const { instance, groupId, message } = req.body;

    console.log(`[API Group] Sending message to group ${groupId}`);

    if (!instance || !groupId || !message) {
        return res.status(400).json({ error: 'instance, groupId e message são obrigatórios' });
    }

    const session = sessions.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;

        const sentMsg = await session.client.sendMessage(chatId, message);

        console.log(`[API Group] Message sent to group. ID: ${sentMsg.id._serialized}`);

        // Salvar no banco
        if (pool) {
            await pool.execute(
                `INSERT INTO messages (instance_id, to_number, message, type, status, sent_at) 
                 VALUES (?, ?, ?, 'group', 'sent', NOW())`, [instance, groupId, message]
            );
        }

        res.json({
            success: true,
            message: 'Mensagem enviada para o grupo',
            messageId: sentMsg.id._serialized
        });
    } catch (error) {
        console.error(`[API Group] Error sending message to group:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 6.1 ENVIAR MÍDIA PARA GRUPO
app.post('/api/group/send-media', upload.single('file'), async(req, res) => {
    const { instance, groupId, caption, mediaUrl, mediaBase64, filename, mimetype } = req.body;

    console.log(`[API Group] Sending media to group ${groupId}`);

    if (!instance || !groupId) {
        return res.status(400).json({ error: 'instance e groupId são obrigatórios' });
    }

    const session = sessions.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        let media;

        // Prioridade: arquivo upload > URL > Base64
        if (req.file) {
            media = MessageMedia.fromFilePath(req.file.path);
            console.log(`[API Group] File uploaded: ${req.file.originalname}`);
        } else if (mediaUrl) {
            media = await MessageMedia.fromUrl(mediaUrl, { unsafeMime: true });
            console.log(`[API Group] Media from URL: ${mediaUrl}`);
        } else if (mediaBase64 && mimetype) {
            media = new MessageMedia(mimetype, mediaBase64, filename || 'arquivo');
            console.log(`[API Group] Media from Base64`);
        } else {
            return res.status(400).json({ error: 'Nenhuma mídia fornecida (file, mediaUrl ou mediaBase64+mimetype)' });
        }

        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const sentMsg = await session.client.sendMessage(chatId, media, {
            caption: caption || ''
        });

        console.log(`[API Group] Media sent to group. ID: ${sentMsg.id._serialized}`);

        // Limpar arquivo temporário
        if (req.file) {
            fs.unlink(req.file.path, (err) => {
                if (err) console.error('[API Group] Error deleting temp file:', err);
            });
        }

        // Salvar no banco
        if (pool) {
            try {
                await pool.execute(
                    `INSERT INTO messages (instance_id, to_number, message, type, status, sent_at) 
                     VALUES (?, ?, ?, 'group_media', 'sent', NOW())`, [instance, groupId, caption || '[MEDIA]']
                );
            } catch (dbErr) {
                console.error('[API Group] Error saving to DB:', dbErr);
            }
        }

        res.json({
            success: true,
            message: 'Mídia enviada para o grupo',
            messageId: sentMsg.id._serialized
        });
    } catch (error) {
        console.error(`[API Group] Error sending media to group:`, error);
        if (req.file) {
            fs.unlink(req.file.path, () => {});
        }
        res.status(500).json({ error: error.message });
    }
});

// 7. OBTER LINK DE CONVITE DO GRUPO
app.get('/api/group/invite-link/:instance/:groupId', async(req, res) => {
    const { instance, groupId } = req.params;

    console.log(`[API Group] Getting invite link for group ${groupId}`);

    const session = sessions.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);

        if (!chat || !chat.isGroup) {
            return res.status(404).json({ error: 'Grupo não encontrado' });
        }

        const inviteCode = await chat.getInviteCode();

        res.json({
            success: true,
            inviteCode: inviteCode,
            inviteLink: `https://chat.whatsapp.com/${inviteCode}`
        });
    } catch (error) {
        console.error(`[API Group] Error getting invite link:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 8. ATUALIZAR INFORMAÇÕES DO GRUPO (nome, descrição)
app.post('/api/group/update', async(req, res) => {
    const { instance, groupId, name, description } = req.body;

    console.log(`[API Group] Updating group ${groupId}`);

    if (!instance || !groupId) {
        return res.status(400).json({ error: 'instance e groupId são obrigatórios' });
    }

    const session = sessions.get(instance);
    if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
        return res.status(503).json({ error: 'Instância não conectada' });
    }

    try {
        const chatId = groupId.includes('@') ? groupId : `${groupId}@g.us`;
        const chat = await session.client.getChatById(chatId);

        if (!chat || !chat.isGroup) {
            return res.status(404).json({ error: 'Grupo não encontrado' });
        }

        const results = {};

        if (name) {
            await chat.setSubject(name);
            results.nameUpdated = true;
        }

        if (description !== undefined) {
            await chat.setDescription(description);
            results.descriptionUpdated = true;
        }

        res.json({
            success: true,
            message: 'Grupo atualizado',
            results: results
        });
    } catch (error) {
        console.error(`[API Group] Error updating group:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 9. LISTAR GRUPOS SALVOS NO BANCO LOCAL (para o sistema PHP)
app.get('/api/local-groups/:instance', async(req, res) => {
    const { instance } = req.params;

    if (!pool) {
        return res.status(500).json({ error: 'Banco de dados não conectado' });
    }

    try {
        const [groups] = await pool.execute(
            `SELECT g.*, 
                    (SELECT COUNT(*) FROM whatsapp_group_members WHERE group_id = g.id) as member_count
             FROM whatsapp_groups g 
             WHERE g.instance_id = ? 
             ORDER BY g.created_at DESC`, [instance]
        );

        res.json({
            success: true,
            count: groups.length,
            groups: groups
        });
    } catch (error) {
        console.error(`[API Group] Error listing local groups:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 10. SALVAR/CRIAR GRUPO LOCAL (para gerenciamento no PHP)
app.post('/api/local-groups/create', async(req, res) => {
    const { instance, name, description, members } = req.body;

    if (!pool) {
        return res.status(500).json({ error: 'Banco de dados não conectado' });
    }

    if (!instance || !name) {
        return res.status(400).json({ error: 'instance e name são obrigatórios' });
    }

    try {
        // Primeiro criar o grupo no WhatsApp
        const session = sessions.get(instance);
        if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
            return res.status(503).json({ error: 'Instância não conectada' });
        }

        let participantList = [];
        if (members && Array.isArray(members)) {
            participantList = members.map(m => {
                const phone = (m.phone || m).toString().replace(/\D/g, '');
                return `${phone}@c.us`;
            });
        }

        const result = await session.client.createGroup(name, participantList);
        const groupId = (result.gid && result.gid._serialized) ? result.gid._serialized : result.gid;

        // Salvar no banco local
        const [insertResult] = await pool.execute(
            `INSERT INTO whatsapp_groups (instance_id, group_id, name, description, created_by) 
             VALUES (?, ?, ?, ?, ?)`, [instance, groupId, name, description || '', session.client.info.wid.user]
        );

        const localGroupId = insertResult.insertId;

        // Salvar membros
        if (members && Array.isArray(members)) {
            for (const member of members) {
                const phone = (member.phone || member).toString().replace(/\D/g, '');
                const memberName = member.name || '';
                await pool.execute(
                    `INSERT INTO whatsapp_group_members (group_id, phone_number, name) 
                     VALUES (?, ?, ?)`, [localGroupId, phone, memberName]
                );
            }
        }

        res.json({
            success: true,
            message: 'Grupo criado com sucesso',
            localGroupId: localGroupId,
            whatsappGroupId: groupId,
            name: name
        });
    } catch (error) {
        console.error(`[API Group] Error creating local group:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 11. ADICIONAR MEMBRO AO GRUPO LOCAL
app.post('/api/local-groups/add-member', async(req, res) => {
    const { localGroupId, phone, name } = req.body;

    if (!pool) {
        return res.status(500).json({ error: 'Banco de dados não conectado' });
    }

    if (!localGroupId || !phone) {
        return res.status(400).json({ error: 'localGroupId e phone são obrigatórios' });
    }

    try {
        // Buscar grupo local
        const [groups] = await pool.execute(
            'SELECT * FROM whatsapp_groups WHERE id = ?', [localGroupId]
        );

        if (groups.length === 0) {
            return res.status(404).json({ error: 'Grupo local não encontrado' });
        }

        const group = groups[0];
        const phoneClean = phone.replace(/\D/g, '');

        // Adicionar no WhatsApp
        const session = sessions.get(group.instance_id);
        if (session && session.status === CONNECTION_STATUS.CONNECTED && session.client) {
            const chat = await session.client.getChatById(group.group_id);
            if (chat && chat.isGroup) {
                await chat.addParticipants([`${phoneClean}@c.us`]);
            }
        }

        // Salvar no banco local
        await pool.execute(
            `INSERT INTO whatsapp_group_members (group_id, phone_number, name) 
             VALUES (?, ?, ?)
             ON DUPLICATE KEY UPDATE name = ?`, [localGroupId, phoneClean, name || '', name || '']
        );

        res.json({
            success: true,
            message: 'Membro adicionado com sucesso'
        });
    } catch (error) {
        console.error(`[API Group] Error adding member:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 12. LISTAR MEMBROS DE UM GRUPO LOCAL
app.get('/api/local-groups/:localGroupId/members', async(req, res) => {
    const { localGroupId } = req.params;

    if (!pool) {
        return res.status(500).json({ error: 'Banco de dados não conectado' });
    }

    try {
        const [members] = await pool.execute(
            'SELECT * FROM whatsapp_group_members WHERE group_id = ? ORDER BY added_at DESC', [localGroupId]
        );

        res.json({
            success: true,
            count: members.length,
            members: members
        });
    } catch (error) {
        console.error(`[API Group] Error listing members:`, error);
        res.status(500).json({ error: error.message });
    }
});

// 13. ENVIAR MENSAGEM PARA GRUPO LOCAL (por ID local)
app.post('/api/local-groups/send-message', async(req, res) => {
    const { localGroupId, message } = req.body;

    if (!pool) {
        return res.status(500).json({ error: 'Banco de dados não conectado' });
    }

    if (!localGroupId || !message) {
        return res.status(400).json({ error: 'localGroupId e message são obrigatórios' });
    }

    try {
        // Buscar grupo local
        const [groups] = await pool.execute(
            'SELECT * FROM whatsapp_groups WHERE id = ?', [localGroupId]
        );

        if (groups.length === 0) {
            return res.status(404).json({ error: 'Grupo local não encontrado' });
        }

        const group = groups[0];

        const session = sessions.get(group.instance_id);
        if (!session || session.status !== CONNECTION_STATUS.CONNECTED || !session.client) {
            return res.status(503).json({ error: 'Instância não conectada' });
        }

        const sentMsg = await session.client.sendMessage(group.group_id, message);

        // Salvar no banco
        await pool.execute(
            `INSERT INTO messages (instance_id, to_number, message, type, status, sent_at) 
             VALUES (?, ?, ?, 'group', 'sent', NOW())`, [group.instance_id, group.group_id, message]
        );

        res.json({
            success: true,
            message: 'Mensagem enviada para o grupo',
            messageId: sentMsg.id._serialized,
            groupName: group.name
        });
    } catch (error) {
        console.error(`[API Group] Error sending message to local group:`, error);
        res.status(500).json({ error: error.message });
    }
});

// Initialize
const PORT = process.env.PORT || 3000;

// ========================================
// SISTEMA DE MONITORAMENTO DE SAÚDE ULTRA-ROBUSTO
// ========================================
let healthCheckInterval = null;
let deepHealthCheckInterval = null;
let instanceRecoveryInterval = null;

// Função para limpar todos os intervalos de uma sessão (usa SessionState.clearIntervals + legacy)
function clearSessionIntervals(session) {
    // Usar método do SessionState se disponível
    if (session && typeof session.clearIntervals === 'function') {
        session.clearIntervals();
    }
    // Limpar intervalos legacy armazenados diretamente na sessão
    if (session.keepAliveInterval) {
        clearInterval(session.keepAliveInterval);
        session.keepAliveInterval = null;
    }
    if (session.websocketCheckInterval) {
        clearInterval(session.websocketCheckInterval);
        session.websocketCheckInterval = null;
    }
    if (session.watchdogInterval) {
        clearInterval(session.watchdogInterval);
        session.watchdogInterval = null;
    }
}

async function healthCheck() {
    const now = Date.now();
    console.log(`[HealthCheck] 🏥 Verificando ${sessions.size} sessões...`);

    for (const [instanceId, session] of sessions.entries()) {
        try {
            // 1. Verificar se o cliente existe
            if (!session.client) {
                console.log(`[HealthCheck] ${instanceId}: 🔴 Cliente nulo`);
                clearSessionIntervals(session);
                sessions.delete(instanceId);
                await forceReconnect(instanceId, 'CLIENTE_NULO');
                continue;
            }

            // 2. Verificar se o Browser ainda está conectado
            const browserConnected = session.client.pupBrowser && session.client.pupBrowser.isConnected();
            if (!browserConnected) {
                console.log(`[HealthCheck] ${instanceId}: 🔴 Browser desconectado`);
                await forceReconnect(instanceId, 'BROWSER_DESCONECTADO');
                continue;
            }

            // 3. Verificar se a página está fechada
            const pageOpen = session.client.pupPage && !session.client.pupPage.isClosed();
            if (!pageOpen) {
                console.log(`[HealthCheck] ${instanceId}: 🔴 Página fechada`);
                await forceReconnect(instanceId, 'PAGINA_FECHADA');
                continue;
            }

            // 4. Verificar inatividade (usando configuração)
            const inactiveTime = now - (session.lastActivity || now);
            if (session.status === CONNECTION_STATUS.CONNECTED && inactiveTime > RESILIENCE_CONFIG.INACTIVITY_THRESHOLD) {
                console.log(`[HealthCheck] ${instanceId}: ⚠️ Inativo há ${Math.round(inactiveTime/1000)}s`);

                try {
                    const state = await Promise.race([
                        session.client.getState(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), RESILIENCE_CONFIG.STATE_CHECK_TIMEOUT))
                    ]);

                    if (state === 'CONNECTED') {
                        session.lastActivity = now;
                        session.lastSuccessfulPing = now;
                        console.log(`[HealthCheck] ${instanceId}: ✅ Ainda conectado`);
                    } else if (state === 'CONFLICT') {
                        console.log(`[HealthCheck] ${instanceId}: ⚠️ Conflito - takeover...`);
                        try {
                            await session.client.pupPage.evaluate(() => window.Store.AppState.takeover());
                        } catch (e) {}
                    } else {
                        console.log(`[HealthCheck] ${instanceId}: ⚠️ Estado: ${state}`);
                        session.consecutiveFailures++;
                    }
                } catch (e) {
                    console.log(`[HealthCheck] ${instanceId}: 🔴 Não responde: ${e.message}`);
                    session.consecutiveFailures = (session.consecutiveFailures || 0) + 1;

                    if (session.consecutiveFailures >= RESILIENCE_CONFIG.MAX_CONSECUTIVE_FAILURES) {
                        await forceReconnect(instanceId, 'FALHAS_CONSECUTIVAS');
                    }
                }
            }

            // 5. Verificar sessões travadas em LOADING
            if (session.status.startsWith('LOADING_') || session.status === CONNECTION_STATUS.INITIALIZING) {
                const loadingTime = now - (session.loadingStartTime || now);
                if (loadingTime > RESILIENCE_CONFIG.LOADING_TIMEOUT) {
                    console.log(`[HealthCheck] ${instanceId}: 🔴 Travado em ${session.status} há ${Math.round(loadingTime/1000)}s`);
                    await forceReconnect(instanceId, 'LOADING_TRAVADO');
                }
            }

            // 6. Verificar tempo desde último ping bem-sucedido
            if (session.status === CONNECTION_STATUS.CONNECTED && session.lastSuccessfulPing) {
                const timeSinceLastPing = now - session.lastSuccessfulPing;
                if (timeSinceLastPing > RESILIENCE_CONFIG.PING_TIMEOUT_THRESHOLD) {
                    console.log(`[HealthCheck] ${instanceId}: 🔴 Sem ping bem-sucedido há ${Math.round(timeSinceLastPing/1000)}s`);
                    await forceReconnect(instanceId, 'SEM_PING_SUCESSO');
                }
            }

            // 7. WebSocket check REMOVIDO - desabilitado (era redundante com heartbeat)

        } catch (err) {
            console.error(`[HealthCheck] Erro em ${instanceId}:`, err.message);
        }
    }
}

// Verificar instâncias que deveriam estar ativas mas não estão
// IMPORTANTE: Usa enabled=1 (intenção) ao invés de status=1 (estado momentâneo)
async function checkMissingInstances() {
    if (!pool) return;

    try {
        // Buscar instâncias com enabled=1 (marcadas para auto-start)
        const [rows] = await pool.execute('SELECT id, name FROM instances WHERE enabled = 1');

        for (const row of rows) {
            if (!sessionManager.has(row.id)) {
                logger.health(row.id, `Instância "${row.name}" deveria estar ativa. Iniciando...`);
                try {
                    await startSession(row.id);
                } catch (startErr) {
                    logger.error(row.id, `Erro ao iniciar instância "${row.name}": ${startErr.message}`);
                }
                // Aguardar um pouco entre inicializações para não sobrecarregar
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    } catch (err) {
        logger.error(null, `Erro ao verificar instâncias: ${err.message}`);
    }
}

// Deep health check - verificação ULTRA-PROFUNDA
// TOLERÂNCIA: requer 2 falhas consecutivas antes de forçar reconexão
// Evita reconexões desnecessárias por estados transientes do WebSocket
const DEEP_CHECK_MAX_FAILURES = 2;

async function deepHealthCheck() {
    console.log(`[DeepHealthCheck] 🔬 Verificação profunda iniciada...`);

    for (const [instanceId, session] of sessions.entries()) {
        if (session.status !== CONNECTION_STATUS.CONNECTED || !session.client) continue;

        try {
            // Verificação completa de operação
            const deepCheck = await Promise.race([
                (async() => {
                    const checks = {
                        state: null,
                        storeOk: false,
                        chatOk: false,
                        socketOk: false,
                        socketState: null,
                        memoryOk: false
                    };

                    // 1. Verificar estado
                    checks.state = await session.client.getState();
                    if (checks.state !== 'CONNECTED') return checks;

                    // 2. Verificar Store completo
                    const storeStatus = await session.client.pupPage.evaluate(() => {
                        try {
                            return {
                                store: typeof window.Store !== 'undefined',
                                chat: window.Store && typeof window.Store.Chat !== 'undefined',
                                msg: window.Store && typeof window.Store.Msg !== 'undefined',
                                socket: window.Store && window.Store.Socket && window.Store.Socket.state === 'CONNECTED',
                                socketState: window.Store && window.Store.Socket ? window.Store.Socket.state : 'N/A',
                                conn: window.Store && typeof window.Store.Conn !== 'undefined'
                            };
                        } catch (e) {
                            return { error: e.message };
                        }
                    });

                    checks.storeOk = storeStatus.store;
                    checks.chatOk = storeStatus.chat;
                    checks.socketOk = storeStatus.socket;
                    checks.socketState = storeStatus.socketState;

                    // 3. Verificar memória do browser
                    try {
                        const metrics = await session.client.pupPage.metrics();
                        checks.memoryOk = metrics.JSHeapUsedSize < 500 * 1024 * 1024; // < 500MB
                        checks.heapUsedMB = Math.round(metrics.JSHeapUsedSize / 1024 / 1024);
                    } catch (e) {
                        checks.memoryOk = true; // Assumir OK se não conseguir verificar
                    }

                    return checks;
                })(),
                new Promise((_, reject) => setTimeout(() => reject(new Error('DEEP_CHECK_TIMEOUT')), 20000))
            ]);

            // Avaliar resultado com TOLERÂNCIA a falhas transientes
            let failReason = null;

            if (deepCheck.state !== 'CONNECTED') {
                failReason = `ESTADO_INVALIDO (state=${deepCheck.state})`;
            } else if (!deepCheck.socketOk) {
                failReason = `WEBSOCKET_NAO_CONECTADO (socketState=${deepCheck.socketState})`;
            }

            if (failReason) {
                session.deepCheckFailures = (session.deepCheckFailures || 0) + 1;
                console.log(`[DeepHealthCheck] ${instanceId}: ⚠️ Falha ${session.deepCheckFailures}/${DEEP_CHECK_MAX_FAILURES}: ${failReason}`);

                if (session.deepCheckFailures >= DEEP_CHECK_MAX_FAILURES) {
                    console.log(`[DeepHealthCheck] ${instanceId}: 🔴 ${session.deepCheckFailures} falhas consecutivas - reconectando!`);
                    session.deepCheckFailures = 0;
                    await forceReconnect(instanceId, `DEEP_CHECK_${failReason}`);
                }
            } else if (!deepCheck.storeOk || !deepCheck.chatOk) {
                console.log(`[DeepHealthCheck] ${instanceId}: ⚠️ Store incompleto (store=${deepCheck.storeOk}, chat=${deepCheck.chatOk}) - apenas alerta`);
                // Não reconectar, não contar como falha fatal
            } else {
                // Tudo OK - resetar contador de falhas
                session.deepCheckFailures = 0;
                console.log(`[DeepHealthCheck] ${instanceId}: ✅ Operacional (heap: ${deepCheck.heapUsedMB || '?'}MB, socket: ${deepCheck.socketState})`);
                session.lastDeepCheck = Date.now();
                session.lastSuccessfulPing = Date.now(); // Atualizar ping
            }
        } catch (err) {
            console.error(`[DeepHealthCheck] ${instanceId}: ⚠️ Timeout/Erro: ${err.message}`);
            session.deepCheckFailures = (session.deepCheckFailures || 0) + 1;

            if (session.deepCheckFailures >= DEEP_CHECK_MAX_FAILURES) {
                console.log(`[DeepHealthCheck] ${instanceId}: 🔴 ${session.deepCheckFailures} timeouts/erros consecutivos - reconectando!`);
                session.deepCheckFailures = 0;
                await forceReconnect(instanceId, 'DEEP_CHECK_TIMEOUT');
            } else {
                console.log(`[DeepHealthCheck] ${instanceId}: Falha ${session.deepCheckFailures}/${DEEP_CHECK_MAX_FAILURES}, aguardando próximo check`);
            }
        }
    }
}

// Verificação de recuperação de instâncias - FUNCIONA SEM BANCO DE DADOS
// Integrado com memoryMonitor para detectar zumbis e sessões travadas
async function instanceRecoveryCheck() {
    try {
        logger.health(null, `Recovery check: ${sessionManager.size} sessões em memória`);

        // 1. Detectar e recuperar sessões zumbis via memoryMonitor
        await memoryMonitor.detectZombies();

        // 2. Detectar e recuperar sessões travadas
        await memoryMonitor.detectStuckSessions();

        // 3. Verificar sessões em memória que precisam de reconexão
        for (const [instanceId, session] of sessionManager.entries()) {
            // Se a sessão está marcada para reconexão
            if (session.needsReconnect) {
                logger.reconnect(instanceId, 'Sessão marcada para reconexão');
                session.needsReconnect = false;
                await forceReconnect(instanceId, 'RECOVERY_MARCADA');
                await new Promise(resolve => setTimeout(resolve, 3000));
                continue;
            }

            // Se tem sessão mas não está conectada há muito tempo, forçar reconexão
            // IMPORTANTE: NÃO reconectar sessões em QR_CODE - o usuário precisa de tempo para escanear
            // O status real do QR é 'QR_CODE' (não 'QR_REQUIRED' do enum)
            const skipStatuses = [
                CONNECTION_STATUS.CONNECTED,
                CONNECTION_STATUS.QR_REQUIRED,
                'QR_CODE',
                CONNECTION_STATUS.RECONNECTING,
                CONNECTION_STATUS.INITIALIZING,
                'AUTHENTICATED',
                'SYNC_TIMEOUT'
            ];
            // Também pular status LOADING_* (LOADING_50%, LOADING_100%, etc)
            const isLoading = session.status && session.status.startsWith('LOADING_');
            if (!isLoading && !skipStatuses.includes(session.status)) {
                const timeSinceLoad = Date.now() - (session.loadingStartTime || Date.now());
                // Aumentado para 300 segundos (5 min) - menos agressivo
                if (timeSinceLoad > 300000) {
                    logger.reconnect(instanceId, `Sessão travada em ${session.status} por ${Math.round(timeSinceLoad/1000)}s - FORÇANDO reconexão`);
                    await forceReconnect(instanceId, 'RECOVERY_TRAVADA');
                    await new Promise(resolve => setTimeout(resolve, 3000));
                    continue;
                }
            }

            // Se a sessão está DISCONNECTED, reconectar IMEDIATAMENTE
            if (session.status === CONNECTION_STATUS.DISCONNECTED) {
                logger.reconnect(instanceId, '⚠️ Sessão DISCONNECTED - reconectando IMEDIATAMENTE');
                await forceReconnect(instanceId, 'DISCONNECTED_RECOVERY');
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }

        // CRÍTICO: Buscar TODAS as instâncias enabled=1 do banco e garantir
        // que estejam ativas. Isso é o WATCHDOG principal.
        if (pool) {
            try {
                const [rows] = await pool.execute(
                    'SELECT id, name, connection_status FROM instances WHERE enabled = 1'
                );

                for (const row of rows) {
                    const session = sessionManager.get(row.id);

                    // Caso 1: Instância enabled=1 sem sessão em memória
                    if (!session) {
                        logger.reconnect(row.id, `⚠️ WATCHDOG: Instância "${row.name}" enabled=1 SEM sessão - INICIANDO`);
                        await startSession(row.id);
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    }

                    // Caso 2: Sessão existe mas está DISCONNECTED
                    if (session.status === CONNECTION_STATUS.DISCONNECTED) {
                        logger.reconnect(row.id, `⚠️ WATCHDOG: Instância "${row.name}" DISCONNECTED - FORÇANDO reconexão`);
                        await forceReconnect(row.id, 'WATCHDOG_DISCONNECTED');
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    }

                    // Caso 3: Sessão existe mas sem cliente válido
                    if (!session.client) {
                        logger.reconnect(row.id, `⚠️ WATCHDOG: Instância "${row.name}" sem cliente - REINICIANDO`);
                        await forceReconnect(row.id, 'WATCHDOG_NO_CLIENT');
                        await new Promise(resolve => setTimeout(resolve, 3000));
                        continue;
                    }

                    // Caso 4: Banco diz DISCONNECTED mas memória diz diferente - sincronizar
                    if (row.connection_status === 'DISCONNECTED' && session.status === CONNECTION_STATUS.CONNECTED) {
                        logger.session(row.id, 'Sincronizando banco: marcando como CONNECTED');
                        await updateInstanceStatus(row.id, 1, null, CONNECTION_STATUS.CONNECTED);
                    }
                }
            } catch (dbErr) {
                logger.error(null, `Erro no watchdog DB: ${dbErr.message}`);
            }
        }
    } catch (err) {
        logger.error(null, `Erro no recovery check: ${err.message}`);
    }
}

let memoryCheckInterval = null;

function startHealthCheck() {
    // Health check agressivo
    healthCheckInterval = setInterval(async() => {
        await healthCheck();
        await checkMissingInstances();
    }, RESILIENCE_CONFIG.HEALTH_CHECK_INTERVAL);
    shutdownHandler.registerInterval(healthCheckInterval);

    // Deep health check - SOMENTE se habilitado (desabilitado por padrão - causa instabilidade)
    if (RESILIENCE_CONFIG.ENABLE_DEEP_HEALTH_CHECK) {
        deepHealthCheckInterval = setInterval(async() => {
            await deepHealthCheck();
        }, RESILIENCE_CONFIG.DEEP_HEALTH_CHECK_INTERVAL);
        shutdownHandler.registerInterval(deepHealthCheckInterval);
    } else {
        logger.config('Deep Check', 'DESABILITADO (reduz instabilidade)');
    }

    // Recovery check usando intervalo do config (180s)
    // Instâncias enabled=1 NUNCA podem ficar desconectadas
    instanceRecoveryInterval = setInterval(async() => {
        await instanceRecoveryCheck();
    }, RESILIENCE_CONFIG.RECOVERY_CHECK_INTERVAL);
    shutdownHandler.registerInterval(instanceRecoveryInterval);

    // Memory check - monitoramento de memória e zumbis
    memoryCheckInterval = setInterval(async() => {
        await memoryMonitor.check();
    }, RESILIENCE_CONFIG.MEMORY_CHECK_INTERVAL);
    shutdownHandler.registerInterval(memoryCheckInterval);

    logger.section('SISTEMA DE MONITORAMENTO INICIADO');
    logger.config('Health Check', `${RESILIENCE_CONFIG.HEALTH_CHECK_INTERVAL/1000}s`);
    logger.config('Deep Check', `${RESILIENCE_CONFIG.DEEP_HEALTH_CHECK_INTERVAL/1000}s`);
    logger.config('Recovery Check', `${RESILIENCE_CONFIG.RECOVERY_CHECK_INTERVAL/1000}s`);
    logger.config('Memory Check', `${RESILIENCE_CONFIG.MEMORY_CHECK_INTERVAL/1000}s`);
    logger.config('Watchdog', 'Instâncias enabled=1 NUNCA ficam desconectadas');
}

function stopHealthCheck() {
    if (healthCheckInterval) {
        clearInterval(healthCheckInterval);
        healthCheckInterval = null;
    }
    if (deepHealthCheckInterval) {
        clearInterval(deepHealthCheckInterval);
        deepHealthCheckInterval = null;
    }
    if (instanceRecoveryInterval) {
        clearInterval(instanceRecoveryInterval);
        instanceRecoveryInterval = null;
    }
    if (memoryCheckInterval) {
        clearInterval(memoryCheckInterval);
        memoryCheckInterval = null;
    }
    logger.info(null, 'Sistema de monitoramento parado');
}

// ========================================
// INICIALIZAÇÃO
// ========================================

(async() => {
    await initDB();
    await initGroupsTable();

    // Iniciar health check após 15 segundos
    setTimeout(() => {
        startHealthCheck();
    }, 15000);

    app.listen(PORT, () => {
        logger.startup('WhatsApp Bot API - RESILIENTE v3.0');

        console.log(`✅ Server running on port ${PORT}`);
        console.log(`📁 Session Storage: ${RESILIENCE_CONFIG.SESSION_STORAGE_PATH || path.join(__dirname, '.wwebjs_auth')}`);

        logger.section('SISTEMA DE RESILIÊNCIA');
        logger.config('Heartbeat', `${RESILIENCE_CONFIG.HEARTBEAT_INTERVAL/1000}s`);
        logger.config('WebSocket Check', `${RESILIENCE_CONFIG.WEBSOCKET_CHECK_INTERVAL/1000}s`);
        logger.config('Health Check', `${RESILIENCE_CONFIG.HEALTH_CHECK_INTERVAL/1000}s`);
        logger.config('Deep Check', `${RESILIENCE_CONFIG.DEEP_HEALTH_CHECK_INTERVAL/1000}s`);
        logger.config('Recovery Check', `${RESILIENCE_CONFIG.RECOVERY_CHECK_INTERVAL/1000}s`);
        logger.config('Memory Check', `${RESILIENCE_CONFIG.MEMORY_CHECK_INTERVAL/1000}s`);
        logger.config('Max Reconexões', `${RESILIENCE_CONFIG.MAX_RECONNECT_ATTEMPTS}`);

        logger.section('CONFIGURAÇÕES DE SEGURANÇA');
        logger.config('Timeout Estado', `${RESILIENCE_CONFIG.STATE_CHECK_TIMEOUT/1000}s`);
        logger.config('Timeout Destruir', `${RESILIENCE_CONFIG.DESTROY_TIMEOUT/1000}s`);
        logger.config('Threshold Inatividade', `${RESILIENCE_CONFIG.INACTIVITY_THRESHOLD/1000}s`);
        logger.config('Threshold Ping', `${RESILIENCE_CONFIG.PING_TIMEOUT_THRESHOLD/1000}s`);
        logger.config('Threshold Zumbi', `${RESILIENCE_CONFIG.ZOMBIE_THRESHOLD/1000}s`);

        logger.section('MODELO DE DADOS');
        logger.config('enabled', 'Define se instância deve subir automaticamente');
        logger.config('connection_status', 'Estado atual (CONNECTED, DISCONNECTED, RECONNECTING, etc)');
        logger.config('Reidratação', 'Baseada em enabled=1, não no estado momentâneo');

        logger.section('FUNCIONALIDADES');
        console.log('   ✅ Reconexão automática com backoff exponencial');
        console.log('   ✅ Detecção de sessões zumbis e travadas');
        console.log('   ✅ Monitoramento de memória');
        console.log('   ✅ Shutdown gracioso (SIGINT, SIGTERM)');
        console.log('   ✅ Persistência segura de sessão');
        console.log('   ✅ Reidratação automática de instâncias');
        console.log('   ✅ Logs estruturados por categoria');

        logger.section('APIs DISPONÍVEIS');
        console.log('   📱 POST /api/send-text | /api/send-media | /api/agendar-program');
        console.log('   👥 POST /api/group/create | GET /api/group/list/:instance');
        console.log('   🔧 GET /api/health | POST /api/health/check');
        console.log('   📊 GET /api/instances | GET /api/session/status/:id');

        console.log(`\n${'═'.repeat(60)}`);
        console.log('💡 Sistema projetado para MÁXIMA RESILIÊNCIA e DISPONIBILIDADE');
        console.log(`${'═'.repeat(60)}\n`);
    });
})();
