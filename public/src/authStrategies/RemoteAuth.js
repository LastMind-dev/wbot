'use strict';

/* Require Optional Dependencies */
try {
    var fs = require('fs-extra');
    var unzipper = require('unzipper');
    var archiver = require('archiver');
} catch {
    fs = undefined;
    unzipper = undefined;
    archiver = undefined;
}

const path = require('path');
const { Events } = require('./../util/Constants');
const BaseAuthStrategy = require('./BaseAuthStrategy');

/**
 * Remote-based authentication
 * @param {object} options - options
 * @param {object} options.store - Remote database store instance
 * @param {string} options.clientId - Client id to distinguish instances if you are using multiple, otherwise keep null if you are using only one instance
 * @param {string} options.dataPath - Change the default path for saving session files, default is: "./.wwebjs_auth/" 
 * @param {number} options.backupSyncIntervalMs - Sets the time interval for periodic session backups. Accepts values starting from 60000ms {1 minute}
 * @param {number} options.rmMaxRetries - Sets the maximum number of retries for removing the session directory
 */
class RemoteAuth extends BaseAuthStrategy {
    constructor({ clientId, dataPath, store, backupSyncIntervalMs, rmMaxRetries } = {}) {
        if (!fs && !unzipper && !archiver) throw new Error('Optional Dependencies [fs-extra, unzipper, archiver] are required to use RemoteAuth. Make sure to run npm install correctly and remove the --no-optional flag');
        super();

        const idRegex = /^[-_\w]+$/i;
        if (clientId && !idRegex.test(clientId)) {
            throw new Error('Invalid clientId. Only alphanumeric characters, underscores and hyphens are allowed.');
        }
        if (!backupSyncIntervalMs || backupSyncIntervalMs < 60000) {
            throw new Error('Invalid backupSyncIntervalMs. Accepts values starting from 60000ms {1 minute}.');
        }
        if (!store) throw new Error('Remote database store is required.');

        this.store = store;
        this.clientId = clientId;
        this.backupSyncIntervalMs = backupSyncIntervalMs;
        this.dataPath = path.resolve(dataPath || './.wwebjs_auth/');
        this.tempDir = `${this.dataPath}/wwebjs_temp_session_${this.clientId}`;
        this.requiredDirs = ['Default', 'IndexedDB', 'Local Storage']; /* => Required Files & Dirs in WWebJS to restore session */
        this.rmMaxRetries = rmMaxRetries != null ? rmMaxRetries : 4;
    }

    async beforeBrowserInitialized() {
        const puppeteerOpts = this.client.options.puppeteer;
        const sessionDirName = this.clientId ? `RemoteAuth-${this.clientId}` : 'RemoteAuth';
        const dirPath = path.join(this.dataPath, sessionDirName);

        if (puppeteerOpts.userDataDir && puppeteerOpts.userDataDir !== dirPath) {
            throw new Error('RemoteAuth is not compatible with a user-supplied userDataDir.');
        }

        this.userDataDir = dirPath;
        this.sessionName = sessionDirName;

        console.log(`[RemoteAuth] ${this.sessionName}: beforeBrowserInitialized - extracting session...`);
        await this.extractRemoteSession();

        this.client.options.puppeteer = {
            ...puppeteerOpts,
            userDataDir: dirPath
        };
    }

    async onAuthenticationNeeded() {
        const sessionExists = await this.store.sessionExists({ session: this.sessionName });
        const restoredSource = this.extractedSessionSource || (sessionExists ? 'remote' : 'empty');

        if (restoredSource === 'remote' || restoredSource === 'local' || sessionExists) {
            /* Se o WhatsApp chegou no estado "precisa autenticar", não podemos
             * bloquear o fluxo de QR aqui. Antes estávamos tratando isso como
             * auth_failure e entrando em loop sem exibir o QR. */
            console.log(`[RemoteAuth] ${this.sessionName}: Existing auth data was rejected by WhatsApp (source=${restoredSource}, db=${sessionExists}). Falling back to QR flow.`);
        } else {
            console.log(`[RemoteAuth] ${this.sessionName}: No valid auth data restored at startup - fresh QR code needed`);
        }

        return { failed: false, restart: false, failureEventPayload: undefined };
    }

