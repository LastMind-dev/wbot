/**
 * Cleanup de processos Chromium órfãos e SingletonLock
 * Previne acúmulo de processos Chrome quando destroy() dá timeout
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

/**
 * Mata processos Chromium órfãos que não estão mais sendo gerenciados
 * @param {Set<number>} activePids - PIDs de processos Chrome atualmente gerenciados
 */
function killOrphanChromiumProcesses(activePids = new Set()) {
    try {
        const isWindows = process.platform === 'win32';
        let output;

        if (isWindows) {
            output = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /FO CSV /NH', {
                encoding: 'utf-8',
                timeout: 5000
            });
        } else {
            output = execSync('ps aux | grep -i "[c]hrom" | awk \'{print $2}\'', {
                encoding: 'utf-8',
                timeout: 5000
            });
        }

        if (!output || output.trim() === '' || output.includes('No tasks')) {
            return 0;
        }

        let killed = 0;

        if (isWindows) {
            // Parse CSV output: "chrome.exe","12345","Console","1","100,000 K"
            const lines = output.trim().split('\n');
            for (const line of lines) {
                const match = line.match(/"chrome\.exe","(\d+)"/i);
                if (match) {
                    const pid = parseInt(match[1]);
                    if (!activePids.has(pid)) {
                        try {
                            process.kill(pid, 'SIGTERM');
                            killed++;
                        } catch (e) {
                            // Process already dead
                        }
                    }
                }
            }
        } else {
            const pids = output.trim().split('\n').map(p => parseInt(p.trim())).filter(p => !isNaN(p));
            for (const pid of pids) {
                if (!activePids.has(pid)) {
                    try {
                        process.kill(pid, 'SIGTERM');
                        killed++;
                    } catch (e) {
                        // Process already dead
                    }
                }
            }
        }

        if (killed > 0) {
            logger.info(null, `Limpeza: ${killed} processo(s) Chromium órfão(s) encerrado(s)`);
        }
        return killed;
    } catch (e) {
        // Silent fail - cleanup is best-effort
        return 0;
    }
}

/**
 * Remove SingletonLock files que impedem o Chrome de abrir após crash
 * @param {string} authPath - Caminho base de autenticação (.wwebjs_auth)
 */
function cleanSingletonLocks(authPath) {
    try {
        if (!fs.existsSync(authPath)) return 0;

        const dirs = fs.readdirSync(authPath);
        let cleaned = 0;

        for (const dir of dirs) {
            const lockFile = path.join(authPath, dir, 'SingletonLock');
            if (fs.existsSync(lockFile)) {
                try {
                    fs.unlinkSync(lockFile);
                    cleaned++;
                    logger.info(null, `SingletonLock removido: ${dir}`);
                } catch (e) {
                    logger.warn(null, `Não foi possível remover SingletonLock: ${dir} - ${e.message}`);
                }
            }

            // Também limpar SingletonCookie e SingletonSocket
            for (const lockName of ['SingletonCookie', 'SingletonSocket']) {
                const otherLock = path.join(authPath, dir, lockName);
                if (fs.existsSync(otherLock)) {
                    try {
                        fs.unlinkSync(otherLock);
                        cleaned++;
                    } catch (e) {
                        // Silent
                    }
                }
            }
        }

        if (cleaned > 0) {
            logger.info(null, `Limpeza: ${cleaned} lock file(s) removido(s)`);
        }
        return cleaned;
    } catch (e) {
        return 0;
    }
}

/**
 * Força kill do processo Chromium de um cliente específico
 * Usado quando client.destroy() dá timeout
 * @param {object} client - WhatsApp client instance
 */
async function forceKillClientBrowser(client) {
    try {
        if (!client || !client.pupBrowser) return false;

        const browserProcess = client.pupBrowser.process();
        if (browserProcess && browserProcess.pid) {
            const pid = browserProcess.pid;
            logger.warn(null, `Force-killing browser process PID ${pid}`);

            // Tentar SIGTERM primeiro, depois SIGKILL
            try {
                process.kill(pid, 'SIGTERM');
                // Dar 2s para fechar graciosamente
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Se ainda existe, force kill
                try {
                    process.kill(pid, 0); // Check if still alive
                    process.kill(pid, 'SIGKILL');
                } catch (e) {
                    // Process already dead - ok
                }
            } catch (e) {
                // Process already dead
            }

            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

/**
 * Executa limpeza completa no startup
 * @param {string} authPath - Caminho base de autenticação
 */
function startupCleanup(authPath) {
    logger.info(null, 'Executando limpeza de startup...');
    cleanSingletonLocks(authPath);
    // Não matamos processos Chrome no startup porque podem ser de outros apps
    // Apenas limpamos locks
}

module.exports = {
    killOrphanChromiumProcesses,
    cleanSingletonLocks,
    forceKillClientBrowser,
    startupCleanup
};
