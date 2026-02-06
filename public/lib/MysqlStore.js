/**
 * MySQL Store para RemoteAuth do whatsapp-web.js
 * Armazena sessões do WhatsApp no banco de dados MySQL
 * 
 * Interface requerida pelo RemoteAuth:
 * - sessionExists({ session }) - verifica se sessão existe
 * - save({ session }) - salva/atualiza sessão (lê do arquivo .zip)
 * - extract({ session, path }) - extrai sessão para arquivo
 * - delete({ session }) - deleta sessão
 */

const fs = require('fs');
const path = require('path');
const { logger } = require('./logger');

class MysqlStore {
    /**
     * @param {Object} options
     * @param {Object} options.pool - Pool de conexões MySQL (mysql2/promise)
     * @param {Object} options.tableInfo - Informações da tabela
     * @param {string} options.tableInfo.table - Nome da tabela (default: 'wwebjs_sessions')
     * @param {string} options.tableInfo.sessionColumn - Coluna do nome da sessão (default: 'session_name')
     * @param {string} options.tableInfo.dataColumn - Coluna dos dados (default: 'data')
     */
    constructor(options = {}) {
        if (!options.pool) {
            throw new Error('MysqlStore: pool de conexão MySQL é obrigatório');
        }

        this.pool = options.pool;
        this.tableInfo = {
            table: options.tableInfo?.table || 'wwebjs_sessions',
            sessionColumn: options.tableInfo?.sessionColumn || 'session_name',
            dataColumn: options.tableInfo?.dataColumn || 'data'
        };

        // Inicializar tabela
        this._initTable();
    }

    /**
     * Cria a tabela se não existir
     */
    async _initTable() {
        try {
            const createTableSQL = `
                CREATE TABLE IF NOT EXISTS ${this.tableInfo.table} (
                    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
                    ${this.tableInfo.sessionColumn} VARCHAR(255) NOT NULL,
                    ${this.tableInfo.dataColumn} LONGBLOB,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    PRIMARY KEY (id),
                    UNIQUE KEY session_unique (${this.tableInfo.sessionColumn})
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `;
            
            await this.pool.execute(createTableSQL);
            logger.info(null, `MysqlStore: Tabela "${this.tableInfo.table}" verificada/criada`);
        } catch (error) {
            logger.error(null, `MysqlStore: Erro ao criar tabela: ${error.message}`);
        }
    }

    /**
     * Verifica se uma sessão existe no banco
     * @param {Object} options
     * @param {string} options.session - Nome da sessão
     * @returns {Promise<boolean>}
     */
    async sessionExists({ session }) {
        try {
            const [rows] = await this.pool.execute(
                `SELECT COUNT(*) as count FROM ${this.tableInfo.table} WHERE ${this.tableInfo.sessionColumn} = ?`,
                [session]
            );
            const exists = rows[0].count > 0;
            logger.session(session, `MysqlStore: sessionExists = ${exists}`);
            return exists;
        } catch (error) {
            logger.error(session, `MysqlStore: Erro ao verificar sessão: ${error.message}`);
            return false;
        }
    }

    /**
     * Salva a sessão no banco de dados
     * Lê o arquivo .zip criado pelo RemoteAuth e armazena como BLOB
     * @param {Object} options
     * @param {string} options.session - Nome da sessão (também é o nome do arquivo .zip)
     */
    async save({ session }) {
        try {
            const zipPath = `${session}.zip`;
            
            // Verificar se o arquivo existe
            if (!fs.existsSync(zipPath)) {
                logger.error(session, `MysqlStore: Arquivo ${zipPath} não encontrado para salvar`);
                return;
            }

            // Ler o arquivo como buffer
            const data = fs.readFileSync(zipPath);
            const dataSize = (data.length / 1024 / 1024).toFixed(2);
            
            logger.session(session, `MysqlStore: Salvando sessão (${dataSize} MB)...`);

            // Upsert: INSERT ou UPDATE se já existir
            const sql = `
                INSERT INTO ${this.tableInfo.table} (${this.tableInfo.sessionColumn}, ${this.tableInfo.dataColumn})
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE ${this.tableInfo.dataColumn} = VALUES(${this.tableInfo.dataColumn}), updated_at = NOW()
            `;

            await this.pool.execute(sql, [session, data]);
            logger.session(session, `MysqlStore: Sessão salva com sucesso no banco de dados`);
        } catch (error) {
            logger.error(session, `MysqlStore: Erro ao salvar sessão: ${error.message}`);
            throw error;
        }
    }