    async logout() {
        /* Logout = explicit user action, DELETE session from remote store */
        await this.deleteRemoteSession();

        let pathExists = await this.isValidPath(this.userDataDir);
        if (pathExists) {
            await fs.promises.rm(this.userDataDir, {
                recursive: true,
                force: true,
                maxRetries: this.rmMaxRetries,
            }).catch(() => {});
        }
        clearInterval(this.backupSync);
    }

    async destroy() {
        clearInterval(this.backupSync);
    }

    async disconnect(reason) {
        /* 
         * IMPORTANT: disconnect() is called on ANY connection loss (network, conflict, etc.)
         * We must NOT delete the remote session here, only on explicit logout().
         * This preserves the session in MySQL so we can restore it on reconnect
         * without requiring a new QR code scan.
         * 
         * NOTE: We do NOT save during disconnect because:
         * - On Windows, Chromium locks user data files while running
         * - Saving locked/partial files would corrupt the MySQL backup
         * - The periodic backup (backupSyncIntervalMs) keeps MySQL up to date
         */

        clearInterval(this.backupSync);

        console.log(`[RemoteAuth] ${this.sessionName}: disconnect called (reason=${reason || 'unknown'})`);
        console.log(`[RemoteAuth] ${this.sessionName}: keeping local session directory as fallback until next startup`);

        // Limpar apenas artefatos temporários; a pasta principal da sessão fica preservada
        // para evitar perda de autenticação caso o backup remoto ainda não exista.
        await fs.promises.rm(`${this.tempDir}`, {
            recursive: true,
            force: true,
            maxRetries: this.rmMaxRetries,
        }).catch(() => {});

        await fs.promises.unlink(`${this.sessionName}.zip`).catch(() => {});
    }

    async afterAuthReady() {
        console.log(`[RemoteAuth] ${this.sessionName}: >>> afterAuthReady CALLED <<<`);
        if (this._afterAuthReadyRunning) {
            console.log(`[RemoteAuth] ${this.sessionName}: afterAuthReady already running, skipping duplicate call`);
            return;
        }
        this._afterAuthReadyRunning = true;
        try {
            console.log(`[RemoteAuth] ${this.sessionName}: store type = ${this.store ? this.store.constructor.name : 'NULL'}`);
            const sessionExists = await this.store.sessionExists({ session: this.sessionName });
            console.log(`[RemoteAuth] ${this.sessionName}: afterAuthReady - sessionExists=${sessionExists}`);
            if (!sessionExists) {
                console.log(`[RemoteAuth] ${this.sessionName}: First save - waiting 20s for session to stabilize...`);
                await this.delay(20000);
                console.log(`[RemoteAuth] ${this.sessionName}: 20s delay done, calling storeRemoteSession...`);
                await this.storeRemoteSession({ emit: true });
                console.log(`[RemoteAuth] ${this.sessionName}: First save completed!`);
            } else {
                console.log(`[RemoteAuth] ${this.sessionName}: Session exists - updating in 10s...`);
                await this.delay(10000);
                await this.storeRemoteSession({ emit: true });
                console.log(`[RemoteAuth] ${this.sessionName}: Session updated!`);
            }
            if (this.backupSync) {
                clearInterval(this.backupSync);
            }
            var self = this;
            this.backupSync = setInterval(async function() {
                try {
                    await self.storeRemoteSession();
                } catch (backupErr) {
                    console.error(`[RemoteAuth] ${self.sessionName}: Backup sync error:`, backupErr.message);
                }
            }, this.backupSyncIntervalMs);
            console.log(`[RemoteAuth] ${this.sessionName}: Backup interval started (every ${this.backupSyncIntervalMs/1000}s)`);
        } catch (err) {
            console.error(`[RemoteAuth] ${this.sessionName}: afterAuthReady FATAL ERROR:`, err.message, err.stack);
        } finally {
            this._afterAuthReadyRunning = false;
        }
    }

