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
        if (sessionExists) {
            console.log(`[RemoteAuth] ${this.sessionName}: Restored session REJECTED by WhatsApp (UNPAIRED) - deleting stale session from store`);
            await this.store.delete({ session: this.sessionName }).catch(err => {
                console.error(`[RemoteAuth] ${this.sessionName}: Error deleting stale session:`, err.message);
            });
        } else {
            console.log(`[RemoteAuth] ${this.sessionName}: No session in store - fresh QR code needed`);
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

        /* Clean up local files but keep remote session intact in MySQL */
        let localPathExists = await this.isValidPath(this.userDataDir);
        if (localPathExists) {
            await fs.promises.rm(this.userDataDir, {
                recursive: true,
                force: true,
                maxRetries: this.rmMaxRetries,
            }).catch(() => {});
        }
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

        console.log(`[RemoteAuth] ${this.sessionName}: extractRemoteSession - localExists=${pathExists}, dbExists=${sessionExists}`);

        if (pathExists) {
            await fs.promises.rm(this.userDataDir, {
                recursive: true,
                force: true,
                maxRetries: this.rmMaxRetries,
            }).catch(() => {});
        }
        if (sessionExists) {
            console.log(`[RemoteAuth] ${this.sessionName}: Restoring session from MySQL...`);
            await this.store.extract({ session: this.sessionName, path: compressedSessionPath });
            await this.unCompressSession(compressedSessionPath);
            console.log(`[RemoteAuth] ${this.sessionName}: Session restored successfully from MySQL`);
        } else {
            console.log(`[RemoteAuth] ${this.sessionName}: No session in MySQL - creating empty dir (will need QR code)`);
            fs.mkdirSync(this.userDataDir, { recursive: true });
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