    /**
     * Extrai a sessão do banco de dados para um arquivo .zip
     * @param {Object} options
     * @param {string} options.session - Nome da sessão
     * @param {string} options.path - Caminho onde salvar o arquivo .zip
     */
    async extract({ session, path: outputPath }) {
        try {
            logger.session(session, `MysqlStore: Extraindo sessão do banco...`);

            const [rows] = await this.pool.execute(
                `SELECT ${this.tableInfo.dataColumn} FROM ${this.tableInfo.table} WHERE ${this.tableInfo.sessionColumn} = ?`,
                [session]
            );

            if (rows.length === 0 || !rows[0][this.tableInfo.dataColumn]) {
                logger.warn(session, `MysqlStore: Sessão não encontrada no banco`);
                return;
            }

            const data = rows[0][this.tableInfo.dataColumn];
            const dataSize = (data.length / 1024 / 1024).toFixed(2);

            // Escrever o buffer no arquivo
            fs.writeFileSync(outputPath, data);
            
            logger.session(session, `MysqlStore: Sessão extraída com sucesso (${dataSize} MB) para ${outputPath}`);
        } catch (error) {
            logger.error(session, `MysqlStore: Erro ao extrair sessão: ${error.message}`);
            throw error;
        }
    }

    /**
     * Deleta uma sessão do banco de dados
     * @param {Object} options
     * @param {string} options.session - Nome da sessão
     */
    async delete({ session }) {
        try {
            logger.session(session, `MysqlStore: Deletando sessão do banco...`);

            const [result] = await this.pool.execute(
                `DELETE FROM ${this.tableInfo.table} WHERE ${this.tableInfo.sessionColumn} = ?`,
                [session]
            );

            if (result.affectedRows > 0) {
                logger.session(session, `MysqlStore: Sessão deletada com sucesso`);
            } else {
                logger.warn(session, `MysqlStore: Sessão não encontrada para deletar`);
            }
        } catch (error) {
            logger.error(session, `MysqlStore: Erro ao deletar sessão: ${error.message}`);
            throw error;
        }
    }

    /**
     * Lista todas as sessões salvas
     * @returns {Promise<Array>}
     */
    async listSessions() {
        try {
            const [rows] = await this.pool.execute(
                `SELECT ${this.tableInfo.sessionColumn}, created_at, updated_at, 
                        LENGTH(${this.tableInfo.dataColumn}) as data_size 
                 FROM ${this.tableInfo.table}`
            );
            return rows.map(row => ({
                session: row[this.tableInfo.sessionColumn],
                createdAt: row.created_at,
                updatedAt: row.updated_at,
                sizeBytes: row.data_size,
                sizeMB: (row.data_size / 1024 / 1024).toFixed(2)
            }));
        } catch (error) {
            logger.error(null, `MysqlStore: Erro ao listar sessões: ${error.message}`);
            return [];
        }
    }

    /**
     * Limpa sessões antigas (mais de X dias sem atualização)
     * @param {number} days - Número de dias
     */
    async cleanOldSessions(days = 30) {
        try {
            const [result] = await this.pool.execute(
                `DELETE FROM ${this.tableInfo.table} WHERE updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)`,
                [days]
            );
            
            if (result.affectedRows > 0) {
                logger.info(null, `MysqlStore: ${result.affectedRows} sessões antigas removidas`);
            }
            
            return result.affectedRows;
        } catch (error) {
            logger.error(null, `MysqlStore: Erro ao limpar sessões antigas: ${error.message}`);
            return 0;
        }
    }
}

module.exports = { MysqlStore };