    async storeRemoteSession(options) {
        /* Compress & Store Session */
        console.log(`[RemoteAuth] ${this.sessionName}: storeRemoteSession START - checking userDataDir: ${this.userDataDir}`);
        const pathExists = await this.isValidPath(this.userDataDir);
        if (pathExists) {
            console.log(`[RemoteAuth] ${this.sessionName}: userDataDir EXISTS - compressing...`);
            await this.compressSession();
            const zipPath = `${this.sessionName}.zip`;
            const zipExists = await this.isValidPath(zipPath);
            console.log(`[RemoteAuth] ${this.sessionName}: compression done - zip exists at '${zipPath}': ${zipExists}`);
            if (!zipExists) {
                console.error(`[RemoteAuth] ${this.sessionName}: ZIP FILE NOT FOUND after compression! CWD=${process.cwd()}`);
                return;
            }

            /* GUARD: Never save empty/unauthenticated sessions to MySQL.
             * A valid WhatsApp session is typically 1-3MB compressed.
             * An empty Chrome profile is only ~0.10MB.
             * Saving empty data would overwrite a valid session and cause QR loop. */
            const MIN_SESSION_SIZE_BYTES = 500 * 1024; // 0.5MB minimum
            try {
                const zipStats = await fs.promises.stat(zipPath);
                const sizeMB = (zipStats.size / (1024 * 1024)).toFixed(2);
                if (zipStats.size < MIN_SESSION_SIZE_BYTES) {
                    console.log(`[RemoteAuth] ${this.sessionName}: ⚠️ SKIPPING save - session too small (${sizeMB}MB < 0.5MB) - likely empty/unauthenticated`);
                    await fs.promises.unlink(zipPath).catch(() => {});
                    return;
                }
                console.log(`[RemoteAuth] ${this.sessionName}: Session size OK (${sizeMB}MB) - saving...`);
            } catch (statErr) {
                console.error(`[RemoteAuth] ${this.sessionName}: Cannot stat zip: ${statErr.message}`);
                return;
            }

            console.log(`[RemoteAuth] ${this.sessionName}: calling store.save()...`);
            await this.store.save({ session: this.sessionName });
            console.log(`[RemoteAuth] ${this.sessionName}: store.save() completed! Cleaning up...`);
            await fs.promises.unlink(zipPath).catch(e => console.error(`[RemoteAuth] unlink error: ${e.message}`));
            await fs.promises.rm(`${this.tempDir}`, {
                recursive: true,
                force: true,
                maxRetries: this.rmMaxRetries,
            }).catch(() => {});
            if (options && options.emit) this.client.emit(Events.REMOTE_SESSION_SAVED);
            console.log(`[RemoteAuth] ${this.sessionName}: storeRemoteSession COMPLETE`);
        } else {
            console.log(`[RemoteAuth] ${this.sessionName}: storeRemoteSession SKIPPED - userDataDir NOT FOUND: ${this.userDataDir}`);
        }
    }

    async extractRemoteSession() {
        const pathExists = await this.isValidPath(this.userDataDir);
        const compressedSessionPath = `${this.sessionName}.zip`;
        const sessionExists = await this.store.sessionExists({ session: this.sessionName });
        const localSessionLooksValid = pathExists ? await this.hasRequiredLocalSession() : false;

        console.log(`[RemoteAuth] ${this.sessionName}: extractRemoteSession - localExists=${pathExists}, localValid=${localSessionLooksValid}, dbExists=${sessionExists}`);

        /* Prioridade para o fallback local quando ele parece íntegro.
         * Na prática, ele costuma ser mais recente do que o backup remoto
         * (janela de sync) e evita perder uma sessão válida por causa de um
         * snapshot antigo/corrompido no MySQL. O banco continua como backup
         * para cold start, migração ou perda do disco local. */
        if (localSessionLooksValid) {
            this.extractedSessionSource = 'local';
            if (sessionExists) {
                console.log(`[RemoteAuth] ${this.sessionName}: Valid local session and MySQL backup found - preferring local session, keeping MySQL as fallback`);
            } else {
                console.log(`[RemoteAuth] ${this.sessionName}: No session in MySQL, but valid local session exists - reusing local fallback`);
            }
        } else if (sessionExists) {
            this.extractedSessionSource = 'remote';
            if (pathExists) {
                await fs.promises.rm(this.userDataDir, {
                    recursive: true,
                    force: true,
                    maxRetries: this.rmMaxRetries,
                }).catch(() => {});
            }

            console.log(`[RemoteAuth] ${this.sessionName}: Restoring session from MySQL...`);
            await this.store.extract({ session: this.sessionName, path: compressedSessionPath });
            await this.unCompressSession(compressedSessionPath);
            console.log(`[RemoteAuth] ${this.sessionName}: Session restored successfully from MySQL`);
        } else {
            this.extractedSessionSource = 'empty';
            if (pathExists) {
                console.log(`[RemoteAuth] ${this.sessionName}: Local session exists but looks incomplete - resetting local directory`);
                await fs.promises.rm(this.userDataDir, {
                    recursive: true,
                    force: true,
                    maxRetries: this.rmMaxRetries,
                }).catch(() => {});
            }

            console.log(`[RemoteAuth] ${this.sessionName}: No session in MySQL - creating empty dir (will need QR code)`);
            fs.mkdirSync(this.userDataDir, { recursive: true });
        }
    }

    async hasRequiredLocalSession(dirPath = this.userDataDir) {
        try {
            const defaultDir = path.join(dirPath, 'Default');
            await fs.promises.access(defaultDir);

            const rootIndexedDb = path.join(dirPath, 'IndexedDB');
            const rootLocalStorage = path.join(dirPath, 'Local Storage');
            const defaultIndexedDb = path.join(defaultDir, 'IndexedDB');
            const defaultLocalStorage = path.join(defaultDir, 'Local Storage');

            const rootWhatsAppMarkers = [
                path.join(rootIndexedDb, 'https_web.whatsapp.com_0.indexeddb.leveldb'),
                path.join(rootIndexedDb, 'https_web.whatsapp.com_0.indexeddb.blob')
            ];
            const defaultWhatsAppMarkers = [
                path.join(defaultIndexedDb, 'https_web.whatsapp.com_0.indexeddb.leveldb'),
                path.join(defaultIndexedDb, 'https_web.whatsapp.com_0.indexeddb.blob')
            ];

            const hasAnyPath = async(paths) => {
                try {
                    for (const candidate of paths) {
                        try {
                            await fs.promises.access(candidate);
                            return candidate;
                        } catch {}
                    }
                    return null;
                } catch {
                    return null;
                }
            };

            const rootMarker = await hasAnyPath(rootWhatsAppMarkers);
            const defaultMarker = await hasAnyPath(defaultWhatsAppMarkers);

            if (rootMarker) {
                await fs.promises.access(rootLocalStorage);
                console.log(`[RemoteAuth] ${this.sessionName}: local session validation OK using root WhatsApp marker ${path.basename(rootMarker)}`);
                return true;
            }

            if (defaultMarker) {
                await fs.promises.access(defaultLocalStorage);
                console.log(`[RemoteAuth] ${this.sessionName}: local session validation OK using Default WhatsApp marker ${path.basename(defaultMarker)}`);
                return true;
            }

            console.log(`[RemoteAuth] ${this.sessionName}: local session validation FAILED - Chromium profile exists, but WhatsApp auth markers were not found`);
            return false;
        } catch {
            return false;
        }
    }

    async deleteRemoteSession() {
        const sessionExists = await this.store.sessionExists({ session: this.sessionName });
        if (sessionExists) await this.store.delete({ session: this.sessionName });
    }

    async compressSession() {
        const archive = archiver('zip');
        const stream = fs.createWriteStream(`${this.sessionName}.zip`);

        await fs.copy(this.userDataDir, this.tempDir).catch(() => {});
        await this.deleteMetadata();
        return new Promise((resolve, reject) => {
            archive
                .directory(this.tempDir, false)
                .on('error', err => reject(err))
                .pipe(stream);

            stream.on('close', () => resolve());
            archive.finalize();
        });
    }

    async unCompressSession(compressedSessionPath) {
        var stream = fs.createReadStream(compressedSessionPath);
        await new Promise((resolve, reject) => {
            stream.pipe(unzipper.Extract({
                    path: this.userDataDir
                }))
                .on('error', err => reject(err))
                .on('finish', () => resolve());
        });
        await fs.promises.unlink(compressedSessionPath);
    }

    async deleteMetadata() {
        const sessionDirs = [this.tempDir, path.join(this.tempDir, 'Default')];
        for (const dir of sessionDirs) {
            const sessionFiles = await fs.promises.readdir(dir);
            for (const element of sessionFiles) {
                if (!this.requiredDirs.includes(element)) {
                    const dirElement = path.join(dir, element);
                    const stats = await fs.promises.lstat(dirElement);

                    if (stats.isDirectory()) {
                        await fs.promises.rm(dirElement, {
                            recursive: true,
                            force: true,
                            maxRetries: this.rmMaxRetries,
                        }).catch(() => {});
                    } else {
                        await fs.promises.unlink(dirElement).catch(() => {});
                    }
                }
            }
        }
    }

    async isValidPath(path) {
        try {
            await fs.promises.access(path);
            return true;
        } catch {
            return false;
        }
    }

    async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

module.exports = RemoteAuth;
